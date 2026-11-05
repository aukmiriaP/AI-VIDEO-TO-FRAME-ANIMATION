from __future__ import annotations

import json
import math
import uuid
import zipfile
from pathlib import Path

from PIL import Image
from pydantic import BaseModel, Field, model_validator

from . import imaging as img, storage as store
from .pipeline import Renderer
from .editing import check_revision


class ExportOptions(BaseModel):
    columns: int = Field(default=0, ge=0, le=64)
    padding: int = Field(default=2, ge=0, le=32)
    extrude: int = Field(default=2, ge=0, le=32)
    page_size: int = Field(default=4096, ge=128, le=4096)
    prefix: str = Field(default="", max_length=40, pattern=r"^[a-zA-Z0-9_\-]*$")
    action_ids: list[str] | None = Field(default=None, max_length=480)

    @model_validator(mode="after")
    def valid_margin(self):
        if self.extrude > self.padding:
            raise ValueError("扩边不能超过留白；请增加留白或减小扩边。")
        return self


def layout(project, options: ExportOptions):
    actions = project["actions"]
    if options.action_ids is not None:
        if not options.action_ids or set(options.action_ids) - {a["id"] for a in actions}:
            raise ValueError("请选择有效的导出动作；动作划分改变后需重新选择。")
        actions = [a for a in actions if a["id"] in options.action_ids]
    enabled = [i for i, fr in enumerate(project["frames"]) if fr["enabled"] and
               any(a["start"] <= i <= a["end"] for a in actions)]
    if not enabled:
        raise ValueError("所选动作没有启用帧，无法导出")
    w, h = img.canvas_size((project["width"], project["height"]),
                          img.Settings(**project["settings"]), img.AssetOptions(**project["asset_options"]))
    cw, ch = w+options.padding*2, h+options.padding*2
    max_cols, max_rows = options.page_size//cw, options.page_size//ch
    if not max_cols or not max_rows:
        raise ValueError("单帧连同留白超过图集上限，请增大单页上限或缩小画布。")
    if options.columns > max_cols:
        raise ValueError(f"当前图集最多容纳 {max_cols} 列，请减少列数或增大单页上限。")
    cols = options.columns or min(max_cols, max(1, math.ceil(math.sqrt(len(enabled)))))
    per_page = cols*max_rows
    prefix = f"{options.prefix}-" if options.prefix else ""
    pages = []
    for offset in range(0, len(enabled), per_page):
        group = enabled[offset:offset+per_page]
        pages.append(dict(file=f"{prefix}atlas-{len(pages):02d}.png",
                          size=[cols*cw, math.ceil(len(group)/cols)*ch],
                          cells=[dict(index=i, rect=[j%cols*cw+options.padding,
                                  j//cols*ch+options.padding, w, h]) for j, i in enumerate(group)]))
    pivot = project["asset_options"]
    return dict(canvas=[w, h], pivot=[pivot["pivot_x"], pivot["pivot_y"]], columns=cols,
                frames=len(enabled), pages=pages, enabled=enabled,
                actions=[a | {"frames": [i for i in enabled if a["start"] <= i <= a["end"]]}
                         for a in actions if any(a["start"] <= i <= a["end"] for i in enabled)],
                options=options.model_dump())


def preview_layout(pid, options=None, expected_revision=None):
    project = store.read(pid)
    if expected_revision is not None:
        check_revision(project, expected_revision)
    return layout(project, options or ExportOptions(**project["export_options"]))


def export_project(pid, progress, cancel, options=None, expected_revision=None):
    project = store.read(pid)
    if expected_revision is not None:
        check_revision(project, expected_revision)
    options = options or ExportOptions(**project["export_options"])
    plan = layout(project, options)
    root = store.project_dir(pid)
    token = uuid.uuid4().hex[:12]
    folder = root / "exports" / token
    (folder / "frames").mkdir(parents=True)
    renderer = Renderer(project, progress, cancel)
    renderer.palette()
    enabled = plan["enabled"]
    w, h = plan["canvas"]
    padding = options.extrude
    prefix = f"{options.prefix}-" if options.prefix else ""
    mapping, pages = {}, []
    done = 0
    for spec in plan["pages"]:
        page = Image.new("RGBA", tuple(spec["size"]))
        filename = spec["file"]
        for cell in spec["cells"]:
            index = cell["index"]
            if cancel():
                raise InterruptedError("已取消导出")
            done += 1
            progress(.2 + done/len(enabled)*.7, f"正在导出 {done} / {len(enabled)} 帧")
            path, _ = renderer.output(index)
            with Image.open(root / path) as raw:
                im = raw.convert("RGBA")
            if im.size != (w, h):
                raise ValueError("帧尺寸不一致；请先对全部帧应用统一输出尺寸。")
            frame_file = f"frames/{prefix}{index:05d}.png"
            im.save(folder / frame_file)
            x, y = cell["rect"][:2]
            # Copy RGBA, never paste with its own alpha mask (which squares alpha).
            page.paste(im, (x, y))
            if padding:
                page.paste(im.crop((0, 0, w, 1)).resize((w, padding), Image.Resampling.NEAREST), (x, y-padding))
                page.paste(im.crop((0, h-1, w, h)).resize((w, padding), Image.Resampling.NEAREST), (x, y+h))
                page.paste(im.crop((0, 0, 1, h)).resize((padding, h), Image.Resampling.NEAREST), (x-padding, y))
                page.paste(im.crop((w-1, 0, w, h)).resize((padding, h), Image.Resampling.NEAREST), (x+w, y))
                for sx, sy, dx, dy in ((0, 0, x-padding, y-padding), (w-1, 0, x+w, y-padding),
                                     (0, h-1, x-padding, y+h), (w-1, h-1, x+w, y+h)):
                    page.paste(im.crop((sx, sy, sx+1, sy+1)).resize((padding, padding)), (dx, dy))
            mapping[index] = dict(page=len(pages), rect=[x, y, w, h], duration=project["frames"][index]["duration"],
                                  id=project["frames"][index]["id"],
                                  source_time=project["frames"][index]["time"], file=frame_file,
                                  geometry=project["frames"][index]["geometry"],
                                  settings=project["frames"][index].get("settings") or project["settings"])
        page.save(folder / filename)
        pages.append(filename)
    actions = plan["actions"]
    pivot_x, pivot_y = plan["pivot"]
    manifest = dict(version=2, name=project["name"], style=project["style"], fps=project["fps"], canvas=[w, h],
                    pivot=[pivot_x, pivot_y], alpha="straight", pages=pages, frames=mapping, actions=actions,
                    asset_options=project["asset_options"], export_options=options.model_dump(),
                    palette=project.get("palette"), settings=project["settings"],
                    timing="edited durations in sequence order; disabled frames removed; action fps scales playback")
    (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    tres = ['[gd_resource type="SpriteFrames" load_steps=%d format=3]\n' % (1+len(pages)+len(mapping))]
    for p, filename in enumerate(pages):
        tres.append(f'[ext_resource type="Texture2D" path="{filename}" id="tex_{p}"]\n')
    for index, fr in mapping.items():
        x, y, fw, fh = fr["rect"]
        tres.append(f'[sub_resource type="AtlasTexture" id="frame_{index}"]\natlas = ExtResource("tex_{fr["page"]}")\nregion = Rect2({x}, {y}, {fw}, {fh})\nfilter_clip = true\n')
    specs = []
    for action in actions:
        frames = ", ".join('{"duration": %.8f, "texture": SubResource("frame_%d")}' %
                           (mapping[i]["duration"] * project["fps"], i) for i in action["frames"])
        specs.append('{"frames": [%s], "loop": %s, "name": &%s, "speed": %s}' %
                     (frames, str(action["loop"]).lower(), json.dumps(action["name"], ensure_ascii=False), action["fps"]))
    tres.append('[resource]\nanimations = [\n' + ",\n".join(specs) + '\n]\n')
    (folder / "animations.tres").write_text("\n".join(tres))
    texture_filter = 1 if project["style"] == "pixel" else 2
    (folder / "preview.tscn").write_text(
        '[gd_scene load_steps=2 format=3]\n\n'
        '[ext_resource type="SpriteFrames" path="animations.tres" id="1"]\n\n'
        '[node name="FrameStudioPreview" type="Node2D"]\n\n'
        '[node name="Animation" type="AnimatedSprite2D" parent="."]\n'
        f'position = Vector2(384, 320)\ntexture_filter = {texture_filter}\n'
        f'offset = Vector2({(.5-pivot_x)*w}, {(.5-pivot_y)*h})\n'
        f'sprite_frames = ExtResource("1")\nanimation = &{json.dumps(actions[0]["name"], ensure_ascii=False)}\n'
        f'autoplay = {json.dumps(actions[0]["name"], ensure_ascii=False)}\n')
    (folder / "project.godot").write_text(
        'config_version=5\n\n[application]\nconfig/name="Frame Studio Export"\nrun/main_scene="res://preview.tscn"\n\n'
        '[display]\nwindow/size/viewport_width=768\nwindow/size/viewport_height=640\n\n'
        '[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.12,0.14,0.15,1)\n')
    (folder / "README.txt").write_text(
        f"帧序 Frame Studio 导出\n\nPNG 为直通 Alpha（未预乘）。frames/ 为独立帧，图集留白 {options.padding}px、扩边 {options.extrude}px。\n"
        "Godot 4：可直接导入 project.godot 运行；已有工程请拷贝 atlas、animations.tres、preview.tscn（不要覆盖已有 project.godot）。\n"
        "每帧时长保存在 manifest.json 与 SpriteFrames duration。禁用帧不参与播放，动作总时长会缩短。\n"
        "像素风使用 nearest，非像素使用 linear。半透明质量请以 PNG 和引擎播放为准。\n")
    archive = folder.with_suffix(".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(folder.rglob("*")):
            if file.is_file():
                z.write(file, str(file.relative_to(folder)))
    if cancel():
        raise InterruptedError("已取消导出")
    if options.model_dump() != project["export_options"]:
        store.checkpoint(project)
        project["export_options"] = options.model_dump()
        store.write(project)
    return dict(url=f"/media/{pid}/exports/{token}.zip", folder=str(folder),
                pages=len(pages), frames=len(enabled), bytes=archive.stat().st_size)
