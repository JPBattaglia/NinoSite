"""Mug artwork for every live design (owner, Nov 2, 2026: coffee mugs replace the aprons). Run by
.github/workflows/sticker-art.yml after the stickers.

    python3 make_mugs.py <site root>

The mug's print file wraps all the way round; its middle is the back (away from the handle). Printful prints a
placed design where it is told, but its own product photo of a store mug ignores the placement and shows the design
wrapped round the edge. So each design is drawn once, on the face seen with the handle on the right (centered at 75%
of the wrap), on a transparent full-wrap file; the worker (src/sticker-art.mjs, kind "mug") puts that file on the
mug products covering the whole wrap, and Printful's photo and print both show it facing out.
Artwork: Printful's 800 px preview of the design, enlarged.
Output: assets/mugs/<design id>.png and assets/mugs/manifest.json
    {"<design id>": {"sha": <sha1 of the png>, "w": 2700, "h": 1140, "art": <Printful hash>, "layout": LAYOUT}}

Black Glossy Mug (owner, Nov 3, 2026): its print area is narrower (2250 px, 7.5 in round the same mug), so the
white wrap's 75% point lands left of the front face. Each design also gets assets/mugs/black/<design id>.png
(2250 x 925, the 11 oz area; the 15 oz area is the same width) with the design centered at BLACK_CX, drawn from the
design's white wrap, and assets/mugs/black/manifest.json in the same format.
"""
import hashlib, io, json, os, sys
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(__file__))
from make_stickers import fetch, live_designs, PREVIEW_SCALE

AREA = (2700, 1140)        # the 15 oz wrap at 300 dpi; the 11 oz (2700 x 1050) gets the same file fitted to its height
BOX_W, BOX_H, CENTER_X = 0.40, 0.86, 0.75
LAYOUT = 'v1-0.40-0.86-0.75'
BLACK_AREA = (2250, 925)
BLACK_W, BLACK_H, BLACK_CX = 0.36, 0.86, 0.78   # ~2.7 in wide at most: stays on the front face (mockup check, Nov 3)
BLACK_LAYOUT = 'b1-0.36-0.86-0.78'


def clear_background(art):
    """The wrap must have a transparent background (owner, Nov 3, 2026: black mugs). Printful prints the black mug's
    color wherever the file is transparent, so a solid white backdrop behind a design would print as a white box.
    When all four corners of the artwork are opaque near-white, that backdrop (flooded from the corners) is cleared.
    Other opaque corners are left alone: framed designs (a badge, a square poster) are meant to look that way."""
    art = art.convert('RGBA')
    w, h = art.size
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    if not all(art.getpixel(c)[3] > 250 and min(art.getpixel(c)[:3]) > 235 for c in corners):
        return art
    marked = art.convert('RGB')
    for c in corners:
        ImageDraw.floodfill(marked, c, (255, 0, 255), thresh=24)
    # Pixels the flood reached (painted magenta) become transparent.
    r, g, b = marked.split()
    hit = Image.eval(r, lambda v: 255 if v == 255 else 0)
    hit = Image.composite(hit, Image.new('L', (w, h), 0), Image.eval(g, lambda v: 255 if v == 0 else 0))
    hit = Image.composite(hit, Image.new('L', (w, h), 0), Image.eval(b, lambda v: 255 if v == 255 else 0))
    keep = Image.eval(hit, lambda v: 255 - v)
    art.putalpha(Image.composite(art.getchannel('A'), Image.new('L', (w, h), 0), keep))
    return art


def transparent_outside(canvas):
    """True when the wrap's corners (outside the design) are fully transparent."""
    w, h = canvas.size
    return all(canvas.getpixel(c)[3] == 0 for c in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)])


def mug(design_art, area=AREA, box=(BOX_W, BOX_H), cx=CENTER_X):
    art = clear_background(design_art)
    bbox = art.getbbox()
    if bbox:
        art = art.crop(bbox)
    aw, ah = area
    scale = min(aw * box[0] / art.width, ah * box[1] / art.height)
    size = (max(1, round(art.width * scale)), max(1, round(art.height * scale)))
    art = art.resize(size, Image.LANCZOS)
    canvas = Image.new('RGBA', area, (0, 0, 0, 0))
    canvas.alpha_composite(art, (round(aw * cx - size[0] / 2), (ah - size[1]) // 2))
    return canvas


def main(root):
    out_dir = os.path.join(root, 'assets', 'mugs')
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, 'manifest.json')
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    sources = json.load(open(os.path.join(root, 'commerce-api', 'scripts', 'sticker-sources.json')))
    sources.update(live_designs())
    made, failed = [], []
    for design, art in sorted(sources.items()):
        entry = manifest.get(design)
        if entry and entry.get('art') == art and entry.get('layout') == LAYOUT:
            continue
        try:
            preview = Image.open(io.BytesIO(fetch(f'https://files.cdn.printful.com/files/{art[:3]}/{art}_preview.png'))).convert('RGBA')
            preview = preview.resize((preview.width * PREVIEW_SCALE, preview.height * PREVIEW_SCALE), Image.LANCZOS)
            wrap = mug(preview)
            if not transparent_outside(wrap):
                raise ValueError('wrap background is not transparent')
            buf = io.BytesIO(); wrap.save(buf, 'PNG', optimize=True); data = buf.getvalue()
            with open(os.path.join(out_dir, f'{design}.png'), 'wb') as f:
                f.write(data)
            manifest[design] = {'sha': hashlib.sha1(data).hexdigest(), 'w': AREA[0], 'h': AREA[1], 'art': art, 'layout': LAYOUT}
            made.append(design)
        except Exception as e:
            failed.append(f'{design}: {e}')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
    print(f'mugs made={len(made)} failed={len(failed)}')
    print('\n'.join(failed))
    make_black(out_dir, manifest)


def make_black(out_dir, manifest):
    """The black mug wraps, from each design's white wrap (already transparent, already the right artwork)."""
    black_dir = os.path.join(out_dir, 'black')
    os.makedirs(black_dir, exist_ok=True)
    path = os.path.join(black_dir, 'manifest.json')
    black = json.load(open(path)) if os.path.exists(path) else {}
    made, failed = [], []
    for design, entry in sorted(manifest.items()):
        have = black.get(design)
        if have and have.get('from') == entry.get('sha') and have.get('layout') == BLACK_LAYOUT:
            continue
        try:
            white = Image.open(os.path.join(out_dir, f'{design}.png')).convert('RGBA')
            wrap = mug(white, BLACK_AREA, (BLACK_W, BLACK_H), BLACK_CX)
            if not transparent_outside(wrap):
                raise ValueError('wrap background is not transparent')
            buf = io.BytesIO(); wrap.save(buf, 'PNG', optimize=True); data = buf.getvalue()
            with open(os.path.join(black_dir, f'{design}.png'), 'wb') as f:
                f.write(data)
            black[design] = {'sha': hashlib.sha1(data).hexdigest(), 'w': BLACK_AREA[0], 'h': BLACK_AREA[1], 'from': entry.get('sha'), 'layout': BLACK_LAYOUT}
            made.append(design)
        except Exception as e:
            failed.append(f'{design}: {e}')
    with open(path, 'w') as f:
        json.dump(black, f, indent=1, sort_keys=True)
    print(f'black mugs made={len(made)} failed={len(failed)}')
    print('\n'.join(failed))


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == '--black-only':
        out = os.path.join(sys.argv[1], 'assets', 'mugs')
        make_black(out, json.load(open(os.path.join(out, 'manifest.json'))))
    else:
        main(sys.argv[1])
