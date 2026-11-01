"""Builds one-piece sticker artwork for every live design (owner, Nov 1, 2026). Run by .github/workflows/sticker-art.yml.

    python3 make_stickers.py <site root> [originals dir]

Designs: commerce-api/scripts/sticker-sources.json ({design id: Printful artwork hash}) plus the live product list
(/api/products, each design's "art" hash), so new designs are picked up on their own.
Artwork: the full-size original when one in [originals dir] (Nino's T-Shirt Designs folder, downloaded by the
workflow) shows the same picture as the design's Printful preview; otherwise Printful's public 800 px preview, enlarged
(fine for the 3in and 4in sizes; such designs are marked src="preview" in the manifest so they can be upgraded).
Output: assets/stickers/<design id>.png and assets/stickers/manifest.json
    {"<design id>": {"sha": <sha1 of the png>, "w": px, "h": px, "art": <Printful hash>, "src": "original"|"preview"}}
A design is rebuilt only when its Printful artwork changed or a better source turned up.
"""
import hashlib, io, json, os, sys, urllib.request
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from sticker_backing import backing, pieces_after, holes_after

API = os.environ.get('API_BASE', 'https://nino-printful-commerce-api.ijpbattaglia.workers.dev')
MAX_SIDE = 2400          # 5.5in at ~300 dpi with room for the border; also covers the 3.75in bumper height
PREVIEW_SCALE = 2        # a preview (800 px) is enlarged to 1600 px
MATCH_MAX = 14.0         # mean difference (0-255) of the 32x32 signatures for a preview and an original to count as one


def fetch(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'nino-sticker-art'}), timeout=timeout) as r:
        return r.read()


def signature(image):
    """32x32 picture of the artwork over mid-gray, plus its aspect ratio."""
    im = image.convert('RGBA')
    bg = Image.new('RGBA', im.size, (128, 128, 128, 255))
    bg.alpha_composite(im)
    return np.asarray(bg.convert('RGB').resize((32, 32), Image.BILINEAR), dtype=np.float32), im.width / im.height


def distance(a, b):
    (pa, ra), (pb, rb) = a, b
    if abs(ra - rb) / max(ra, rb) > 0.03:
        return 999.0
    return float(np.abs(pa - pb).mean())


def load_originals(folder):
    out = []
    if not folder or not os.path.isdir(folder):
        return out
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        try:
            with Image.open(path) as im:
                im.draft('RGBA', (512, 512))
                small = im.convert('RGBA'); small.thumbnail((512, 512))
                out.append((path, signature(small)))
        except Exception as e:  # not an image
            print(f'skip {name}: {e}')
    return out


def live_designs():
    try:
        body = json.loads(fetch(f'{API}/api/products'))
    except Exception as e:
        print(f'product list unavailable: {e}')
        return {}
    out = {}
    for p in body.get('products', []):
        ext = str(p.get('external_id') or '')
        if not ext.startswith('nx-') and p.get('art'):
            out[str(p['id'])] = p['art']
    return out


def main(root, originals_dir=None):
    out_dir = os.path.join(root, 'assets', 'stickers')
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, 'manifest.json')
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    sources = json.load(open(os.path.join(root, 'commerce-api', 'scripts', 'sticker-sources.json')))
    sources.update(live_designs())
    originals = load_originals(originals_dir)
    print(f'{len(sources)} designs, {len(originals)} originals, {len(manifest)} already made')
    made, failed = [], []
    for design, art in sorted(sources.items()):
        entry = manifest.get(design)
        if entry and entry.get('art') == art and (entry.get('src') == 'original' or not originals):
            continue
        try:
            preview = Image.open(io.BytesIO(fetch(f'https://files.cdn.printful.com/files/{art[:3]}/{art}_preview.png')))
            sig = signature(preview)
            best, best_d = None, 999.0
            for path, osig in originals:
                d = distance(sig, osig)
                if d < best_d:
                    best, best_d = path, d
            if best and best_d <= MATCH_MAX:
                source, src = Image.open(best).convert('RGBA'), 'original'
            else:
                if entry and entry.get('art') == art:
                    continue          # no better source than what it already has
                source, src = preview.convert('RGBA'), 'preview'
                source = source.resize((source.width * PREVIEW_SCALE, source.height * PREVIEW_SCALE), Image.LANCZOS)
            if max(source.size) > MAX_SIDE:
                source.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
            result = backing(source)
            assert pieces_after(result) == 1 and holes_after(result) == 0
            buf = io.BytesIO(); result.save(buf, 'PNG', optimize=True); data = buf.getvalue()
            with open(os.path.join(out_dir, f'{design}.png'), 'wb') as f:
                f.write(data)
            manifest[design] = {'sha': hashlib.sha1(data).hexdigest(), 'w': result.width, 'h': result.height, 'art': art, 'src': src}
            made.append(f'{design} {src}' + (f' ({os.path.basename(best)}, {best_d:.1f})' if src == 'original' else f' (best {best_d:.1f})'))
        except Exception as e:
            failed.append(f'{design}: {e}')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
    print('\n'.join(['made:'] + made + ['failed:'] + failed))
    print(f'SUMMARY made={len(made)} failed={len(failed)} originals={sum(1 for v in manifest.values() if v["src"] == "original")} previews={sum(1 for v in manifest.values() if v["src"] == "preview")}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
