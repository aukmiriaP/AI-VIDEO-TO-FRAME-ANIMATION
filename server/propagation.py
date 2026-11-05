"""Local optical-flow transport of saved mask intent; previews never mutate project state."""
from __future__ import annotations

import copy
import hashlib
import uuid

import cv2
import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

from . import editing, imaging, pipeline, storage as store


class PreviewRequest(BaseModel):
    expected_revision: int
    donor_index: int = Field(ge=0)
    donor_frame_id: str
    indices: list[int] = Field(min_length=1, max_length=24)
    confidence: float = Field(default=.6, ge=.3, le=.95, allow_inf_nan=False)


class ApplyRequest(BaseModel):
    expected_revision: int
    report_id: str
    indices: list[int] = Field(min_length=1, max_length=24)


def check_cancel(cancel):
    if cancel():
        raise InterruptedError("已取消遮罩传播，保留上一版结果")


def validate(project, request):
    editing.check_revision(project, request.expected_revision)
    donor = request.donor_index
    if project.get("import_status") != "ready" or donor >= len(project["frames"]):
        raise ValueError("请选择已导入的有效源帧")
    frame = project["frames"][donor]
    if frame["id"] != request.donor_frame_id:
        raise ValueError("源帧已改变，请重新打开传播窗口")
    if not frame["enabled"] or frame.get("output_override"):
        raise ValueError("源帧必须启用且没有成品覆盖")
    if not frame["strokes"]:
        raise ValueError("请先在源帧保存擦除或恢复画笔修订")
    indices = editing.checked_indices(project, request.indices)
    action = editing.owner(project, donor)
    if action is None or any(i == donor or abs(i-donor) > 12 or editing.owner(project, i) != action
                             for i in indices):
        raise ValueError("请选择同一动作内、源帧前后各 12 帧以内的目标；不跨循环首尾")
    return donor, indices


def analysis_image(image, size):
    rgba = np.asarray(image.resize(size, Image.Resampling.BILINEAR), np.float32)
    alpha = rgba[..., 3:4]/255
    # Hidden RGB must not drive tracking.
    return np.uint8(rgba[..., :3]*alpha + 127*(1-alpha))


def transport(previous, current, masks, confidence):
    """Backward pull with forward/backward residual, RGB agreement and texture support."""
    a = cv2.cvtColor(previous, cv2.COLOR_RGB2GRAY)
    b = cv2.cvtColor(current, cv2.COLOR_RGB2GRAY)
    forward = cv2.calcOpticalFlowFarneback(a, b, None, .5, 4, 21, 5, 7, 1.5, 0)
    backward = cv2.calcOpticalFlowFarneback(b, a, None, .5, 4, 21, 5, 7, 1.5, 0)
    h, w = b.shape
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    mx, my = xx+backward[..., 0], yy+backward[..., 1]

    def warp(value):
        return cv2.remap(value, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)

    residual = np.linalg.norm(backward+warp(forward), axis=-1)
    difference = np.mean(np.abs(current.astype(np.float32)-warp(previous.astype(np.float32))), axis=-1)
    gx = cv2.Sobel(a, cv2.CV_32F, 1, 0, ksize=3)/8
    gy = cv2.Sobel(a, cv2.CV_32F, 0, 1, ksize=3)/8
    texture = np.clip(cv2.GaussianBlur(np.hypot(gx, gy), (0, 0), 3)/3, 0, 1)
    inside = (mx >= 0) & (mx <= w-1) & (my >= 0) & (my <= h-1)
    quality = np.exp(-(residual/1.8)**2-(difference/35)**2)*warp(texture)*inside
    return warp(masks), np.clip(warp(confidence)*quality, 0, 1)


def public_report(report):
    return {k: copy.deepcopy(v) for k, v in report.items() if k != "items"} | {
        "items": [{k: v for k, v in item.items() if k != "layer"} for item in report["items"]]}


def preview(pid, request, progress, cancel):
    project = store.read(pid)
    donor, indices = validate(project, request)
    check_cancel(cancel)
    root = store.project_dir(pid)
    frame = project["frames"][donor]
    size = (frame["width"], frame["height"])
    factor = min(1, 640/max(size))
    small = (max(1, round(size[0]*factor)), max(1, round(size[1]*factor)))
    erase, restore = imaging.stroke_masks(size, frame["strokes"])
    initial = np.stack([erase, restore], axis=-1).astype(np.float32)/255
    initial = cv2.resize(initial, small, interpolation=cv2.INTER_AREA)
    source_area = max(1, np.count_nonzero(np.max(initial, axis=-1) >= .5))
    report = dict(id=uuid.uuid4().hex[:16], project_id=pid, revision=project["revision"],
                  donor_index=donor, donor_frame_id=frame["id"], confidence=request.confidence,
                  items=[], warnings=[
                      "仅传播源帧已保存的手动画笔；目标帧手动修订优先。",
                      "红色表示未通过跟踪检查的源图区域，不会应用。建议先试 1–3 帧。",
                      "每张效果图单独预览该目标；勾选多个目标时，帧间颜色稳定可能略有变化。"])

    def load(index):
        with Image.open(root / project["frames"][index]["original"]) as image:
            return analysis_image(image.convert("RGBA"), small)

    completed = 0
    for direction in (-1, 1):
        targets = [i for i in indices if (i-donor)*direction > 0]
        if not targets:
            continue
        previous, masks = load(donor), initial.copy()
        confidence = np.ones(initial.shape[:2], np.float32)
        lost = False
        for index in range(donor+direction, (min(targets) if direction < 0 else max(targets))+direction, direction):
            check_cancel(cancel)
            current = load(index)
            masks, confidence = transport(previous, current, masks, confidence)
            previous = current
            footprint = np.max(masks, axis=-1) >= .5
            good = footprint & (confidence >= request.confidence) & (not lost)
            count = int(np.count_nonzero(good))
            # Once the tracked correction disappears, it must not reappear elsewhere.
            if count < max(2, source_area*.15):
                lost = True
                good[:] = False
                count = 0
            if index not in targets:
                continue
            completed += 1
            progress(completed/len(indices)*.85, f"正在跟踪第 {index+1} 帧并生成预览")
            target = project["frames"][index]
            warnings = []
            blocked = not target["enabled"] or bool(target.get("output_override")) or len(target.get("mask_corrections", [])) >= 8
            if blocked:
                warnings.append("已跳过、成品覆盖或已有 8 层传播修订，无法应用")
            if lost:
                warnings.append("跟踪丢失：请在这一帧重新手动修订，再从这里传播")
            ratio = min(1, count/source_area)
            if ratio < .8:
                warnings.append("部分区域不可靠：遮挡、外观变化、出画或缺少纹理")
            if target["strokes"]:
                warnings.append("目标帧已有手动画笔，这些区域保持手动结果")
            corrected = np.zeros((*initial.shape[:2], 4), np.uint8)
            corrected[..., 3] = 255
            corrected[..., 0] = np.uint8(good & (masks[..., 0] >= masks[..., 1]))*255
            corrected[..., 1] = np.uint8(good & (masks[..., 1] > masks[..., 0]))*255
            image = Image.fromarray(corrected).resize(size, Image.Resampling.NEAREST)
            digest = hashlib.sha256(image.tobytes()).hexdigest()
            relative = f"derived/correction-{report['id']}-{index}.png"
            image.save(root / relative)
            layer = dict(path=relative, hash=digest, donor_frame_id=frame["id"],
                         donor_revision=project["revision"], confidence=request.confidence,
                         accepted_ratio=ratio, at=store.now())
            risk = np.zeros_like(corrected)
            risk[footprint & ~good] = [240, 82, 72, 210]
            risk_relative = f"derived/risk-{report['id']}-{index}.png"
            Image.fromarray(risk).resize(size, Image.Resampling.NEAREST).save(root / risk_relative)
            before_project = copy.deepcopy(project)
            before_renderer = pipeline.Renderer(before_project, cancel=cancel)
            before_renderer.palette()
            before_path, _ = before_renderer.output(index)
            after_project = copy.deepcopy(project)
            if not blocked and count:
                after_project["frames"][index].setdefault("mask_corrections", []).append(layer)
            after_renderer = pipeline.Renderer(after_project, cancel=cancel)
            after_renderer.palette()
            after_path, _ = after_renderer.output(index)
            report["items"].append(dict(index=index, frame_id=target["id"], applicable=bool(count and not blocked),
                accepted_ratio=round(ratio, 4), accepted_pixels=count,
                mean_confidence=round(float(confidence[good].mean()), 4) if count else 0,
                warnings=warnings, before_url=f"/media/{pid}/{before_path}",
                preview_url=f"/media/{pid}/{after_path}", rejected_url=f"/media/{pid}/{risk_relative}",
                original_url=f"/media/{pid}/{target['original']}", layer=layer))
    check_cancel(cancel)
    report["items"].sort(key=lambda item: item["index"])
    progress(1, "传播预览完成，勾选目标后应用")
    return report


def render_and_save(project, indices, progress, cancel):
    renderer = pipeline.Renderer(project, progress, cancel)
    renderer.palette()
    affected = set(indices)
    for i in range(len(project["frames"])):
        if pipeline.frame_settings(project, i).stabilize and set(indices) & set(pipeline.neighbor_ids(project, i)):
            affected.add(i)
    for done, i in enumerate(sorted(affected)):
        check_cancel(cancel)
        progress(done/len(affected), f"正在保存遮罩修订 {done+1} / {len(affected)}")
        output, thumb = renderer.output(i)
        project["frames"][i].update(output=output, thumb=thumb)
    check_cancel(cancel)
    project["last_run"] = dict(affected=sorted(affected), processed=len(affected),
        base_computed=renderer.rendered, base_cached=renderer.cached)
    store.write(project)
    return project["last_run"]


def apply(pid, report, request, progress, cancel):
    project = store.read(pid)
    editing.check_revision(project, request.expected_revision)
    if report["project_id"] != pid or report["revision"] != project["revision"] or report["id"] != request.report_id:
        raise ValueError("传播预览已过期，请重新生成预览")
    indices = editing.checked_indices(project, request.indices)
    items = {item["index"]: item for item in report["items"]}
    if any(i not in items or not items[i]["applicable"] or items[i]["frame_id"] != project["frames"][i]["id"]
           for i in indices):
        raise ValueError("只能应用本次预览中可用的目标帧")
    check_cancel(cancel)
    store.checkpoint(project)
    for i in indices:
        project["frames"][i].setdefault("mask_corrections", []).append(copy.deepcopy(items[i]["layer"]))
    return render_and_save(project, indices, progress, cancel)


def clear(pid, index, revision, frame_id, progress, cancel):
    project = store.read(pid)
    editing.check_revision(project, revision)
    if not 0 <= index < len(project["frames"]) or project["frames"][index]["id"] != frame_id:
        raise ValueError("当前帧已改变，请重新选择")
    if not project["frames"][index].get("mask_corrections"):
        raise ValueError("当前帧没有传播修订")
    check_cancel(cancel)
    store.checkpoint(project)
    project["frames"][index].pop("mask_corrections")
    return render_and_save(project, [index], progress, cancel)
