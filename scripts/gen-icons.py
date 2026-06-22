#!/usr/bin/env python3
"""Generate Zeroed PWA / iOS icons.

Brand: ground #0A0A0A, signal #E8CC0A. The mark is the CONVERGENCE organism —
the app's true visual motif (see src/components/convergence/ConvergenceReticle).
Not a static gun-sight, but the wordmark made literal: a cloud of reads
streaming inward along the golden spiral and collapsing onto a glowing zero
point. Dim grey at the scattered edge, brightening to signal-yellow at the core
— the moment the read zeroes in, frozen.

The geometry reuses the component's math (golden angle + deterministic per-point
seed) so the icon IS the brand organism, not a lookalike.

Run: python3 scripts/gen-icons.py
Outputs PNGs into public/icons/ and public/apple-touch-icon.png.
"""
from PIL import Image, ImageDraw
import math
import os

GROUND = (10, 10, 10)        # #0A0A0A
SURFACE = (26, 26, 26)       # #1A1A1A
LINE = (42, 42, 42)          # #2A2A2A
DIM = (122, 122, 122)        # scattered-edge grey
SIGNAL = (232, 204, 10)      # #E8CC0A

ROOT = os.path.join(os.path.dirname(__file__), "..", "public")
ICON_DIR = os.path.join(ROOT, "icons")
os.makedirs(ICON_DIR, exist_ok=True)

GOLDEN = math.pi * (3 - math.sqrt(5))  # golden angle — matches the component


def seed(i):
    """Deterministic per-point seed in [0,1) — mirrors the React component so the
    icon renders the same organism every time (never Math.random / random)."""
    x = math.sin((i + 1) * 99.137) * 43758.5453
    return x - math.floor(x)


def lerp(a, b, t):
    return tuple(int(round(a[k] + (b[k] - a[k]) * t)) for k in range(len(a)))


def draw_convergence(size, maskable=False, bg=GROUND):
    """Render the convergence mark at the given pixel size."""
    ss = 4  # supersample for clean anti-aliased edges
    s = size * ss
    img = Image.new("RGBA", (s, s), bg + (255,))
    d = ImageDraw.Draw(img)

    cx = cy = s / 2
    # Maskable icons must sit inside the ~80% safe zone.
    content = 0.60 if maskable else 0.74
    maxR = s * content / 2
    coreR = maxR * 0.06

    # Point count scales with render size so small icons don't turn to mush.
    count = 34 if size >= 180 else (24 if size >= 96 else 14)

    # Faint crosshair frame — the reticle, barely there (the read's grid).
    frame = max(1, int(s * 0.004))
    reach = maxR * 1.04
    d.line([cx, cy - reach, cx, cy + reach], fill=LINE + (255,), width=frame)
    d.line([cx - reach, cy, cx + reach, cy], fill=LINE + (255,), width=frame)

    # Faint lock ring partway in — where the read is tightening.
    lockR = maxR * 0.5
    d.ellipse(
        [cx - lockR, cy - lockR, cx + lockR, cy + lockR],
        outline=lerp(LINE, SIGNAL, 0.25) + (110,),
        width=frame,
    )

    # The cloud collapsing inward. Each point's radius is a function of its index
    # (an even golden-spiral spread of radii) so they read as a TRAIL streaming
    # toward the core: dim + small + grey at the edge, bright + large + signal at
    # the center. Direction = energy = "zeroing in."
    for i in range(count):
        t = i / (count - 1)            # 0 = core, 1 = scattered edge
        ang = i * GOLDEN + seed(i) * 0.6
        r = coreR + (maxR - coreR) * t
        x = cx + r * math.cos(ang)
        y = cy + r * math.sin(ang)

        warmth = (1 - t) ** 1.3        # how "zeroed" this point reads
        color = lerp(DIM, SIGNAL, warmth)
        alpha = int(255 * (0.35 + 0.55 * warmth))
        pr = (s * 0.006) + (s * 0.013) * warmth   # bigger as it nears the core
        d.ellipse([x - pr, y - pr, x + pr, y + pr], fill=color + (alpha,))

    # The zero point — a glowing signal core. Soft halo, then a solid center.
    glowR = maxR * 0.20
    steps = 7
    for k in range(steps, 0, -1):
        gr = glowR * k / steps
        a = int(46 * (1 - (k - 1) / steps))
        d.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=SIGNAL + (a,))
    dot = max(coreR, s * 0.034)
    d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=SIGNAL + (255,))

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(ICON_DIR, name)
    img.convert("RGBA").save(path, "PNG")
    print("wrote", os.path.relpath(path, ROOT + "/.."))


# Standard PWA icons (opaque ground square)
save(draw_convergence(192), "icon-192.png")
save(draw_convergence(512), "icon-512.png")
# Maskable variant — mark sits inside safe zone, full-bleed ground.
save(draw_convergence(512, maskable=True), "icon-512-maskable.png")
save(draw_convergence(192, maskable=True), "icon-192-maskable.png")

# Apple touch icon — iOS ignores transparency / rounds corners itself.
# Must be opaque 180x180 on the brand ground.
apple = draw_convergence(180, bg=GROUND)
apple_path = os.path.join(ROOT, "apple-touch-icon.png")
apple.convert("RGB").save(apple_path, "PNG")
print("wrote", os.path.relpath(apple_path, ROOT + "/.."))

# Favicon
save(draw_convergence(32), "favicon-32.png")
fav = draw_convergence(32)
fav.save(os.path.join(ROOT, "favicon.ico"), sizes=[(32, 32), (16, 16)])
print("wrote public/favicon.ico")
