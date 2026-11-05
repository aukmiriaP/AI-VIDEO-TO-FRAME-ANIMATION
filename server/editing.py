"""Sequence edits with stable frame identities, action boundaries and local cache updates."""
from __future__ import annotations

import copy
import math
import uuid

from . import imaging, pipeline, storage as store


def check_revision(project, expected):
    if expected != project["revision"]:
        raise ValueError("项目已发生修改，请刷新项目并重新检查或操作。")


def checked_indices(project, indices):
    ids = sorted(set(indices))
    if not ids or any(i < 0 or i >= len(project["frames"]) for i in ids):
        raise ValueError("请选择有效的帧范围")
    return ids


def owner(project, index):
    return next((a["id"] for a in project["actions"] if a["start"] <= index <= a["end"]), None)


def base_signature(project, index):
    fr = project["frames"][index]
    settings = pipeline.frame_settings(project, index)
    return imaging.fingerprint(fr["source_hash"], fr.get("override_hash"), settings.model_dump(exclude={"colors","palette_mode","custom_palette"}),
                               fr["strokes"], project.get("asset_options", {}))


def dependency_signatures(project):
    bases = [base_signature(project, i) for i in range(len(project["frames"]))]
    return {
        fr["id"]: (bases[i], tuple(bases[j] for j in pipeline.neighbor_ids(project, i)))
        for i, fr in enumerate(project["frames"])
        if pipeline.frame_settings(project, i).stabilize
    }


def update_dependents(before, project):
    """Recompute only existing temporal outputs whose input dependencies changed."""
    old = dependency_signatures(before)
    new = dependency_signatures(project)
    affected = [i for i, fr in enumerate(project["frames"])
                if fr["output"] and fr["id"] in new and old.get(fr["id"]) != new[fr["id"]]]
    renderer = pipeline.Renderer(project)
    if affected:
        renderer.palette()
    for i in affected:
        output, thumb = renderer.output(i)
        project["frames"][i].update(output=output, thumb=thumb)
    project["last_run"] = dict(affected=affected, processed=len(affected),
                               base_computed=renderer.rendered, base_cached=renderer.cached)


def remap_actions(project, membership):
    result = []
    for action in project["actions"]:
        ids = [i for i, fr in enumerate(project["frames"]) if membership[fr["id"]] == action["id"]]
        if ids:
            if ids != list(range(ids[0], ids[-1] + 1)):
                raise ValueError("排序不能拆散动作；请在同一个动作内移动，或先重新划分动作。")
            result.append(action | {"start": ids[0], "end": ids[-1]})
    project["actions"] = sorted(result, key=lambda a: a["start"])


def remove_frames(project, indices):
    remove = set(indices)
    if len(remove) >= len(project["frames"]):
        raise ValueError("请至少保留一帧")
    membership = {fr["id"]: owner(project, i) for i, fr in enumerate(project["frames"])}
    project["frames"] = [fr for i, fr in enumerate(project["frames"]) if i not in remove]
    remap_actions(project, membership)


def finish(before, project, selected_ids=None):
    update_dependents(before, project)
    store.write(project)
    return store.public(project) | {"edit_result": {
        "selected_ids": selected_ids or [],
        "updated_frames": project["last_run"]["processed"],
    }}


def edit(pid, request):
    project = store.read(pid)
    check_revision(project, request.expected_revision)
    before = copy.deepcopy(project)
    n = len(project["frames"])
    if not n or project.get("import_status") != "ready":
        raise ValueError("请等待素材导入完成")
    selected_ids = []
    operation = request.operation
    if operation == "order":
        order = request.order or []
        if len(order) != n or sorted(order) != list(range(n)):
            raise ValueError("排序必须包含全部帧且不能重复")
        if any(owner(project, i) != owner(project, j) for i, j in enumerate(order)):
            raise ValueError("请在同一个动作内排序；跨动作移动前请先重新划分动作。")
        if order == list(range(n)):
            return store.public(project)
        project["frames"] = [project["frames"][i] for i in order]
    else:
        indices = checked_indices(project, request.indices)
        selected_ids = [project["frames"][i]["id"] for i in indices]
        if operation in ("reverse", "duplicate"):
            if len({owner(project, i) for i in indices}) != 1:
                raise ValueError("请先选中同一个动作内的帧")
            if operation == "reverse":
                if len(indices) < 2:
                    raise ValueError("倒序至少需要两帧")
                reverse = [project["frames"][i] for i in reversed(indices)]
                for i, fr in zip(indices, reverse):
                    project["frames"][i] = fr
            else:
                if n + len(indices) > pipeline.MAX_FRAMES:
                    raise ValueError("复制后会超过 480 帧上限")
                membership = {fr["id"]: owner(project, i) for i, fr in enumerate(project["frames"])}
                copies = [copy.deepcopy(project["frames"][i]) for i in indices]
                for fr in copies:
                    parent = fr["id"]
                    fr["id"] = uuid.uuid4().hex[:12]
                    fr["copied_from"] = parent
                    membership[fr["id"]] = membership[parent]
                project["frames"][indices[-1]+1:indices[-1]+1] = copies
                selected_ids = [fr["id"] for fr in copies]
                remap_actions(project, membership)
        elif operation == "delete":
            remove_frames(project, indices)
            selected_ids = []
        elif operation == "duration":
            value = request.duration
            if value is None or not math.isfinite(value) or not .001 <= value <= 60:
                raise ValueError("帧时长必须在 1–60000 毫秒之间")
            for i in indices:
                project["frames"][i]["duration"] = value
        else:
            raise ValueError("未知编辑操作")
    store.checkpoint(before)
    project["history"] = before["history"]
    return finish(before, project, selected_ids)


def apply_report(pid, report, request):
    project = store.read(pid)
    check_revision(project, request.expected_revision)
    if report["project_id"] != pid or report["revision"] != project["revision"]:
        raise ValueError("检查结果已过期，请重新运行检查。")
    before = copy.deepcopy(project)
    chosen = set(request.candidate_ids)
    if not chosen:
        raise ValueError("请先选择检查候选")
    selected_ids = []
    if request.operation == "compress":
        groups = [g for g in report["duplicates"] if g["id"] in chosen]
        if len(groups) != len(chosen) or any(g["kind"] != "consecutive" for g in groups):
            raise ValueError("只能合并本次检查的连续重复帧")
        drops = []
        for group in groups:
            ids = group["indices"]
            # Conservation applies within the same action, hence the same playback speed.
            keep = ids[0]
            project["frames"][keep]["duration"] = sum(project["frames"][i]["duration"] for i in ids)
            drops.extend(ids[1:])
            selected_ids.append(project["frames"][keep]["id"])
        remove_frames(project, drops)
    elif request.operation == "skip":
        suspects = [s for s in report["suspects"] if s["id"] in chosen]
        if len(suspects) != len(chosen):
            raise ValueError("只能跳过本次检查的可疑帧")
        for suspect in suspects:
            project["frames"][suspect["index"]]["enabled"] = False
        if not any(fr["enabled"] for fr in project["frames"]):
            raise ValueError("请至少保留一帧启用帧")
        selected_ids = [s["frame_id"] for s in suspects]
    elif request.operation == "loop":
        loops = [c for c in report["loops"] if c["id"] in chosen]
        if len(loops) != 1 or len(chosen) != 1:
            raise ValueError("请一次选择一个循环候选")
        candidate = loops[0]
        if not request.name or not request.name.strip():
            raise ValueError("请填写动作名称")
        lo, hi = candidate["start"], candidate["end"]
        remaining = []
        for action in project["actions"]:
            if action["end"] < lo or action["start"] > hi:
                remaining.append(action)
            else:
                if action["start"] < lo:
                    remaining.append(action | {"end": lo-1})
                if action["end"] > hi:
                    remaining.append(action | {"id": uuid.uuid4().hex[:8], "start": hi+1})
        used = {a["name"] for a in remaining}
        name = request.name.strip()
        if name in used:
            raise ValueError("动作名称已存在，请使用不同名称")
        # Give fragments unique names even when the candidate is in the middle of an action.
        names = {name}
        for a in remaining:
            base, suffix = a["name"], 2
            while a["name"] in names:
                a["name"] = f"{base}_{suffix}"
                suffix += 1
            names.add(a["name"])
        original = next(a for a in project["actions"] if a["id"] == candidate["action_id"])
        new_action = dict(id=uuid.uuid4().hex[:8], name=name, start=lo, end=hi,
                          fps=original["fps"], loop=True)
        project["actions"] = sorted(remaining + [new_action], key=lambda a: a["start"])
        selected_ids = [fr["id"] for fr in project["frames"][lo:hi+1]]
    else:
        raise ValueError("未知检查结果操作")
    store.checkpoint(before)
    project["history"] = before["history"]
    return finish(before, project, selected_ids)
