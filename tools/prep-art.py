#!/usr/bin/env python
"""Turn three loose character drawings into three interchangeable sprites.

    uv run --with pillow python tools/prep-art.py

Run once, or again whenever the art in `art-src/` changes. Nothing at runtime
depends on this; it just writes `img/`.

The site swaps one <img> in place to change the robot's mood, so the three files
have to be registered to each other or the character visibly hops when the bot's
state changes. They arrive not registered: the canvases differ (1254x1254,
1233x1275, 1254x1254) and `sweating` has no alpha channel at all, it is drawn on
solid white.

Alignment anchors on the **feet**, not on the bounding box. `holding` raises a fist,
which pushes its bbox up and to the right, so centring boxes would shove the body
left in that one pose. The horizontal centroid of the bottom sliver of ink is the
body's real centre line no matter what the arms are doing.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / "art-src", ROOT / "img"
POSES = ("waiting", "holding", "sweating")

WHITE_CUT = 246        # >= this on all channels, near the edges, reads as background
SOFT_CUT = 198       # below this it is drawing, not a blend with the background
ALPHA_FLOOR = 24       # ignore near-transparent dust when measuring
FOOT_SLICE = 0.08      # bottom 8% of the figure is feet
TARGET_H = 900         # tallest pose ends up this tall
PAD = 0.04             # breathing room around the union of all three
WEBP_QUALITY = 88


def load(name):
    im = Image.open(SRC / f"{name}.png").convert("RGBA")
    return im if has_alpha(im) else key_white(im)


def has_alpha(im):
    lo, hi = im.getchannel("A").getextrema()
    return lo < 250          # a real alpha channel has transparent pixels in it


def key_white(im):
    """Flood the white background to transparent from the edges inward, then feather.

    Deliberately a flood rather than a global "every white pixel goes": this
    character has white highlights on its shell and glints on the screen glass, and
    a global key punches holes straight through them. Flooding only reaches white
    that is connected to the border.

    The flood alone is not enough. It stops at the first pixel below `WHITE_CUT`,
    which leaves the drawing's anti-aliased rim, roughly luminance 200-245, fully
    opaque. Against this page's near-black background that rim reads as a bright
    halo tracing the whole silhouette. `feather` ramps those edge pixels back down.
    """
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    stack = [(x, y) for x in range(w) for y in (0, h - 1)]
    stack += [(x, y) for y in range(h) for x in (0, w - 1)]

    while stack:
        x, y = stack.pop()
        if not (0 <= x < w and 0 <= y < h) or seen[y * w + x]:
            continue
        r, g, b, a = px[x, y]
        if not (r >= WHITE_CUT and g >= WHITE_CUT and b >= WHITE_CUT):
            continue
        seen[y * w + x] = 1
        px[x, y] = (r, g, b, 0)
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return feather(im)


def feather(im, passes=3):
    """Fade the near-white rim the flood left behind, one ring per pass.

    Only pixels touching transparency are touched, so interior white highlights are
    never reached. A pixel's new alpha is how far its luminance sits below
    `WHITE_CUT` on the way to `SOFT_CUT`, which is a decent stand-in for the
    coverage it originally had over the white it was blended with.
    """
    import numpy as np

    a = np.array(im.getchannel("A"), dtype=np.int16)
    lum = np.array(im.convert("L"), dtype=np.int16)
    span = max(1, WHITE_CUT - SOFT_CUT)

    for _ in range(passes):
        solid = a > 0
        pad = np.pad(~solid, 1, constant_values=True)
        touching = (pad[:-2, 1:-1] | pad[2:, 1:-1] |
                    pad[1:-1, :-2] | pad[1:-1, 2:]) & solid
        edge = touching & (lum > SOFT_CUT)
        if not edge.any():
            break
        ramp = np.clip((WHITE_CUT - lum) * 255 // span, 0, 255)
        a = np.where(edge, np.minimum(a, ramp), a)

    im.putalpha(Image.fromarray(a.astype(np.uint8)))
    return im


def ink_box(im):
    """Bounding box of pixels that are actually opaque enough to see."""
    return im.getchannel("A").point(lambda v: 255 if v >= ALPHA_FLOOR else 0).getbbox()


def feet_centre(im, box):
    """Horizontal centroid of the bottom sliver of the figure."""
    left, top, right, bottom = box
    slice_top = int(bottom - (bottom - top) * FOOT_SLICE)
    a = im.getchannel("A").crop((left, slice_top, right, bottom))
    w, h = a.size
    data = a.load()
    total = weighted = 0
    for y in range(h):
        for x in range(w):
            v = data[x, y]
            if v >= ALPHA_FLOOR:
                total += v
                weighted += v * x
    return left + (weighted / total if total else w / 2)


def main():
    figures = []
    for name in POSES:
        im = load(name)
        box = ink_box(im)
        if box is None:
            sys.exit(f"{name}: no visible pixels after keying, check WHITE_CUT")
        figures.append({"name": name, "im": im, "box": box,
                        "cx": feet_centre(im, box)})

    # One scale for all three, set by the tallest figure, so nobody gets resized
    # relative to anyone else.
    scale = TARGET_H / max(f["box"][3] - f["box"][1] for f in figures)

    # Canvas big enough for the widest reach either side of the feet line and the
    # tallest figure above it.
    left_reach = max(f["cx"] - f["box"][0] for f in figures) * scale
    right_reach = max(f["box"][2] - f["cx"] for f in figures) * scale
    height = max(f["box"][3] - f["box"][1] for f in figures) * scale
    pad_x, pad_y = (left_reach + right_reach) * PAD, height * PAD
    cw = int(left_reach + right_reach + pad_x * 2)
    ch = int(height + pad_y * 2)
    anchor_x, anchor_y = int(left_reach + pad_x), int(ch - pad_y)

    OUT.mkdir(exist_ok=True)
    for f in figures:
        left, top, right, bottom = f["box"]
        crop = f["im"].crop(f["box"])
        crop = crop.resize((max(1, round((right - left) * scale)),
                            max(1, round((bottom - top) * scale))), Image.LANCZOS)
        canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        canvas.paste(crop, (anchor_x - round((f["cx"] - left) * scale),
                            anchor_y - crop.height), crop)
        path = OUT / f"{f['name']}.webp"
        canvas.save(path, "WEBP", quality=WEBP_QUALITY, method=6)
        print(f"{f['name']:9s} {cw}x{ch}  {path.stat().st_size // 1024} KB")
        f["canvas"] = canvas

    poses = {f["name"]: f["canvas"] for f in figures}
    icons(poses["waiting"])
    social(poses["holding"])
    palette(figures[0]["im"])


def icons(canvas):
    """Favicon from a head crop. The robot's face is the recognisable part, and the
    whole figure at 32px is an unreadable smudge."""
    box = ink_box(canvas)
    left, top, right, bottom = box
    head = canvas.crop((left, top, right, top + int((bottom - top) * 0.52)))
    side = max(head.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(head, ((side - head.width) // 2, (side - head.height) // 2), head)
    square.resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png")
    square.resize((64, 64), Image.LANCZOS).save(OUT / "favicon.png")
    print("icons      favicon.png, apple-touch-icon.png")


def social(canvas):
    """The 1200x630 card that shows up when the link is pasted somewhere.

    Composed here rather than hand-made, so it can never drift from the character.
    Flat background, the robot bled off the right, and nothing else — the title and
    description come from the meta tags, so text baked into the image would only
    duplicate them at a size nobody can read in a chat preview.
    """
    W, H, BG = 1200, 630, (0x12, 0x10, 0x0E)
    card = Image.new("RGB", (W, H), BG)

    box = ink_box(canvas)
    fig = canvas.crop(box)
    scale = (H * 1.06) / fig.height
    fig = fig.resize((round(fig.width * scale), round(fig.height * scale)), Image.LANCZOS)
    card.paste(fig, (int(W * 0.60), H - fig.height + int(H * 0.03)), fig)

    # The same dot grid the page uses, so the card and the site look related.
    dots = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = dots.load()
    for yy in range(0, H, 22):
        for xx in range(0, W, 22):
            d[xx, yy] = (255, 255, 255, 12)
    card = Image.alpha_composite(card.convert("RGBA"), dots).convert("RGB")

    # The wordmark. A card that is 60% empty background reads as a broken crop, and
    # the preview's own title text sits *below* the image, not on it.
    draw = ImageDraw.Draw(card)
    big, small = _font(78), _font(26)
    draw.text((78, 236), "cryptoBro", font=big, fill=(0xE4, 0xD8, 0xC0))
    draw.text((82, 336), "a trading bot, on paper money,", font=small, fill=(0x94, 0x89, 0x7A))
    draw.text((82, 372), "showing its work", font=small, fill=(0x94, 0x89, 0x7A))
    draw.line((80, 196, 80 + 46, 196), fill=(0xFF, 0xB4, 0x3C), width=5)

    card.save(OUT / "og.png", optimize=True)
    print(f"social     og.png  {(OUT / 'og.png').stat().st_size // 1024} KB")


def _font(size):
    """Menlo, to match the page's monospace numerals. Falls back rather than dying:
    a missing system font should cost the card its typography, not the whole run."""
    for path in ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def palette(im, n=14):
    """Print the art's dominant colours, so the CSS is sampled rather than guessed.

    Opaque pixels only, and quantised: sampling raw RGBA counts transparent black as
    the overwhelming winner and reports the background as the brand colour.
    """
    from collections import Counter

    small = im.resize((160, 160))
    hits = Counter((r // 12 * 12, g // 12 * 12, b // 12 * 12)
                   for r, g, b, a in small.get_flattened_data() if a > 200)
    print("\npalette (opaque pixels, quantised):")
    for (r, g, b), count in hits.most_common(n):
        print(f"  #{r:02X}{g:02X}{b:02X}  {count}")


if __name__ == "__main__":
    main()
