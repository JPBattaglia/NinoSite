"""One-piece sticker art (owner, Nov 1, 2026): Printful's kiss-cut sticker cuts around every separate part of the
artwork, so a design made of loose parts (words, an icon) came out as several stickers. This puts one white backing
shape behind the whole design: the parts' outline, with the gaps between them closed and every hole filled, plus a
white border. Printful then cuts a single outline.

    python3 sticker_backing.py in.png out.png

Pure function: backing(rgba_image) -> rgba_image. Needs Pillow, numpy, scipy.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ALPHA_MIN = 24            # pixels fainter than this don't count as part of the design
BORDER = 0.025            # white border, as a share of the design's longer side
CLOSE_STEPS = (0.02, 0.04, 0.06, 0.09, 0.13, 0.18)   # gap-closing radii tried in turn (share of the longer side)


def _disk(radius):
    r = max(1, int(round(radius)))
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def _grow(mask, radius):
    """Dilate by a disk, computed on a distance map (fast for big radii)."""
    return ndimage.distance_transform_edt(~mask) <= radius


def _shrink(mask, radius):
    return ndimage.distance_transform_edt(mask) > radius


def _pieces(mask):
    return ndimage.label(mask)[1]


def backing_mask(alpha, size):
    """The one-piece shape: closed, hole-free, bordered. Returns (mask, pad)."""
    design = alpha >= ALPHA_MIN
    border = max(2, BORDER * size)
    pad = int(np.ceil(border + max(CLOSE_STEPS) * size)) + 4
    design = np.pad(design, pad)
    shape = None
    for step in CLOSE_STEPS:
        radius = step * size
        closed = _shrink(_grow(design, radius), radius) | design       # morphological closing, never loses art
        candidate = _grow(ndimage.binary_fill_holes(closed), border)
        if _pieces(candidate) == 1:
            shape = candidate
            break
    if shape is None:
        # Parts too far apart to bridge nicely: wrap the whole design in its convex hull.
        ys, xs = np.nonzero(design)
        from scipy.spatial import ConvexHull
        pts = np.stack([xs, ys], 1)
        hull = pts[ConvexHull(pts).vertices]
        img = Image.new('L', design.shape[::-1], 0)
        from PIL import ImageDraw
        ImageDraw.Draw(img).polygon([tuple(p) for p in hull], fill=255)
        shape = _grow(np.array(img) > 0, border)
    # Soften the outline so the cut is smooth, not stair-stepped.
    soft = Image.fromarray((shape * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(max(1.0, border / 4)))
    shape = ndimage.binary_fill_holes(np.array(soft) >= 128)   # smoothing can reopen pinholes at thin bridges
    return shape, pad


def backing(image):
    image = image.convert('RGBA')
    rgba = np.array(image)
    size = max(image.size)
    shape, pad = backing_mask(rgba[..., 3], size)
    ys, xs = np.nonzero(shape)
    top, bottom, left, right = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    out = Image.new('RGBA', (shape.shape[1], shape.shape[0]), (0, 0, 0, 0))
    white = Image.new('RGBA', out.size, (255, 255, 255, 255))
    out.paste(white, (0, 0), Image.fromarray((shape * 255).astype(np.uint8)))
    out.alpha_composite(image, (pad, pad))
    return out.crop((left, top, right, bottom))


def pieces_after(image):
    """How many separate parts Printful would cut (1 = one sticker)."""
    return _pieces(np.array(image.convert('RGBA'))[..., 3] >= ALPHA_MIN)


def holes_after(image):
    """Transparent pinholes inside the sticker (0 = solid)."""
    inside = np.array(image.convert('RGBA'))[..., 3] >= ALPHA_MIN
    return _pieces(ndimage.binary_fill_holes(inside) & ~inside)


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    result = backing(Image.open(src))
    assert pieces_after(result) == 1, 'backing is not one piece'
    assert holes_after(result) == 0, 'backing has holes'
    result.save(dst, optimize=True)
