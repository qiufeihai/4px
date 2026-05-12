from pathlib import Path
import os
import shutil
import subprocess
from PIL import Image, ImageDraw, ImageFont


_env_root = os.environ.get("FOURPX_GUI_ROOT")
ROOT = Path(_env_root).expanduser().resolve() if _env_root else Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
APPICON_PNG = BUILD_DIR / "appicon.png"
ICONSET_DIR = BUILD_DIR / "appicon.iconset"
ICNS_FILE = BUILD_DIR / "appicon.icns"


def draw_appicon(path: Path) -> None:
    size = 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bg = (255, 255, 255, 255)
    d.rectangle((0, 0, size, size), fill=bg)

    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, size - 1, size - 1), radius=200, fill=255)
    img.putalpha(mask)

    # New style: a single purple-pink gradient ring.
    outer = (120, 120, 904, 904)
    inner = (240, 240, 784, 784)
    start = (168, 94, 255, 255)   # purple
    end = (255, 116, 193, 255)    # pink
    steps = 60
    for i in range(steps):
        t = i / (steps - 1)
        r = int(start[0] + (end[0] - start[0]) * t)
        g = int(start[1] + (end[1] - start[1]) * t)
        b = int(start[2] + (end[2] - start[2]) * t)
        x0 = int(outer[0] + (inner[0] - outer[0]) * t)
        y0 = int(outer[1] + (inner[1] - outer[1]) * t)
        x1 = int(outer[2] + (inner[2] - outer[2]) * t)
        y1 = int(outer[3] + (inner[3] - outer[3]) * t)
        d.ellipse((x0, y0, x1, y1), fill=(r, g, b, 255))
    d.ellipse((300, 300, 724, 724), fill=(66, 40, 92, 255))

    font_path = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
    if os.path.exists(font_path):
        font_main = ImageFont.truetype(font_path, 268)
        font_sub = ImageFont.truetype(font_path, 232)
    else:
        font_main = ImageFont.load_default()
        font_sub = ImageFont.load_default()

    d.text((290, 346), "4", font=font_main, fill=(244, 248, 255, 255))
    d.text((448, 352), "px", font=font_sub, fill=(229, 242, 255, 255))

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")


def build_icns(appicon_png: Path) -> None:
    if ICONSET_DIR.exists():
        shutil.rmtree(ICONSET_DIR)
    ICONSET_DIR.mkdir(parents=True, exist_ok=True)

    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        out = ICONSET_DIR / f"icon_{sz}x{sz}.png"
        out2x = ICONSET_DIR / f"icon_{sz}x{sz}@2x.png"
        subprocess.run(["sips", "-z", str(sz), str(sz), str(appicon_png), "--out", str(out)], check=True)
        subprocess.run(["sips", "-z", str(sz * 2), str(sz * 2), str(appicon_png), "--out", str(out2x)], check=True)

    if ICNS_FILE.exists():
        ICNS_FILE.unlink()
    subprocess.run(["iconutil", "-c", "icns", str(ICONSET_DIR), "-o", str(ICNS_FILE)], check=True)


def main() -> None:
    draw_appicon(APPICON_PNG)
    try:
        build_icns(APPICON_PNG)
        print(f"generated: {APPICON_PNG} and {ICNS_FILE}")
    except Exception as e:
        print(f"generated: {APPICON_PNG} (icns skipped: {e})")


if __name__ == "__main__":
    main()
