from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageOps

from . import imaging as img, storage as store

MAX_FRAMES = 480


def ingest(project, paths: list[Path], fps: float, start: float, end: float, progress, cancel):
    root = store.project_dir(project["id"])
    frames = []
    dimensions = None

    def add(image, timestamp, label):
        nonlocal dimensions
        if cancel():
            raise InterruptedError("已取消导入")
        if len(frames) >= MAX_FRAMES:
            raise ValueError(f"最多导入 {MAX_FRAMES} 帧；请缩短时间范围或降低抽帧率。")
        if image.width * image.height > 16_000_000:
            raise ValueError("单帧最多 1600 万像素，请先降低视频或图片分辨率。")
        image = ImageOps.exif_transpose(image).convert("RGBA")
        dimensions = dimensions or image.size
        if image.size != dimensions:
            raise ValueError("PNG 序列尺寸不一致；请先统一画布尺寸。")
        fid = f"{len(frames):05d}"
        original = f"originals/{fid}.png"
        thumb = f"thumbs/original-{fid}.png"
        image.save(root / original)
        img.thumbnail(image).save(root / thumb)
        frames.append(dict(id=fid, original=original, thumb=thumb, output=None,
                           source_hash=hashlib.sha256(image.tobytes()).hexdigest(),
                           width=image.width, height=image.height, time=timestamp,
                           duration=1/fps, enabled=True, strokes=[], settings=None, label=label))
        progress(min(.9, len(frames)/MAX_FRAMES), f"正在导入第 {len(frames)} 帧")

    if not paths:
        for i, image in enumerate(img.demo_frames()):
            add(image, i/fps, f"练习帧 {i+1}")
        project["demo"] = True
        project["settings"]["background"] = "chroma"
    elif len(paths) == 1 and paths[0].suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        with av.open(str(paths[0])) as container:
            if not container.streams.video:
                raise ValueError("文件中没有视频轨道")
            stream = container.streams.video[0]
            if stream.width * stream.height > 16_000_000:
                raise ValueError("视频分辨率超过首版限制（1600 万像素）")
            origin = None
            next_sample = start
            last_time = None
            rate = float(stream.average_rate or fps)
            source_end = float(stream.duration * stream.time_base) if stream.duration else 0
            for i, frame in enumerate(container.decode(stream)):
                if cancel():
                    raise InterruptedError("已取消导入")
                stamp = float(frame.time) if frame.time is not None else i/rate
                if origin is None:
                    origin = stamp
                timestamp = stamp - origin
                last_time = timestamp
                if end > 0 and timestamp >= end:
                    break
                if timestamp < start:
                    continue
                # Use actual presentation timestamps, including VFR video.
                if timestamp + 1e-7 >= next_sample:
                    image = frame.to_image()
                    add(image, timestamp, paths[0].name)
                    # Never duplicate a source frame when requested rate exceeds source rate.
                    next_sample = start + (math.floor((timestamp-start)*fps + 1e-6)+1)/fps
            for i in range(len(frames)-1):
                frames[i]["duration"] = max(.001, frames[i+1]["time"]-frames[i]["time"])
            if frames:
                stop = source_end or ((last_time or 0) + 1/rate)
                if end > 0:
                    stop = min(stop, end)
                frames[-1]["duration"] = max(.001, stop - frames[-1]["time"])
            project["source_fps"] = rate
            project["last_source_time"] = last_time
    else:
        for i, path in enumerate(sorted(paths, key=lambda p: [int(v) if v.isdigit() else v.lower()
                                                             for v in re.split(r"(\d+)", p.name)])):
            with Image.open(path) as image:
                add(image, i/fps, path.name)
    if not frames:
        raise ValueError("所选范围没有可读取的帧，请检查起止时间和文件格式。")
    project.update(frames=frames, width=dimensions[0], height=dimensions[1],
                   actions=[dict(id="full", name="idle" if project.get("demo") else "animation",
                                 start=0, end=len(frames)-1, fps=fps, loop=True)],
                   import_status="ready")
    store.write(project)
    progress(1, f"已导入 {len(frames)} 帧")
    return dict(frames=len(frames))


def frame_settings(project, index):
    return img.Settings(**(project["frames"][index].get("settings") or project["settings"]))


def neighbor_ids(project, index):
    for action in project["actions"]:
        if action["start"] <= index <= action["end"]:
            enabled = [i for i in range(action["start"], action["end"]+1) if project["frames"][i]["enabled"]]
            if index not in enabled or len(enabled) < 2:
                return []
            pos = enabled.index(index)
            neighbors = []
            if pos > 0:
                neighbors.append(enabled[pos-1])
            elif action["loop"]:
                neighbors.append(enabled[-1])
            if pos < len(enabled)-1:
                neighbors.append(enabled[pos+1])
            elif action["loop"]:
                neighbors.append(enabled[0])
            return list(dict.fromkeys(neighbors))
    return [j for j in (index-1, index+1) if 0 <= j < len(project["frames"])]


class Renderer:
    def __init__(self, project, progress=lambda *_: None, cancel=lambda: False):
        self.project = project
        self.root = store.project_dir(project["id"])
        self.progress, self.cancel = progress, cancel
        self.cached = 0
        self.rendered = 0

    def base(self, index):
        if self.cancel():
            raise InterruptedError("已取消处理，保留上一版结果")
        fr = self.project["frames"][index]
        settings = frame_settings(self.project, index)
        stage = settings.model_dump(exclude=img.BASE_EXCLUDE)
        options = img.AssetOptions(**self.project.get("asset_options", {}))
        key = img.fingerprint("base", fr["source_hash"], stage, fr["strokes"], options.model_dump())
        target = self.root / "derived" / f"base-{key}.png"
        meta = target.with_suffix(".json")
        if not target.exists() or not meta.exists():
            with Image.open(self.root / fr["original"]) as source:
                result, geometry = img.prepare_geometry(source.convert("RGBA"), settings, fr["strokes"],
                                                        store.MODELS, options)
                result.save(target)
                meta.write_text(json.dumps(geometry))
            self.rendered += 1
        else:
            self.cached += 1
        fr["geometry"] = json.loads(meta.read_text())
        with Image.open(target) as image:
            return image.convert("RGBA"), key

    def palette(self, rebuild=False):
        if self.project["style"] != "pixel":
            return
        options = img.Settings(**self.project["settings"])
        if options.palette_mode == "custom":
            self.project["palette"] = [[int(c[i:i+2],16) for i in (1,3,5)] for c in options.custom_palette]
            self.project["palette_colors"] = len(self.project["palette"])
            return
        colors = options.colors
        if self.project.get("palette") and not rebuild and self.project.get("palette_colors") == colors:
            return
        # Sample evenly over the whole sequence; lock until explicitly rebuilt.
        enabled = [i for i,f in enumerate(self.project["frames"]) if f["enabled"]]
        if not enabled:
            raise ValueError("没有启用帧，无法提取色板")
        indices = [enabled[i] for i in np.unique(np.linspace(0,len(enabled)-1,min(32,len(enabled))).astype(int))]
        images = []
        for n, i in enumerate(indices):
            self.progress(n/max(1, len(indices))*.25, "正在建立全序列共用色板")
            images.append(self.base(int(i))[0])
        self.project["palette"] = img.make_palette(images, colors)
        self.project["palette_colors"] = colors

    def output(self, index):
        current, key = self.base(index)
        settings = frame_settings(self.project, index)
        palette = self.project.get("palette") if settings.style == "pixel" else None
        ids = neighbor_ids(self.project, index) if settings.stabilize else []
        neighbors = [self.base(i) for i in ids]
        final_key = img.fingerprint("output", key, [k for _, k in neighbors], palette,
                                    settings.stabilize, settings.style,settings.palette_distance,settings.dither_strength)
        relative = f"derived/out-{final_key}.png"
        target = self.root / relative
        if not target.exists():
            # Stabilize continuous colors, then quantize/dither exactly once.
            result = img.temporal(current, [im for im, _ in neighbors], settings, None)
            if palette:
                result = img.quantize(result,palette,settings)
            result.save(target)
            img.thumbnail(result).save(self.root / "thumbs" / f"{final_key}.png")
        return relative, f"thumbs/{final_key}.png"


def configure(project, ids, settings, asset_options=None, asset_patch=None, settings_patch=None):
    all_frames = len(ids) == len(project["frames"])
    if asset_options is not None and asset_options.model_dump() != project.get("asset_options", {}):
        if not all_frames:
            raise ValueError("画布与锚点属于序列设置，请选择「全部帧」应用。")
        project["asset_options"] = asset_options.model_dump()
    global_keys = ("style","size","colors","palette_mode","custom_palette")
    if settings is not None and settings_patch is not None:
        raise ValueError("完整设置与参数补丁不能同时提交")
    if settings_patch is not None:
        if set(settings_patch)-set(img.Settings.model_fields):
            raise ValueError("参数补丁包含未知字段")
        next_settings = img.Settings(**(project["settings"]|settings_patch))
        if not all_frames and any(getattr(next_settings,k)!=project["settings"][k] for k in global_keys):
            raise ValueError("风格、输出尺寸和色板属于序列设置，请选择「全部帧」应用。")
        for i in ids:
            original = frame_settings(project,i).model_dump()
            project["frames"][i]["settings"] = img.Settings(**(original|settings_patch)).model_dump()
        if all_frames:
            if any(getattr(next_settings,k)!=project["settings"][k] for k in global_keys if k!="size"):
                project["palette"] = None
            project["settings"] = next_settings.model_dump()
            project["style"] = next_settings.style
    if settings:
        if not all_frames and any(getattr(settings, k) != project["settings"][k] for k in global_keys):
            raise ValueError("风格、输出尺寸和色板属于序列设置，请选择「全部帧」应用。")
        for i in ids:
            project["frames"][i]["settings"] = settings.model_dump()
        if all_frames:
            if any(getattr(settings,k) != project["settings"][k] for k in global_keys if k != "size"):
                project["palette"] = None
            project["style"] = settings.style
            project["settings"] = settings.model_dump()
    if asset_patch is not None:
        patch = asset_patch.model_dump()
        for i in ids:
            project["frames"][i]["settings"] = frame_settings(project, i).model_dump() | patch
        if all_frames:
            project["settings"].update(patch)


def process(pid, indices, settings, rebuild, progress, cancel, strokes=None,
            asset_options=None, asset_patch=None, settings_patch=None):
    project = store.read(pid)
    store.checkpoint(project)
    count = len(project["frames"])
    ids = sorted(set(range(count) if indices is None else indices))
    if not ids or any(i < 0 or i >= count for i in ids):
        raise ValueError("请选择有效的帧范围")
    configure(project, ids, settings, asset_options, asset_patch, settings_patch)
    if strokes is not None:
        if len(ids) != 1:
            raise ValueError("画笔修订只作用于当前帧")
        project["frames"][ids[0]]["strokes"] = strokes
    renderer = Renderer(project, progress, cancel)
    renderer.palette(rebuild)
    # Rebuild of a shared palette changes every frame's dependency.
    affected = set(range(count)) if rebuild else set(ids)
    for i in range(count):
        if frame_settings(project, i).stabilize and set(neighbor_ids(project, i)) & set(ids):
            affected.add(i)
    for done, i in enumerate(sorted(affected)):
        progress(.25 + done/max(1, len(affected))*.7, f"正在处理 {done+1} / {len(affected)} 帧")
        output, thumb = renderer.output(i)
        project["frames"][i].update(output=output, thumb=thumb)
    if cancel():
        raise InterruptedError("已取消处理，保留上一版结果")
    project["last_run"] = dict(affected=sorted(affected), processed=len(affected),
                               base_computed=renderer.rendered, base_cached=renderer.cached)
    store.write(project)
    return project["last_run"]


def preview(pid, index, settings, indices=None, asset_options=None, asset_patch=None, settings_patch=None):
    project = copy.deepcopy(store.read(pid))
    count = len(project["frames"])
    if not 0 <= index < count:
        raise ValueError("无效帧")
    ids = sorted(set(range(count) if indices is None else indices))
    if not ids or any(i < 0 or i >= count for i in ids):
        raise ValueError("请选择有效的帧范围")
    if index not in ids:
        raise ValueError("当前预览帧不在所选范围内")
    configure(project, ids, settings, asset_options, asset_patch, settings_patch)
    renderer = Renderer(project)
    renderer.palette()
    path, _ = renderer.output(index)
    return path, project["frames"][index]["geometry"]
