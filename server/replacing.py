"""Immutable frame replacement with explicit source/output coordinates."""
from __future__ import annotations

import hashlib
import io
import uuid
from typing import Literal

from PIL import Image, ImageOps, UnidentifiedImageError

from . import imaging, pipeline, storage as store
from .editing import check_revision


def decode(data: bytes):
    try:
        with Image.open(io.BytesIO(data)) as raw:
            if raw.format not in ("PNG", "JPEG", "WEBP") or getattr(raw, "n_frames", 1) != 1:
                raise ValueError("请选择单张 PNG、JPG 或 WebP 图片，不支持动画文件。")
            if raw.width * raw.height > 16_000_000:
                raise ValueError("单帧最多 1600 万像素")
            return ImageOps.exif_transpose(raw).convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("无法读取替换图片，请检查文件是否完整。") from exc


def replace(pid, index, mode: Literal["source", "output", "reset"], data, filename,
            keep_strokes, expected_revision, expected_frame_id, progress, cancel):
    project = store.read(pid)
    check_revision(project, expected_revision)
    if not 0 <= index < len(project["frames"]) or project["import_status"] != "ready":
        raise ValueError("请选择已导入的有效帧")
    frame = project["frames"][index]
    if frame["id"] != expected_frame_id:
        raise ValueError("当前帧已改变，请重新打开替换窗口。")
    renderer = pipeline.Renderer(project, progress, cancel)
    if cancel():
        raise InterruptedError("已取消替换，保留上一版帧")
    if mode == "reset":
        if not frame.get("output_override"):
            raise ValueError("当前帧没有成品覆盖")
        image = None
    else:
        image = decode(data)
        expected = (frame["width"], frame["height"]) if mode == "source" else imaging.canvas_size(
            (project["width"], project["height"]), pipeline.frame_settings(project, index),
            imaging.AssetOptions(**project["asset_options"]))
        if image.size != tuple(expected):
            raise ValueError(f"替换图片必须为 {expected[0]} × {expected[1]} px，当前为 {image.width} × {image.height} px；请保留对应画布尺寸。")
    store.checkpoint(project)
    if image is not None:
        token = uuid.uuid4().hex
        relative = f"originals/replacement-{token}.png"
        image.save(store.project_dir(pid) / relative)
        digest = hashlib.sha256(image.tobytes()).hexdigest()
        if mode == "source":
            frame.update(original=relative, source_hash=digest)
            frame.pop("output_override", None)
            frame.pop("override_hash", None)
            if not keep_strokes:
                frame["strokes"] = []
        else:
            frame.update(output_override=relative, override_hash=digest)
        frame["replacement"] = dict(mode=mode, filename=filename[:200], at=store.now())
    else:
        frame.pop("output_override", None)
        frame.pop("override_hash", None)
        frame.pop("replacement", None)
    renderer.palette()
    affected = {index}
    for i in range(len(project["frames"])):
        if pipeline.frame_settings(project, i).stabilize and index in pipeline.neighbor_ids(project, i):
            affected.add(i)
    for done, i in enumerate(sorted(affected)):
        progress(done / len(affected), f"正在更新替换帧及依赖 {done+1} / {len(affected)}")
        output, thumb = renderer.output(i)
        project["frames"][i].update(output=output, thumb=thumb)
    if cancel():
        raise InterruptedError("已取消替换，保留上一版帧")
    project["last_run"] = dict(affected=sorted(affected), processed=len(affected),
                               base_computed=renderer.rendered, base_cached=renderer.cached)
    store.write(project)
    return project["last_run"]
