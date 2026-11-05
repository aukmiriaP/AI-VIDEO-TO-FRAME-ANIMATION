"""Deterministic local style processing; independent of proprietary algorithms."""
from __future__ import annotations

import math

import cv2
import numpy as np
from PIL import Image

from .imaging import Settings, resize_rgba


def sample_rgba(image: Image.Image, size: tuple[int, int], method: str) -> Image.Image:
    """Sample RGB only where alpha contributes, avoiding hidden-background contamination."""
    if image.size == size or method == "nearest":
        return resize_rgba(image, size, pixel=True)
    w, h = size
    if method == "area":
        rgba = np.asarray(image, np.float32)/255
        rgba = rgba.copy()
        rgba[..., :3] *= rgba[..., 3:4]
        result = cv2.resize(rgba, size, interpolation=cv2.INTER_AREA)
        result[..., :3] /= np.maximum(result[..., 3:4], 1e-6)
        return Image.fromarray(np.uint8(np.clip(result*255+.5, 0, 255)))
    # Five stratified samples per cell; alpha-weighted, coarse RGB bins.
    # Center wins ties. This is a bounded heuristic, not exact full-cell mode.
    offsets = ((.5,.5),(.2,.2),(.8,.2),(.2,.8),(.8,.8))
    samples = []
    for ox, oy in offsets:
        xx = np.minimum(image.width-1, ((np.arange(w)+ox)*image.width/w).astype(int))
        yy = np.minimum(image.height-1, ((np.arange(h)+oy)*image.height/h).astype(int))
        samples.append(np.asarray(image)[yy[:, None], xx])
    samples = np.stack(samples)
    bins = samples[..., :3].astype(np.uint32) >> 3
    codes = (bins[..., 0] << 10) | (bins[..., 1] << 5) | bins[..., 2]
    scores = np.stack([np.sum((codes == code)*samples[..., 3], axis=0) for code in codes])
    choice = scores.argmax(axis=0)
    yy, xx = np.mgrid[:h, :w]
    result = samples[choice, yy, xx].copy()
    result[..., 3] = np.rint(samples[..., 3].mean(axis=0)).astype(np.uint8)
    return Image.fromarray(result)


def grade(image: Image.Image, settings: Settings) -> Image.Image:
    if settings.saturation == 1 and settings.contrast == 1 and settings.brightness == 0:
        return image.copy()
    arr = np.array(image)
    rgb = arr[..., :3].astype(np.float32)/255
    luma = np.sum(rgb*np.array([.2126,.7152,.0722], np.float32), axis=-1, keepdims=True)
    rgb = luma+(rgb-luma)*settings.saturation
    rgb = (rgb-.5)*settings.contrast+.5+settings.brightness
    arr[..., :3] = np.uint8(np.clip(rgb*255+.5, 0, 255))
    return Image.fromarray(arr)


def smooth_colors(image: Image.Image, settings: Settings) -> Image.Image:
    if not settings.smooth_strength and not settings.smooth_levels:
        return image.copy()
    arr = np.array(image)
    visible = arr[..., 3] > 0
    if not visible.any():
        return image.copy()
    rgb = arr[..., :3].astype(np.float32)
    if settings.smooth_strength:
        # Extend foreground colors into transparent space before filtering.
        # The original alpha is kept exactly; transparent RGB cannot darken the edge.
        _, labels = cv2.distanceTransformWithLabels(np.uint8(~visible), cv2.DIST_L2, 5,
                                                    labelType=cv2.DIST_LABEL_PIXEL)
        table = np.zeros((int(labels.max())+1,3), np.float32)
        table[labels[visible]] = rgb[visible]
        filled = table[labels]
        smoothed = cv2.bilateralFilter(filled, 7, 12+48*settings.smooth_strength,
                                       1+3*settings.smooth_strength)
        rgb[visible] = rgb[visible]*(1-settings.smooth_strength)+smoothed[visible]*settings.smooth_strength
    if settings.smooth_levels:
        # Fixed bins across the sequence, never per-frame normalization.
        step = 255/(settings.smooth_levels-1)
        rgb[visible] = np.rint(rgb[visible]/step)*step
    arr[visible, :3] = np.uint8(np.clip(rgb[visible]+.5,0,255))
    return Image.fromarray(arr)


def grid(image: Image.Image, settings: Settings) -> tuple[Image.Image, Image.Image]:
    cell = settings.pixel_cell
    w, h = image.size
    gw, gh = math.ceil(w/cell), math.ceil(h/cell)
    # Right/bottom padding preserves a uniform cell pitch for non-divisible dimensions.
    padded = Image.fromarray(np.pad(np.asarray(image),
                            ((0,gh*cell-h),(0,gw*cell-w),(0,0)),mode="edge"))
    logical = sample_rgba(padded, (gw,gh), settings.pixel_sampling)
    arr = np.array(logical)
    arr[..., 3] = np.where(arr[..., 3] >= settings.alpha_cutoff,255,0)
    logical = Image.fromarray(arr)
    return logical.resize(padded.size,Image.Resampling.NEAREST).crop((0,0,w,h)), logical


def outline(image: Image.Image, width: int, color: str, pixel=False):
    if not width:
        return image.copy(), False
    arr = np.array(image)
    alpha = arr[..., 3]
    kernel = np.ones((width*2+1,width*2+1),np.uint8) if pixel else cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,(width*2+1,width*2+1))
    dilated = cv2.dilate(alpha,kernel,borderType=cv2.BORDER_CONSTANT,borderValue=0)
    take = (alpha == 0) & (dilated > 0)
    arr[take,:3] = [int(color[i:i+2],16) for i in (1,3,5)]
    arr[take,3] = dilated[take]
    clipped = bool(alpha[:width].any() or alpha[-width:].any() or
                   alpha[:,:width].any() or alpha[:,-width:].any())
    return Image.fromarray(arr), clipped


def base_style(image: Image.Image, settings: Settings):
    result = grade(image,settings)
    if settings.style == "pixel":
        result, logical = grid(result,settings)
        logical, clipped = outline(logical,settings.outline_width,settings.outline_color,True)
        if settings.outline_width:
            result = logical.resize((logical.width*settings.pixel_cell,logical.height*settings.pixel_cell),
                                     Image.Resampling.NEAREST).crop((0,0,image.width,image.height))
    else:
        result = smooth_colors(result,settings)
        result, clipped = outline(result,settings.outline_width,settings.outline_color)
    warnings = ["描边接近画布边界，可能被裁切；可增加画布留白。"] if clipped else []
    return result, warnings


def palette_map(image: Image.Image, palette: list[list[int]], settings: Settings):
    arr = np.array(image)
    flat = arr[...,:3].reshape(-1,3).astype(np.float32)
    colors = np.asarray(palette,np.float32)
    if settings.palette_distance == "lab":
        values = cv2.cvtColor((flat/255).reshape(-1,1,3),cv2.COLOR_RGB2LAB).reshape(-1,3)
        candidates = cv2.cvtColor((colors/255).reshape(-1,1,3),cv2.COLOR_RGB2LAB).reshape(-1,3)
    else:
        values, candidates = flat, colors
    # Fixed Bayer pattern anchored to the output canvas's logical pixel cells.
    bayer = np.array([[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]],np.float32)
    for start in range(0,len(values),8192):
        block = values[start:start+8192]
        distance = np.sum((block[:,None]-candidates[None])**2,axis=-1)
        nearest = distance.argmin(axis=-1)
        if settings.dither_strength and len(colors)>1:
            distance[np.arange(len(block)),nearest] = np.inf
            second = distance.argmin(axis=-1)
            delta = candidates[second]-candidates[nearest]
            mix = np.clip(np.sum((block-candidates[nearest])*delta,axis=-1)/
                           np.maximum(np.sum(delta*delta,axis=-1),1e-6),0,1)
            pos = np.arange(start,start+len(block))
            yy,xx = pos//image.width//settings.pixel_cell,pos%image.width//settings.pixel_cell
            threshold = (bayer[yy%4,xx%4]+.5)/16
            nearest = np.where(mix*settings.dither_strength > threshold,second,nearest)
        flat[start:start+len(block)] = colors[nearest]
    arr[...,:3] = flat.reshape(arr.shape[:2]+(3,)).astype(np.uint8)
    return Image.fromarray(arr)
