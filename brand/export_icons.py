"""Exports every icon size from the SVGs made by make_icon.py.

Renders with headless Chrome (exact SVG rendering, no extra tools) and resizes
with Pillow. Run from anywhere: python3 brand/export_icons.py
"""
import json
import pathlib
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
BRAND = ROOT / 'brand'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def render(svg: pathlib.Path, transparent: bool) -> Image.Image:
    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d) / 'out.png'
        args = [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1024,1024', f'--screenshot={out}']
        if transparent:
            args.append('--default-background-color=00000000')
        subprocess.run(args + [svg.as_uri()], check=True, capture_output=True)
        return Image.open(out).convert('RGBA' if transparent else 'RGB').copy()


def resized(im: Image.Image, size: int) -> Image.Image:
    return im.resize((size, size), Image.LANCZOS)


def rounded(im: Image.Image, size: int, radius=0.22, scale=1.0) -> Image.Image:
    """The icon on a rounded tile with transparent corners."""
    tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    inner = round(size * scale)
    mask = Image.new('L', (inner, inner), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner - 1, inner - 1], radius=round(inner * radius), fill=255)
    off = (size - inner) // 2
    tile.paste(resized(im, inner).convert('RGBA'), (off, off), mask)
    return tile


def centred(mark: Image.Image, size: int, scale: float) -> Image.Image:
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    inner = round(size * scale)
    off = (size - inner) // 2
    canvas.alpha_composite(resized(mark, inner), (off, off))
    return canvas


icon = render(BRAND / 'argus-icon.svg', transparent=False)   # full-bleed square, no alpha
mark = render(BRAND / 'argus-mark.svg', transparent=True)    # the head alone

# iOS: every size listed in the asset catalogue (App Store icons must not have alpha).
ios = ROOT / 'app/ios/Runner/Assets.xcassets/AppIcon.appiconset'
for img in json.loads((ios / 'Contents.json').read_text())['images']:
    px = round(float(img['size'].split('x')[0]) * int(img['scale'][0]))
    resized(icon, px).save(ios / img['filename'])

# Android: adaptive icon (API 26+) = gradient background + the head inside the 66 dp safe zone,
# and a rounded tile for older launchers.
res = ROOT / 'app/android/app/src/main/res'
for folder, dp in {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}.items():
    d = res / f'mipmap-{folder}'
    d.mkdir(exist_ok=True)
    rounded(icon, round(48 * dp), scale=0.92).save(d / 'ic_launcher.png')
    centred(mark, round(108 * dp), scale=0.76).save(d / 'ic_launcher_foreground.png')

# Web: favicon, home-screen icon and the brand mark next to "Argus".
pub = ROOT / 'web/public'
pub.mkdir(exist_ok=True)
rounded(icon, 64, scale=1.0).save(pub / 'favicon.png')
resized(icon, 180).save(pub / 'apple-touch-icon.png')
resized(icon, 128).save(pub / 'argus-icon-128.png')

# App: the logo inside the Flutter app (sign-in screen, app bar).
(ROOT / 'app/assets').mkdir(exist_ok=True)
resized(icon, 256).save(ROOT / 'app/assets/argus-icon.png')

# Google's sign-in consent screen (120 x 120).
resized(icon, 120).save(BRAND / 'argus-google-120.png')
resized(icon, 1024).save(BRAND / 'argus-icon-1024.png')
print('exported')
