#!/usr/bin/env python3
"""Regenerates the tray state icons in ../icons/tray (needs Pillow).

Every state is the desktop app's brand mark (a note page with a waveform, see
`.brand-mark` in ui/index.html) so the tray reads as the same product:

  idle       the mark
  recording  the mark + red badge (the recording consent cue)
  attention  the mark + amber badge (recovered recordings waiting)

macOS gets monochrome *template* variants (black + alpha, waveform punched out)
so the system tints them for light/dark menu bars. Windows and Linux get the
brand-green tile, because a black glyph vanishes on a dark tray. Badges are
never templates, so recording stays red on macOS too.

Output is 44x44 (the @2x size of a 22 pt macOS menu-bar icon); the OS scales it
down for 1x displays and 16/24 px trays.
"""
import os
from PIL import Image, ImageDraw

SIZE = 44
SCALE = 8  # supersample for clean anti-aliased edges
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons", "tray")
BRAND = (23, 108, 75)
WHITE = (255, 255, 255)
RED = (229, 72, 77)
AMBER = (245, 166, 35)


def glyph(badge, template: bool) -> Image.Image:
    big = SIZE * SCALE
    u = big / 48  # the brand mark is drawn on a 48-unit grid
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def rect(x0, y0, x1, y1, fill, r=0):
        draw.rounded_rectangle([x0 * u, y0 * u, x1 * u, y1 * u], radius=r * u, fill=fill)

    if template:
        # Silhouette of the page (folded corner cut), waveform punched out.
        page = [(12, 9), (27, 9), (36, 18), (36, 39), (12, 39)]
        draw.polygon([(x * u, y * u) for x, y in page], fill=(0, 0, 0, 255))
        ink = (0, 0, 0, 0)
    else:
        rect(0, 0, 48, 48, BRAND + (255,), 14)
        page = [(12, 9), (27, 9), (36, 18), (36, 39), (12, 39)]
        draw.polygon([(x * u, y * u) for x, y in page], fill=WHITE + (255,))
        ink = BRAND + (255,)
    for x0, y0, x1, y1 in ((18, 25, 21, 33), (23, 21, 26, 37), (28, 24, 31, 34)):
        rect(x0, y0, x1, y1, ink, 1.5)
    if badge:
        cx, cy, r = 38 * u, 10 * u, 8 * u
        # A transparent halo separates the badge from the mark at small sizes.
        draw.ellipse([cx - r - 2 * u, cy - r - 2 * u, cx + r + 2 * u, cy + r + 2 * u], fill=(0, 0, 0, 0))
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=badge + (255,))
    return image.resize((SIZE, SIZE), Image.LANCZOS)


VARIANTS = {
    "tray-idle-template.png": (None, True),
    "tray-attention-template.png": (AMBER, True),
    "tray-idle.png": (None, False),
    "tray-attention.png": (AMBER, False),
    "tray-recording.png": (RED, False),
}

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, (badge, template) in VARIANTS.items():
        glyph(badge, template).save(os.path.join(OUT, name), optimize=True)
        print("wrote", name)
