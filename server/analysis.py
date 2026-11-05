"""Read-only animation checks. Independently implemented RGB/alpha/edge comparisons."""
from __future__ import annotations

import uuid

import numpy as np
from PIL import Image

from . import imaging, storage as store


def features(image, longest=96):
    image = imaging.resize_rgba(image.convert("RGBA"), imaging.fit_size(image.size, longest))
    a = np.asarray(image, dtype=np.float32) / 255
    rgb = a[..., :3] * a[..., 3:4]
    gray = rgb @ np.array([.299, .587, .114], np.float32)
    gx = np.abs(np.diff(gray, axis=1, prepend=gray[:, :1]))
    gy = np.abs(np.diff(gray, axis=0, prepend=gray[:1]))
    return np.concatenate((rgb, a[..., 3:4], gx[..., None], gy[..., None]), axis=-1)


def distances(a, b):
    """0–100 descriptive distance; hidden RGB is ignored, position is preserved."""
    visible = np.maximum(a[..., 3], b[..., 3])
    weight = (visible > .01).astype(np.float32)
    denom = np.maximum(1, weight.sum(axis=(-2, -1)))
    color = (np.abs(a[..., :3] - b[..., :3]).mean(axis=-1) * weight).sum(axis=(-2, -1)) / denom
    alpha = np.abs(a[..., 3] - b[..., 3]).sum(axis=(-2, -1)) / denom
    edges = (np.abs(a[..., 4:] - b[..., 4:]).mean(axis=-1) * weight).sum(axis=(-2, -1)) / denom
    return np.clip(100 * (.55 * color + .30 * alpha + .15 * edges), 0, 100)


def frame_path(project, index, source):
    fr = project["frames"][index]
    return store.project_dir(project["id"]) / (fr.get("output") if source == "result" and fr.get("output")
                                              else fr["original"])


def verify_duplicate(project, first, second, source, threshold):
    one, two = frame_path(project, first, source), frame_path(project, second, source)
    if one == two:
        return 0.0
    # Verify shortlisted pairs at a higher resolution so small details are less easily lost.
    with Image.open(one) as a, Image.open(two) as b:
        if a.size != b.size:
            return 100.0
        return float(distances(features(a, min(512, max(a.size))), features(b, min(512, max(b.size)))))


def check(project, request, progress, cancel):
    report = dict(id=uuid.uuid4().hex[:16], project_id=project["id"], revision=project["revision"],
                  source=request.source, scope=request.scope, duplicates=[], suspects=[],
                  transitions=[], loops=[], stats=[], warnings=[],
                  params=request.model_dump(exclude={"expected_revision"}))
    actions = [a for a in project["actions"] if request.scope == "all" or a["id"] == request.action_id]
    if not actions:
        raise ValueError("请选择一个有效动作")
    if request.min_period > request.max_period:
        raise ValueError("最小周期不能大于最大周期")
    if request.source == "result" and any(not f.get("output") for f in project["frames"] if f["enabled"]):
        report["warnings"].append("部分帧尚未处理，本次使用其原始帧；应用处理后请重新检查。")
    total = sum(a["end"]-a["start"]+1 for a in actions)
    done = 0
    for action in actions:
        indices = [i for i in range(action["start"], action["end"]+1) if project["frames"][i]["enabled"]]
        if len(indices) < 2:
            continue
        detail, coarse = [], []
        for index in indices:
            if cancel():
                raise InterruptedError("已取消检查")
            with Image.open(frame_path(project, index, request.source)) as image:
                detail.append(features(image))
                coarse.append(features(image, 32))
            done += 1
            progress(.05 + .4 * done/max(1, total), f"正在检查 {action['name']} · 第 {index+1} 帧")
        stack = np.stack(detail)
        if float(stack[..., 3].mean()) > .98 and not any("背景会参与" in w for w in report["warnings"]):
            report["warnings"].append("不透明背景会参与比较；主体较小时建议先抠图，再检查处理结果。")
        diffs = distances(stack[1:], stack[:-1]).astype(np.float64)
        times = np.array([project["frames"][i]["duration"] for i in indices[:-1]], np.float64)
        # Adjust the jump statistic for uneven frame intervals; duplicate likeness stays visual.
        rate = diffs * np.median(times) / np.maximum(times, .001)
        med = float(np.median(rate))
        mad = float(np.median(np.abs(rate-med)))
        sigma = 1.4826 * mad if mad > 1e-6 else max(.1, med * .05)
        threshold = max(request.jump_floor, med + request.jump_k * sigma)
        report["stats"].append(dict(action_id=action["id"], name=action["name"], frames=len(indices),
                                    median=round(med, 3), threshold=round(threshold, 3),
                                    timing_normalized=bool(np.ptp(times) > 1e-6)))
        if len(indices) < 5:
            report["warnings"].append(f"{action['name']} 少于 5 个启用帧，跳变统计仅供参考。")

        # Consecutive runs compare to a fixed representative, never an accumulating chain.
        runs, run = [], [0]
        for pos in range(1, len(indices)):
            distance = float(distances(stack[pos], stack[run[0]]))
            if distance <= request.duplicate_threshold and verify_duplicate(
                    project, indices[run[0]], indices[pos], request.source,
                    request.duplicate_threshold) <= request.duplicate_threshold:
                run.append(pos)
            else:
                if len(run) > 1:
                    runs.append(run)
                run = [pos]
        if len(run) > 1:
            runs.append(run)
        within_run = set()
        for run in runs:
            ids = [indices[p] for p in run]
            within_run.update(run)
            report["duplicates"].append(dict(id=f"dup-{indices[run[0]]}", kind="consecutive",
                action_id=action["id"], action_name=action["name"], indices=ids, keep=ids[0],
                duration=sum(project["frames"][i]["duration"] for i in ids),
                score=round(max(float(distances(stack[p], stack[run[0]])) for p in run), 3)))

        # Nearby posture returns are shown, but cannot be automatically compressed.
        for pos in range(1, len(indices)):
            if cancel():
                raise InterruptedError("已取消检查")
            if pos in within_run:
                continue
            previous = range(max(0, pos-request.window), pos-1)
            best = min(previous, key=lambda j: float(distances(stack[pos], stack[j])), default=None)
            if best is not None:
                distance = float(distances(stack[pos], stack[best]))
                if distance <= request.duplicate_threshold and verify_duplicate(
                        project, indices[best], indices[pos], request.source,
                        request.duplicate_threshold) <= request.duplicate_threshold:
                    report["duplicates"].append(dict(id=f"return-{indices[pos]}", kind="return",
                        action_id=action["id"], action_name=action["name"], keep=indices[best],
                        indices=[indices[best], indices[pos]], score=round(distance, 3),
                        duration=0))

        over = rate > threshold
        suspect_positions = {pos for pos in range(1, len(indices)-1) if over[pos-1] and over[pos]}
        for pos in sorted(suspect_positions):
            index = indices[pos]
            outer = float(distances(stack[pos-1], stack[pos+1]))
            report["suspects"].append(dict(id=f"jump-{index}", frame_id=project["frames"][index]["id"],
                index=index, previous=indices[pos-1], next=indices[pos+1], action_name=action["name"],
                left=round(float(diffs[pos-1]), 3), right=round(float(diffs[pos]), 3),
                outer=round(outer, 3), threshold=round(threshold, 3),
                reason="前后两帧接近，中间帧明显偏离" if outer < min(diffs[pos-1], diffs[pos])*.6
                       else "两侧变化均异常大；也可能是快速动作"))
        for pos, value in enumerate(diffs):
            if over[pos]:
                report["transitions"].append(dict(previous=indices[pos], next=indices[pos+1],
                    diff=round(float(value), 3), rate=round(float(rate[pos]), 3),
                    kind="suspect_edge" if pos in suspect_positions or pos+1 in suspect_positions else "boundary",
                    action_name=action["name"]))
        if len(indices) >= 2*request.min_period:
            report["loops"].extend(find_loops(project, action, indices, np.stack(coarse), request, cancel, stack))
        progress(.9, f"已完成 {action['name']} 的检查")
    if not report["stats"]:
        report["warnings"].append("没有包含至少两个启用帧的动作可供检查。")
    if not report["loops"]:
        report["warnings"].append("未找到有重复周期证据的循环候选；静止片段不会强行认定为循环。")
    progress(1, "检查完成，等待你选择")
    return report


def find_loops(project, action, indices, stack, request, cancel, detail=None):
    n = len(indices)
    maximum = min(request.max_period, n//2)
    changes = distances(stack[1:], stack[:-1])
    moving = changes[changes > .2]
    adjacent = float(np.median(moving)) if len(moving) else 0
    if adjacent <= .2:
        return []
    errors = {}
    for period in range(1, maximum+2):
        if cancel():
            raise InterruptedError("已取消检查")
        if period >= n:
            break
        errors[period] = distances(stack[period:], stack[:-period])
    accepted = []
    for period in range(request.min_period, maximum+1):
        error = errors[period]
        mean = float(error.mean())
        support = float((error <= request.loop_max_error).mean())
        neighbors = [float(errors[p].mean()) for p in (period-1, period+1) if p in errors]
        if (mean > request.loop_max_error or support < .8 or mean >= adjacent*.6
                or float(np.percentile(error, 90)) > request.loop_max_error*2
                or not neighbors or min(neighbors) <= mean*1.3 + .1):
            continue
        if any(period % p == 0 for p, _ in accepted):
            continue
        accepted.append((period, error))
    result = []
    for period, error in sorted(accepted, key=lambda pair: float(pair[1].mean()))[:3]:
        if detail is not None:
            error = distances(detail[period:], detail[:-period])
            if float(error.mean()) > request.loop_max_error or float((error <= request.loop_max_error).mean()) < .8:
                continue
        # A preview cycle is backed by at least one whole corresponding repeated cycle.
        starts = range(0, n-2*period+1)
        start = min(starts, key=lambda j: float(error[j:j+period].mean()))
        end = start+period-1
        score = float(error[start:start+period].mean())
        result.append(dict(id=f"loop-{action['id']}-{period}", action_id=action["id"],
            action_name=action["name"], period=period, start=indices[start], end=indices[end],
            indices=indices[start:end+1], repeat_start=indices[start+period],
            mean_error=round(score, 3), support=round(float((error <= request.loop_max_error).mean()), 3),
            duration=sum(project["frames"][i]["duration"] for i in indices[start:end+1]),
            fps=action["fps"]))
    return result
