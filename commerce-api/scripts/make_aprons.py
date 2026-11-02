"""Apron artwork for every live design (owner, Nov 2, 2026: "the image on the aprons is too large so they're cut off;
make them smaller and in the center towards the top"). Run by .github/workflows/sticker-art.yml after the stickers.

    python3 make_aprons.py <site root>

The apron (Printful 927, All-Over Print 5-Color Strap Apron) prints one file over the whole apron: its print file
is fill mode "cover", so Printful stretches any file to the full 4075 x 4961 px area and ignores the placement. Each
design is therefore drawn small, centered, on the upper chest of a transparent full-size apron file (the white apron
shows through). The worker (src/sticker-art.mjs, kind "apron") puts these files on the apron products.
Artwork: the design's one-piece-sticker source when it is an original, else Printful's 800 px preview, enlarged.
Output: assets/aprons/<design id>.png and assets/aprons/manifest.json
    {"<design id>": {"sha": <sha1 of the png>, "w": 4075, "h": 4961, "art": <Printful hash>, "layout": LAYOUT}}
"""
import hashlib, io, json, os, sys
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from make_stickers import fetch, live_designs, PREVIEW_SCALE

AREA = (4075, 4961)       # printfile 1381, 150 dpi (27.2 x 33.1 in)
# The design's box, as shares of the area: width, height, and the top edge. Centered left to right.
BOX_W, BOX_H, BOX_TOP = 0.44, 0.30, 0.21
LAYOUT = 'v1-0.44-0.30-0.21'   # change when the box changes: every apron is redrawn and re-applied


def apron(design_art):
    art = design_art.convert('RGBA')
    bbox = art.getbbox()
    if bbox:
        art = art.crop(bbox)
    aw, ah = AREA
    scale = min(aw * BOX_W / art.width, ah * BOX_H / art.height)
    size = (max(1, round(art.width * scale)), max(1, round(art.height * scale)))
    art = art.resize(size, Image.LANCZOS)
    canvas = Image.new('RGBA', AREA, (0, 0, 0, 0))
    canvas.alpha_composite(art, ((aw - size[0]) // 2, round(ah * BOX_TOP)))
    return canvas


def main(root):
    out_dir = os.path.join(root, 'assets', 'aprons')
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
            result = apron(preview)
            buf = io.BytesIO(); result.save(buf, 'PNG', optimize=True); data = buf.getvalue()
            with open(os.path.join(out_dir, f'{design}.png'), 'wb') as f:
                f.write(data)
            manifest[design] = {'sha': hashlib.sha1(data).hexdigest(), 'w': AREA[0], 'h': AREA[1], 'art': art, 'layout': LAYOUT}
            made.append(design)
        except Exception as e:
            failed.append(f'{design}: {e}')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
    print(f'aprons made={len(made)} failed={len(failed)}')
    print('\n'.join(failed))


if __name__ == '__main__':
    main(sys.argv[1])
