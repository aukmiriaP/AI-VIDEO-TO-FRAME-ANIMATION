"""Local height-field normals. RGB is linear vector data, +Y points up."""
from __future__ import annotations

from typing import Literal

import cv2
import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

NORMAL_VERSION = 1


class NormalSettings(BaseModel):
    method: Literal["bevel", "luma", "mix"] = "bevel"
    strength: float = Field(default=2, ge=0, le=8, allow_inf_nan=False)
    bevel: float = Field(default=6, ge=1, le=32, allow_inf_nan=False)
    smooth: float = Field(default=1, ge=0, le=4, allow_inf_nan=False)
    detail: float = Field(default=.35, ge=0, le=1, allow_inf_nan=False)
    invert: bool = False
    flip_y: bool = False


def generate(image: Image.Image, settings: NormalSettings, cell: int = 1):
    full = np.asarray(image.convert("RGBA"))
    # Compute once per logical pixel; never quantize vector data with a color palette.
    arr = full[::cell, ::cell]
    alpha = arr[..., 3].astype(np.float32) / 255
    mask = alpha > 0
    distance = cv2.distanceTransform(np.pad(mask.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    t = np.clip(distance / settings.bevel, 0, 1)
    bevel = (t*t*(3-2*t)).astype(np.float32)
    luma = arr[..., :3].astype(np.float32) @ np.array([.2126, .7152, .0722], dtype=np.float32) / 255
    if settings.smooth:
        # Transparent RGB never bleeds into the height field.
        blur = lambda a: cv2.GaussianBlur(a, (0, 0), settings.smooth, borderType=cv2.BORDER_REPLICATE)
        luma = blur(luma*alpha) / np.maximum(blur(alpha), 1e-6)
    height = bevel if settings.method == "bevel" else (
        luma if settings.method == "luma" else bevel + luma*settings.detail)
    height = np.where(mask, height, 0)
    # Replicate endpoints, supporting even 1px-wide canvases.
    padded = np.pad(height, 1, mode="edge")
    dx = (padded[1:-1, 2:] - padded[1:-1, :-2]) * .5
    dy = (padded[2:, 1:-1] - padded[:-2, 1:-1]) * .5
    strength = settings.strength * (-1 if settings.invert else 1)
    vectors = np.stack((-dx*strength, dy*strength*(-1 if settings.flip_y else 1),
                        np.ones_like(dx)), axis=-1)
    vectors /= np.linalg.norm(vectors, axis=-1, keepdims=True)
    rgb = np.rint((vectors*.5+.5)*255).clip(0, 255).astype(np.uint8)
    if cell > 1:
        rgb = np.repeat(np.repeat(rgb, cell, axis=0), cell, axis=1)[:full.shape[0], :full.shape[1]]
    rgb[full[..., 3] == 0] = [128, 128, 255]
    return Image.fromarray(np.dstack((rgb, full[..., 3])))
