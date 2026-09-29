#!/usr/bin/env python3
"""Render the AI Notetaker mark into the extension and desktop icon formats.

The canonical shape and colors live in branding/ai-notetaker-mark.svg. This
small Pillow renderer mirrors that simple geometry so release builds do not
need an SVG service or network dependency.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MARK = ROOT / "branding" / "ai-notetaker-mark.svg"
GREEN = (23, 108, 75, 255)
WHITE = (255, 255, 255, 255)
MINT = (204, 235, 217, 255)


def render(size: int) -> Image.Image:
    scale = 4
    n = size * scale
    image = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def px(value: int) -> int:
        return round(value / 48 * n)

    draw.rounded_rectangle((0, 0, n - 1, n - 1), radius=px(14), fill=GREEN)
    # A folded note sheet, with a clear audio waveform at toolbar size.
    draw.rounded_rectangle((px(12), px(9), px(35), px(39)), radius=px(3), fill=WHITE)
    draw.polygon([(px(27), px(9)), (px(35), px(17)), (px(27), px(17))], fill=MINT)
    for x, top, bottom in ((18, 25, 33), (23, 21, 37), (28, 24, 34)):
        draw.rounded_rectangle((px(x), px(top), px(x + 2), px(bottom)), radius=px(1), fill=GREEN)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    mark = MARK.read_bytes()
    for path in (
        ROOT / "site" / "favicon.svg",
        ROOT / "site" / "icons" / "ai-notetaker-mark.svg",
        ROOT / "webapp" / "public" / "ai-notetaker-mark.svg",
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(mark)

    extension = ROOT / "extension" / "icons"
    desktop = ROOT / "helper" / "crates" / "app" / "icons"
    for size in (16, 32, 48, 64, 128, 256):
        icon = render(size)
        if size in (16, 48, 128):
            icon.save(extension / f"icon{size}.png", optimize=True)
        if size in (32, 128):
            icon.save(desktop / f"{size}x{size}.png", optimize=True)

    render(256).save(desktop / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    # Pillow's ICNS writer emits all useful macOS representations from the
    # high-resolution source image.
    render(1024).save(desktop / "icon.icns")


if __name__ == "__main__":
    main()
