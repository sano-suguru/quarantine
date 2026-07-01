#!/usr/bin/env python3
"""
Post-process a raw generated sprite into a game-ready atlas PNG, mirroring the manual pipeline:
  1. ensure RGBA
  2. background -> transparent (trust the model's alpha if the corners are already clear;
     otherwise flood-key the border-connected background color with a tolerance)
  3. autocrop to the opaque bounding box
  4. NEAREST downscale so the longest side == TARGET (keeps pixel-art crispness)
  5. binarize alpha (>=128 -> 255 else 0) so NEAREST sampling has no semi-transparent fringe
  6. paste centered on a TARGET x TARGET transparent square (undistorted in the square draw quad)

Usage: python3 scripts/process-sprite.py <raw_in.png> <out.png> [target=128]
Requires Pillow (PIL). Called by scripts/gen-sprites.ts; also usable standalone on any raw image.
"""
import sys
from collections import deque

from PIL import Image

TARGET = int(sys.argv[3]) if len(sys.argv) > 3 else 128
BG_TOLERANCE = 32  # per-channel distance under which a border-connected pixel counts as background


def corners_transparent(im: Image.Image) -> bool:
    w, h = im.size
    px = im.load()
    return all(px[x, y][3] < 8 for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)))


def flood_key_background(im: Image.Image) -> Image.Image:
    """Make border-connected pixels near the corner color transparent (BFS flood from the edges)."""
    w, h = im.size
    px = im.load()
    r0, g0, b0, _ = px[0, 0]

    def is_bg(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return (
            a > 0
            and abs(r - r0) <= BG_TOLERANCE
            and abs(g - g0) <= BG_TOLERANCE
            and abs(b - b0) <= BG_TOLERANCE
        )

    seen = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            q.append((x, y))
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y][x]:
            continue
        seen[y][x] = True
        if not is_bg(x, y):
            continue
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return im


def main() -> None:
    raw_path, out_path = sys.argv[1], sys.argv[2]
    im = Image.open(raw_path).convert("RGBA")

    if not corners_transparent(im):
        im = flood_key_background(im)

    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)

    w, h = im.size
    scale = TARGET / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    small = im.resize((nw, nh), Image.NEAREST)

    r, g, b, a = small.split()
    a = a.point(lambda v: 255 if v >= 128 else 0)
    small = Image.merge("RGBA", (r, g, b, a))

    canvas = Image.new("RGBA", (TARGET, TARGET), (0, 0, 0, 0))
    canvas.paste(small, ((TARGET - nw) // 2, (TARGET - nh) // 2), small)
    canvas.save(out_path)
    print(f"processed {raw_path} -> {out_path}  ({w}x{h} -> art {nw}x{nh} on {TARGET}x{TARGET})")


if __name__ == "__main__":
    main()
