"""Independent RGBA processing primitives. No application or persistence dependencies."""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Annotated, Literal

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from pydantic import BaseModel, Field, model_validator

Image.MAX_IMAGE_PIXELS = 20_000_000
ENGINE_VERSION = 3
BASE_EXCLUDE = {"stabilize", "colors", "palette_mode", "custom_palette", "palette_distance", "dither_strength"}
_ai_lock = threading.Lock()
_ai_session = None


def model_path(model_dir: Path) -> Path | None:
    # rembg 2.0.86 introduced a per-model subdirectory; older releases used flat files.
    for path in (model_dir / "models/u2netp/u2netp.onnx", model_dir / "u2netp.onnx"):
        if path.is_file() and path.stat().st_size > 1_000_000:
            return path
    return None


class Settings(BaseModel):
    style: Literal["smooth", "pixel"] = "smooth"
    background: Literal["keep", "chroma", "ai"] = "keep"
    key_color: str = Field(default="#36b859", pattern=r"^#[0-9a-fA-F]{6}$")
    tolerance: float = Field(default=35, ge=0, le=150)
    softness: float = Field(default=20, ge=1, le=100)
    despill: float = Field(default=0.5, ge=0, le=1)
    size: int = Field(default=384, ge=32, le=1024)
    colors: int = Field(default=24, ge=4, le=64)
    alpha_cutoff: int = Field(default=128, ge=1, le=254)
    stabilize: float = Field(default=0, ge=0, le=0.6)
    offset_x: float = Field(default=0, ge=-0.5, le=0.5)
    offset_y: float = Field(default=0, ge=-0.5, le=0.5)
    scale: float = Field(default=1, ge=0.25, le=2)
    align_mode: Literal["none", "center", "bottom"] = "none"
    bounds_threshold: int = Field(default=16, ge=1, le=254)
    matte_grow: int = Field(default=0, ge=-8, le=8)
    matte_feather: float = Field(default=0, ge=0, le=5, allow_inf_nan=False)
    edge_cleanup: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    speck_area: int = Field(default=0, ge=0, le=400)
    pixel_sampling: Literal["nearest", "area", "majority"] = "nearest"
    pixel_cell: int = Field(default=1, ge=1, le=8)
    palette_mode: Literal["auto", "custom"] = "auto"
    custom_palette: list[Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]] = Field(default_factory=list, max_length=64)
    palette_distance: Literal["rgb", "lab"] = "rgb"
    dither_strength: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    saturation: float = Field(default=1, ge=0, le=2, allow_inf_nan=False)
    contrast: float = Field(default=1, ge=.5, le=2, allow_inf_nan=False)
    brightness: float = Field(default=0, ge=-.5, le=.5, allow_inf_nan=False)
    smooth_strength: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    smooth_levels: int = Field(default=0, ge=0, le=16)
    outline_width: int = Field(default=0, ge=0, le=6)
    outline_color: str = Field(default="#202638", pattern=r"^#[0-9a-fA-F]{6}$")

    @model_validator(mode="after")
    def style_options(self):
        if self.palette_mode == "custom" and not self.custom_palette:
            raise ValueError("自定义色板至少需要一个 #RRGGBB 颜色。")
        if self.smooth_levels == 1:
            raise ValueError("颜色分层请设为 0（关闭）或 2–16 层。")
        return self


class AssetOptions(BaseModel):
    canvas_width: int = Field(default=0, ge=0, le=2048)
    canvas_height: int = Field(default=0, ge=0, le=2048)
    pivot_x: float = Field(default=.5, ge=0, le=1, allow_inf_nan=False)
    pivot_y: float = Field(default=.5, ge=0, le=1, allow_inf_nan=False)


class AssetEdits(BaseModel):
    align_mode: Literal["none", "center", "bottom"] = "none"
    bounds_threshold: int = Field(default=16, ge=1, le=254)
    matte_grow: int = Field(default=0, ge=-8, le=8)
    matte_feather: float = Field(default=0, ge=0, le=5, allow_inf_nan=False)
    edge_cleanup: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)
    speck_area: int = Field(default=0, ge=0, le=400)


class Stroke(BaseModel):
    mode: Literal["erase", "restore"]
    points: list[tuple[float, float]] = Field(min_length=1, max_length=1000)
    radius: float = Field(gt=0, le=0.3)


def fingerprint(*parts) -> str:
    return hashlib.sha256(json.dumps([ENGINE_VERSION, *parts], sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()[:24]


def fit_size(size: tuple[int, int], longest: int) -> tuple[int, int]:
    ratio = longest / max(size)
    return max(1, round(size[0] * ratio)), max(1, round(size[1] * ratio))


def resize_rgba(image: Image.Image, size: tuple[int, int], pixel=False) -> Image.Image:
    if image.size == size:
        return image.copy()
    if pixel:
        return image.resize(size, Image.Resampling.NEAREST)
    # Interpolate premultiplied RGB and alpha together to avoid dark fringes.
    return image.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def ai_session(model_dir: Path):
    global _ai_session
    import os
    os.environ["U2NET_HOME"] = str(model_dir)
    with _ai_lock:
        if _ai_session is None:
            from rembg import new_session
            _ai_session = new_session("u2netp", providers=["CPUExecutionProvider"])
    return _ai_session


def remove_background(image: Image.Image, settings: Settings, model_dir: Path) -> Image.Image:
    rgba = np.array(image.convert("RGBA"), dtype=np.float32)
    if settings.background == "keep":
        return Image.fromarray(rgba.astype(np.uint8))
    if settings.background == "ai":
        if model_path(model_dir) is None:
            raise ValueError("请先在导入面板下载轻量 AI 抠图模型（约 5 MB）。")
        from rembg import remove
        session = ai_session(model_dir)
        # Model mask intersects source alpha; never resurrect transparent content.
        with _ai_lock:
            mask = remove(image.convert("RGB"), session=session, only_mask=True)
        alpha = np.asarray(mask.convert("L"), dtype=np.float32) / 255
    else:
        bg = np.array([int(settings.key_color[i:i + 2], 16) for i in (1, 3, 5)], np.float32)
        distance = np.linalg.norm(rgba[..., :3] - bg, axis=-1) / np.sqrt(3)
        alpha = np.clip((distance - settings.tolerance) / settings.softness, 0, 1)
        alpha = alpha * alpha * (3 - 2 * alpha)
        if settings.despill:
            channel = int(bg.argmax())
            if bg[channel] - np.median(bg) > 30:
                other = [i for i in range(3) if i != channel]
                excess = np.maximum(0, rgba[..., channel] - np.max(rgba[..., other], axis=-1))
                rgba[..., channel] -= excess * settings.despill * (1 - alpha * 0.5)
    rgba[..., 3] *= alpha
    return Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8))


def brush_alpha(image: Image.Image, source: Image.Image, strokes: list[dict]) -> Image.Image:
    arr = np.array(image)
    original = np.array(source.convert("RGBA"))
    w, h = image.size
    for raw in strokes:
        stroke = Stroke(**raw)
        mask = Image.new("L", (w, h))
        draw = ImageDraw.Draw(mask)
        r = max(1, stroke.radius * min(w, h))
        points = [(max(0, min(1, x)) * (w - 1), max(0, min(1, y)) * (h - 1))
                  for x, y in stroke.points]
        if len(points) > 1:
            draw.line(points, fill=255, width=max(1, round(2 * r)))
        for x, y in points:
            draw.ellipse((x-r, y-r, x+r, y+r), fill=255)
        take = np.asarray(mask) > 0
        if stroke.mode == "erase":
            arr[take, 3] = 0
        else:
            arr[take] = original[take]
    return Image.fromarray(arr)


def refine_matte(image: Image.Image, source: Image.Image, settings: Settings) -> Image.Image:
    """Source-pixel mask refinement before manual corrections."""
    arr = np.array(image.convert("RGBA"))
    alpha = Image.fromarray(arr[..., 3])
    if settings.matte_grow:
        filt = ImageFilter.MaxFilter if settings.matte_grow > 0 else ImageFilter.MinFilter
        alpha = alpha.filter(filt(abs(settings.matte_grow)*2+1))
    if settings.matte_feather:
        alpha = alpha.filter(ImageFilter.GaussianBlur(settings.matte_feather))
    mask = np.minimum(np.asarray(alpha), np.asarray(source.convert("RGBA"))[..., 3]).copy()
    if settings.speck_area:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(
            np.uint8(mask >= settings.bounds_threshold), connectivity=8)
        small = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] <= settings.speck_area]
        if small:
            mask[np.isin(labels, small)] = 0
    if settings.edge_cleanup and mask.max() > 0:
        solid = mask >= max(1, int(mask.max()*.95))
        # Nearest interior RGB replaces contaminated colors only in soft edge pixels.
        _, labels = cv2.distanceTransformWithLabels(np.uint8(~solid), cv2.DIST_L2, 5,
                                                    labelType=cv2.DIST_LABEL_PIXEL)
        table = np.zeros((int(labels.max())+1, 3), np.float32)
        table[labels[solid]] = arr[solid, :3]
        edge = (mask > 0) & ~solid
        weight = settings.edge_cleanup * (1-mask[edge]/255)
        arr[edge, :3] = np.clip(arr[edge, :3]*(1-weight[:, None]) +
                                table[labels[edge]]*weight[:, None], 0, 255).astype(np.uint8)
    arr[..., 3] = mask
    return Image.fromarray(arr)


def canvas_size(source_size, settings: Settings, options: AssetOptions):
    w, h = fit_size(source_size, settings.size)
    return options.canvas_width or w, options.canvas_height or h


def prepare_geometry(source: Image.Image, settings: Settings, strokes: list[dict],
                     model_dir: Path, options: AssetOptions):
    from . import styling
    result = refine_matte(remove_background(source, settings, model_dir), source, settings)
    result = brush_alpha(result, source, strokes)
    resize = (lambda im, size: styling.sample_rgba(im, size, settings.pixel_sampling)) if settings.style == "pixel" else resize_rgba
    result = resize(result, fit_size(source.size, settings.size))
    scaled = resize(result, (max(1, round(result.width*settings.scale)),
                             max(1, round(result.height*settings.scale))))
    if settings.style == "pixel":
        arr = np.array(scaled)
        arr[..., 3] = np.where(arr[..., 3] >= settings.alpha_cutoff, 255, 0)
        scaled = Image.fromarray(arr)
    w, h = canvas_size(source.size, settings, options)
    mask = np.asarray(scaled)[..., 3]
    visible = Image.fromarray(np.uint8(mask >= settings.bounds_threshold)*255).getbbox()
    dx, dy = (w-scaled.width)/2, (h-scaled.height)/2
    warnings = []
    if visible and settings.align_mode != "none":
        x0, y0, x1, y1 = visible
        dx = options.pivot_x*w - (x0+x1)/2
        dy = options.pivot_y*h - ((y0+y1)/2 if settings.align_mode == "center" else y1)
        if np.all(mask >= settings.bounds_threshold):
            warnings.append("未检测到透明背景：对齐使用整张图的边界，请先抠图。")
    dx, dy = round(dx+settings.offset_x*w), round(dy+settings.offset_y*h)
    if not visible:
        warnings.append("没有达到边界阈值的主体，请检查透明度或降低阈值。")
    # Count every nonzero alpha pixel, including faint edges below the bounds threshold.
    yy, xx = np.nonzero(mask)
    clipped = int(np.count_nonzero((xx+dx < 0) | (xx+dx >= w) | (yy+dy < 0) | (yy+dy >= h)))
    if clipped:
        warnings.append(f"主体超出画布，{clipped} 个可见像素会被裁切。")
    canvas = Image.new("RGBA", (w, h))
    canvas.alpha_composite(scaled, (dx, dy))
    canvas, style_warnings = styling.base_style(canvas, settings)
    warnings.extend(style_warnings)
    bbox = canvas.getchannel("A").getbbox()
    geometry = dict(canvas=[w, h], source=list(source.size), scaled=list(scaled.size),
                    scale=[scaled.width/source.width, scaled.height/source.height],
                    offset=[dx, dy], pivot=[options.pivot_x, options.pivot_y],
                    bounds=list(bbox) if bbox else None, clipped_pixels=clipped, warnings=warnings)
    return canvas, geometry


def prepare(source: Image.Image, settings: Settings, strokes: list[dict], model_dir: Path) -> Image.Image:
    return prepare_geometry(source, settings, strokes, model_dir, AssetOptions())[0]


def make_palette(images: list[Image.Image], colors: int) -> list[list[int]]:
    samples = []
    for im in images:
        arr = np.asarray(im)
        visible = arr[..., :3][arr[..., 3] > 127]
        if len(visible):
            samples.append(visible[::max(1, len(visible)//3000)])
    if not samples:
        return [[0, 0, 0]]
    pixels = np.concatenate(samples)
    pixels = pixels[::max(1, len(pixels)//60000)]
    # Pillow median-cut is deterministic and requires no seed or training state.
    strip = Image.fromarray(pixels.reshape(1, -1, 3)).quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    used = sorted(strip.getcolors(), reverse=True)
    table = np.array(strip.getpalette(), np.uint8).reshape(-1, 3)
    return [table[index].tolist() for _, index in used]


def quantize(image: Image.Image, palette: list[list[int]], settings: Settings | None = None) -> Image.Image:
    from .styling import palette_map
    return palette_map(image, palette, settings or Settings())


def temporal(current: Image.Image, neighbors: list[Image.Image], settings: Settings,
             palette: list[list[int]] | None) -> Image.Image:
    """Bounded three-frame filter. Source neighbors, never previous filtered outputs."""
    if not neighbors or settings.stabilize <= 0:
        return current.copy()
    center = np.asarray(current, np.float32) / 255
    alpha = center[..., 3:4]
    accum = center[..., :3] * alpha
    total = np.ones_like(alpha)
    gray = cv2.cvtColor(np.uint8(center[..., :3] * alpha * 255), cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    for im in neighbors:
        if im.size != current.size:
            continue
        other = np.asarray(im, np.float32) / 255
        if settings.style == "smooth":
            og = cv2.cvtColor(np.uint8(other[..., :3] * other[..., 3:4] * 255), cv2.COLOR_RGB2GRAY)
            forward = cv2.calcOpticalFlowFarneback(gray, og, None, .5, 3, 15, 3, 5, 1.2, 0)
            backward = cv2.calcOpticalFlowFarneback(og, gray, None, .5, 3, 15, 3, 5, 1.2, 0)
            mx, my = xx + forward[..., 0], yy + forward[..., 1]
            reverse = cv2.remap(backward, mx, my, cv2.INTER_LINEAR)
            valid = ((mx >= 0) & (mx < w-1) & (my >= 0) & (my < h-1)
                     & (np.linalg.norm(forward + reverse, axis=-1) < 0.8))
            other_pm = other.copy()
            other_pm[..., :3] *= other_pm[..., 3:4]
            warped = cv2.remap(other_pm, mx, my, cv2.INTER_LINEAR)
            other = warped.copy()
            other[..., :3] /= np.maximum(other[..., 3:4], 1e-5)
        else:
            valid = np.ones((h, w), bool)
        # Reject disocclusions, major color changes, and changing silhouettes.
        error = np.abs(other[..., :3] - center[..., :3]).mean(-1)
        safe = valid & (error < .12) & (np.abs(other[..., 3] - center[..., 3]) < .06) & (center[..., 3] > .05)
        weight = settings.stabilize * np.maximum(0, 1 - error/.12) * safe
        accum += other[..., :3] * alpha * weight[..., None]
        total += weight[..., None]
    result = center.copy()
    result[..., :3] = accum / total / np.maximum(alpha, 1e-5)
    result[..., :3][alpha[..., 0] == 0] = center[..., :3][alpha[..., 0] == 0]
    out = Image.fromarray(np.clip(result * 255 + .5, 0, 255).astype(np.uint8))
    return quantize(out, palette) if settings.style == "pixel" and palette else out


def thumbnail(image: Image.Image) -> Image.Image:
    return resize_rgba(image, fit_size(image.size, 128))


def demo_frames() -> list[Image.Image]:
    """Procedurally drawn practice animation; explicitly labeled in the UI."""
    import math
    frames = []
    for i in range(24):
        phase = i * math.tau / 24
        im = Image.new("RGBA", (384, 384), (54, 184, 89, 255))
        # Draw at 2x for a genuine soft-edge test source.
        im = im.resize((768, 768))
        d = ImageDraw.Draw(im)
        x, y = 384 + 18*math.sin(phase), 340 + 24*math.cos(phase)
        d.ellipse((x-100, 656, x+100, 680), fill=(41, 152, 72, 255))
        for k in range(5):
            points = [(x-95+k*46+math.sin(phase+j*.4+k)*18, y+60+j*19) for j in range(10)]
            d.line(points, fill=(228, 249, 240, 255), width=18)
        d.ellipse((x-136, y-140, x+136, y+100), fill=(30, 83, 76, 255))
        d.ellipse((x-128, y-136, x+128, y+84), fill=(231, 246, 230, 255))
        d.ellipse((x-101, y-118, x+18, y-43), fill=(251, 255, 244, 255))
        blink = 3 if i in (10, 11) else 20
        for ex in (x-45, x+45):
            d.ellipse((ex-10, y-10-blink/2, ex+10, y-10+blink/2), fill=(24, 64, 60, 255))
        d.arc((x-16, y+7, x+16, y+33), 0, 180, fill=(24, 64, 60, 255), width=5)
        d.ellipse((x-79, y+15, x-47, y+29), fill=(244, 154, 124, 255))
        d.ellipse((x+47, y+15, x+79, y+29), fill=(244, 154, 124, 255))
        frames.append(im.resize((384, 384), Image.Resampling.LANCZOS))
    return frames
