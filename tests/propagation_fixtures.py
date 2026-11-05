"""Deterministic motion fixtures for both API and Chrome verification."""
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image


def moving_image(index, occluded=False):
    rgba = np.zeros((128, 128, 4), np.uint8)
    if not occluded:
        yy, xx = np.mgrid[:64, :64]
        rgba[24:88, 20+index*4:84+index*4, :3] = np.stack(
            [80+(xx*13+yy*7)%100, 110+(xx*7+yy*11)%100, 60+(xx*11+yy*3)%100], axis=-1)
        rgba[24:88, 20+index*4:84+index*4, 3] = 220
    else:
        rgba[:] = [35, 35, 35, 255]
    return Image.fromarray(rgba)


if __name__ == "__main__":
    # Pass an existing parent directory; create an isolated data root.
    root = Path(tempfile.mkdtemp(prefix="propagation-validation-", dir=sys.argv[1]))
    for folder in ("fixtures", "occluded", "exports"):
        (root/folder).mkdir()
    for i in range(7):
        moving_image(i).save(root/"fixtures"/f"{i:03d}.png")
        moving_image(i, i==3).save(root/"occluded"/f"{i:03d}.png")
    print(root)
