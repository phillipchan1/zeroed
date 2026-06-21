#!/usr/bin/env python3
"""Generate Zeroed PWA / iOS icons.

Brand: ground #0A0A0A, signal #E8CC0A. The mark is a convergence reticle —
the app's core visual motif: a ring with a crosshair converging on center.

Run: python3 scripts/gen-icons.py
Outputs PNGs into public/icons/ and public/apple-touch-icon.png.
"""
from PIL import Image, ImageDraw
import os

GROUND = (10, 10, 10)        # #0A0A0A
SURFACE = (26, 26, 26)       # #1A1A1A
SIGNAL = (232, 204, 10)      # #E8CC0A

ROOT = os.path.join(os.path.dirname(__file__), "..", "public")
ICON_DIR = os.path.join(ROOT, "icons")
os.makedirs(ICON_DIR, exist_ok=True)


def draw_reticle(size, maskable=False, bg=GROUND):
    """Render the convergence-reticle mark at the given pixel size."""
    # Supersample for clean anti-aliased edges.
    ss = 4
    s = size * ss
    img = Image.new("RGBA", (s, s), bg + (255,))
    d = ImageDraw.Draw(img)

    cx = cy = s / 2
    # Maskable icons need the mark inside the ~80% safe zone.
    content = 0.62 if maskable else 0.74
    radius = s * content / 2
    stroke = max(2, int(s * 0.035))

    # Outer ring
    d.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        outline=SIGNAL,
        width=stroke,
    )

    # Crosshair ticks converging toward center (not crossing it).
    tick_outer = radius * 1.0
    tick_inner = radius * 0.34
    gap = radius * 0.18  # gap from outer ring start
    for dx, dy in [(0, -1), (0, 1), (-1, 0), (1, 0)]:
        x1 = cx + dx * (tick_outer - gap)
        y1 = cy + dy * (tick_outer - gap)
        x2 = cx + dx * tick_inner
        y2 = cy + dy * tick_inner
        d.line([x1, y1, x2, y2], fill=SIGNAL, width=stroke)

    # Center convergence dot
    dot = radius * 0.12
    d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=SIGNAL)

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(ICON_DIR, name)
    img.convert("RGBA").save(path, "PNG")
    print("wrote", os.path.relpath(path, ROOT + "/.."))


# Standard PWA icons (transparent-ground square)
save(draw_reticle(192), "icon-192.png")
save(draw_reticle(512), "icon-512.png")
# Maskable variant — mark sits inside safe zone, full-bleed ground.
save(draw_reticle(512, maskable=True), "icon-512-maskable.png")
save(draw_reticle(192, maskable=True), "icon-192-maskable.png")

# Apple touch icon — iOS ignores transparency / rounds corners itself.
# Must be opaque 180x180 on the brand ground.
apple = draw_reticle(180, bg=GROUND)
apple_path = os.path.join(ROOT, "apple-touch-icon.png")
apple.convert("RGB").save(apple_path, "PNG")
print("wrote", os.path.relpath(apple_path, ROOT + "/.."))

# Favicon
save(draw_reticle(32), "favicon-32.png")
fav = draw_reticle(32)
fav.save(os.path.join(ROOT, "favicon.ico"), sizes=[(32, 32), (16, 16)])
print("wrote public/favicon.ico")
