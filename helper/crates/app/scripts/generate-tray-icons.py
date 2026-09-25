#!/usr/bin/env python3
"""Regenerates the tray state icons in ../icons/tray (needs Pillow).

Three states, drawn as simple geometric glyphs so they stay legible at 16-22 px:

  idle       ring
  recording  solid dot (red)
  attention  ring with a centre dot (amber)

macOS gets monochrome *template* variants (black + alpha) so the system tints
them for light/dark menu bars; Windows and Linux get coloured variants because
a black glyph vanishes on a dark tray. Recording is red everywhere, including
macOS, where it is deliberately NOT a template so it stays red.

Output is 44x44 (the @2x size of a 22 pt macOS menu-bar icon); the OS scales it
down for 1x displays and 16/24 px trays.
"""
import os
from PIL import Image, ImageDraw

SIZE = 44
SCALE = 8  # supersample for clean anti-aliased edges
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons", "tray")


def glyph(kind: str, rgb: tuple) -> Image.Image:
    big = SIZE * SCALE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    c = big / 2
    color = rgb + (255,)

    def disc(radius, fill):
        draw.ellipse([c - radius, c - radius, c + radius, c + radius], fill=fill)

    if kind == "recording":
        disc(big * 0.36, color)
    else:
        disc(big * 0.40, color)
        disc(big * 0.27, (0, 0, 0, 0))  # punch the ring's hole
        if kind == "attention":
            disc(big * 0.12, color)
    return image.resize((SIZE, SIZE), Image.LANCZOS)


VARIANTS = {
    "tray-idle-template.png": ("idle", (0, 0, 0)),
    "tray-attention-template.png": ("attention", (0, 0, 0)),
    "tray-idle.png": ("idle", (148, 155, 166)),
    "tray-attention.png": ("attention", (245, 166, 35)),
    "tray-recording.png": ("recording", (229, 72, 77)),
}

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, (kind, rgb) in VARIANTS.items():
        glyph(kind, rgb).save(os.path.join(OUT, name), optimize=True)
        print("wrote", name)
