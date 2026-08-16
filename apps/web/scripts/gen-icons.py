#!/usr/bin/env python3
"""Generate OddKet PWA icons (PNG) from the app's visual identity.

Run from apps/web:  python3 scripts/gen-icons.py
Requires Pillow. Uses DejaVu Sans Bold when available; falls back to the
built-in bitmap font otherwise (icons will look chunkier).

Writes:
  public/icons/icon-192.png            (rounded corners)
  public/icons/icon-512.png            (rounded corners)
  public/icons/maskable-512.png        (full-bleed, safe-zone aware)
  public/icons/apple-touch-icon.png    (180px, rounded corners)
  app/icon.png                         (64px favicon for the Next app router)
"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "icons")
FAVICON = os.path.join(ROOT, "app", "icon.png")

INK_950 = (7, 10, 15)     # ink-950
INK_900 = (11, 16, 24)    # ink-900
INK_850 = (14, 21, 32)    # ink-850
EMERALD = (52, 211, 153)  # edge-green

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    for p in FONTS:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def render(size: int, mask_corners: bool = True) -> Image.Image:
    S = 1024  # supersampled master, downscaled for crisp edges

    # Vertical gradient: ink-900 (top) -> ink-950 (bottom)
    bg = Image.new("RGB", (1, S))
    for y in range(S):
        bg.putpixel((0, y), lerp(INK_900, INK_950, y / (S - 1)))
    img = bg.resize((S, S)).convert("RGBA")

    # Soft emerald glow, top-center
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [S * 0.18, -S * 0.15, S * 0.82, S * 0.60], fill=EMERALD + (38,)
    )
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.14))
    img = Image.alpha_composite(img, glow)

    d = ImageDraw.Draw(img)

    # Rounded-square tile, centered (62% of canvas — well inside the 80%
    # maskable safe zone, so the same master works for both purposes).
    tile = int(S * 0.62)
    x0 = (S - tile) // 2
    y0 = (S - tile) // 2
    d.rounded_rectangle(
        [x0, y0, x0 + tile, y0 + tile],
        radius=int(tile * 0.235),
        fill=INK_850 + (255,),
        outline=EMERALD + (110,),
        width=max(5, S // 192),
    )

    # Bold "K" glyph, matching the in-app header mark
    f = font(int(S * 0.34))
    bb = d.textbbox((0, 0), "K", font=f)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    d.text(
        ((S - w) / 2 - bb[0], (S - h) / 2 - bb[1] - S * 0.02),
        "K",
        font=f,
        fill=EMERALD + (255,),
    )

    img = img.resize((size, size), Image.LANCZOS)
    if mask_corners:
        img.putalpha(rounded_mask(size, int(size * 0.22)))
    return img


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, True),
        ("icon-512.png", 512, True),
        ("maskable-512.png", 512, False),
        ("apple-touch-icon.png", 180, True),
    ]
    for name, size, mask in jobs:
        render(size, mask).save(os.path.join(OUT, name))
        print(f"wrote {OUT}/{name} ({size}x{size})")
    render(64, True).save(FAVICON)
    print(f"wrote {FAVICON} (64x64 favicon)")


if __name__ == "__main__":
    main()
