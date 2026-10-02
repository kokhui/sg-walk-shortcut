"""Render the 步行 promo video (1920x1080, 30 fps, H.264 MP4, no audio).

    python -m pip install --user pillow imageio-ffmpeg
    python tools/make_promo.py                # writes promo/buxing-promo.mp4 and promo/poster.png
    python tools/make_promo.py --preview 20   # just the frame at 20 s, as promo/preview.png

Frames are drawn with Pillow and piped straight into ffmpeg. The footage is real app screenshots in
promo/assets/ (captured from app.html at 1920x1080). Every number on screen comes from those runs; the
"road route" is the road-following OSRM / Valhalla routes shown next to 步行's in the same screenshot.
"""
import argparse
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "promo", "assets")
OUT = os.path.join(ROOT, "promo")
W, H, FPS = 1920, 1080, 30

BG = (15, 17, 21)
SURFACE = (23, 26, 32)
LINE = (42, 47, 55)
TEXT = (236, 238, 241)
MUTED = (160, 167, 177)
PINK = (240, 101, 149)
ROAD = (138, 145, 155)
GREEN = (81, 207, 102)
GREEN_SOFT = (23, 56, 35)
RAIN = (116, 192, 252)

FONT_DIR = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
_fonts = {}


def font(size, bold=True):
    key = (size, bold)
    if key not in _fonts:
        name = "msyhbd.ttc" if bold else "msyh.ttc"  # Microsoft YaHei: Chinese and Latin
        _fonts[key] = ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    return _fonts[key]


# ---------- timing helpers ----------
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def ramp(t, start, dur):
    return ease((t - start) / dur)


def fade(t, start, end, fin=0.5, fout=0.5):
    """1 inside [start, end], easing in and out at the edges."""
    return min(ramp(t, start, fin), 1 - ramp(t, end - fout, fout))


# ---------- drawing helpers ----------
def blend(c, a):
    return (c[0], c[1], c[2], int(255 * clamp(a)))


def text(layer, xy, s, size, color=TEXT, alpha=1.0, bold=True, anchor="la"):
    if alpha <= 0:
        return
    ImageDraw.Draw(layer).text(xy, s, font=font(size, bold), fill=blend(color, alpha), anchor=anchor)


def text_width(s, size, bold=True):
    return font(size, bold).getlength(s)


def wrap(s, size, max_w, bold=False):
    words, lines, cur = s.split(" "), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if text_width(trial, size, bold) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def rrect(layer, box, r, fill=None, outline=None, width=1, alpha=1.0):
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, r, fill=blend(fill, alpha) if fill else None,
                        outline=blend(outline, alpha) if outline else None, width=width)


def path_len(pts):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def partial(pts, frac):
    """The first `frac` of a polyline, by length."""
    target = path_len(pts) * clamp(frac)
    out = [pts[0]]
    for i in range(len(pts) - 1):
        seg = math.dist(pts[i], pts[i + 1])
        if target <= seg:
            k = target / seg if seg else 0
            out.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k))
            return out
        target -= seg
        out.append(pts[i + 1])
    return out


def polyline(layer, pts, color, width, alpha=1.0, dash=None):
    d = ImageDraw.Draw(layer)
    if len(pts) < 2:
        return
    if not dash:
        d.line(pts, fill=blend(color, alpha), width=width, joint="curve")
        for p in (pts[0], pts[-1]):
            d.ellipse((p[0] - width / 2, p[1] - width / 2, p[0] + width / 2, p[1] + width / 2), fill=blend(color, alpha))
        return
    on, off = dash
    pos, drawing, left = 0.0, True, on
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        seg = math.dist(a, b)
        s = 0.0
        while s < seg:
            step = min(left, seg - s)
            if drawing:
                p0 = (a[0] + (b[0] - a[0]) * s / seg, a[1] + (b[1] - a[1]) * s / seg)
                p1 = (a[0] + (b[0] - a[0]) * (s + step) / seg, a[1] + (b[1] - a[1]) * (s + step) / seg)
                d.line([p0, p1], fill=blend(color, alpha), width=width)
            s += step
            left -= step
            if left <= 1e-6:
                drawing = not drawing
                left = on if drawing else off
        pos += seg


def mark(layer, xy, ok, color, alpha=1.0, size=30):
    """A drawn tick (ok) or cross, centred on xy."""
    d = ImageDraw.Draw(layer)
    x, y = xy
    h = size / 2
    if ok:
        d.line([(x - h, y), (x - h / 3, y + h * 0.7), (x + h, y - h * 0.7)], fill=blend(color, alpha), width=7, joint="curve")
    else:
        d.line([(x - h * 0.7, y - h * 0.7), (x + h * 0.7, y + h * 0.7)], fill=blend(color, alpha), width=6)
        d.line([(x - h * 0.7, y + h * 0.7), (x + h * 0.7, y - h * 0.7)], fill=blend(color, alpha), width=6)


def pin(layer, xy, label, color, fg=(255, 255, 255), alpha=1.0, r=26):
    d = ImageDraw.Draw(layer)
    x, y = xy
    d.ellipse((x - r, y - r, x + r, y + r), fill=blend(color, alpha), outline=blend((255, 255, 255), alpha), width=4)
    text(layer, (x, y + 1), label, 26, fg, alpha, anchor="mm")


# ---------- footage ----------
_imgs = {}


def footage(name):
    if name not in _imgs:
        _imgs[name] = Image.open(os.path.join(ASSETS, name)).convert("RGB")
    return _imgs[name]


def ken_burns(name, t, start, dur, z0, z1, c0, c1):
    """Slow zoom/pan over a screenshot. c0/c1 are focus points as fractions of the image."""
    img = footage(name)
    k = ease((t - start) / dur)
    z = z0 + (z1 - z0) * k
    cx = (c0[0] + (c1[0] - c0[0]) * k) * img.width
    cy = (c0[1] + (c1[1] - c0[1]) * k) * img.height
    cw, ch = img.width / z, img.height / z
    x0 = clamp(cx - cw / 2, 0, img.width - cw)
    y0 = clamp(cy - ch / 2, 0, img.height - ch)
    return img.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))


def vignette():
    v = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(v)
    d.rectangle((0, H - 360, W, H), fill=210)
    d.rectangle((0, 0, W, 200), fill=150)
    v = v.filter(ImageFilter.GaussianBlur(120))
    shade = Image.new("RGBA", (W, H), BG + (0,))
    shade.putalpha(v)
    return shade


VIGNETTE = None


# ---------- the diagram used in the problem / solution scenes ----------
BLOCKS = [(560, 400, 720, 640), (880, 400, 1040, 640), (1200, 400, 1360, 640)]
A_PT, B_PT = (420, 520), (1500, 520)
AROUND = [A_PT, (420, 300), (1500, 300), B_PT]
THROUGH = [A_PT, B_PT]


def diagram(layer, t, show_through_from=None):
    d = ImageDraw.Draw(layer)
    # roads
    for x0, y0, x1, y1 in [(380, 280, 1540, 320), (380, 720, 1540, 760), (400, 280, 440, 760), (1480, 280, 1520, 760)]:
        d.rounded_rectangle((x0, y0, x1, y1), 20, fill=LINE + (255,))
    # HDB blocks
    for i, (x0, y0, x1, y1) in enumerate(BLOCKS):
        d.rounded_rectangle((x0, y0, x1, y1), 14, fill=GREEN_SOFT + (255,), outline=GREEN + (255,), width=4)
        text(layer, ((x0 + x1) / 2, y0 + 44), f"Blk {744 - i}", 30, GREEN, anchor="mm")
        # void deck: an opening along the ground floor
        d.rectangle((x0 + 4, 505, x1 - 4, 535), fill=(10, 30, 18, 255))
    return d


# ---------- scenes ----------
def scene_title(layer, t):
    a = fade(t, 0, 4.6, 0.6, 0.5)
    text(layer, (W / 2, 330), "两兄弟  presents", 40, MUTED, a * ramp(t, 0.2, 0.8), bold=False, anchor="mm")
    k = ramp(t, 0.6, 1.0)
    size = int(220 + 30 * (1 - k))
    text(layer, (W / 2, 520), "步行", size, TEXT, a * k, anchor="mm")
    ta = a * ramp(t, 1.5, 0.8)
    line1, line2 = "Walk the shortcut, ", "not the road."
    total = text_width(line1, 64) + text_width(line2, 64)
    x = W / 2 - total / 2
    text(layer, (x, 730), line1, 64, TEXT, ta, anchor="lm")
    text(layer, (x + text_width(line1, 64), 730), line2, 64, PINK, ta, anchor="lm")


def scene_problem(layer, t, t0=4.6, t1=11.6):
    a = fade(t, t0, t1, 0.5, 0.4)
    if a <= 0:
        return
    text(layer, (W / 2, 140), "Map apps walk you around the block.", 60, TEXT, a * ramp(t, t0 + 0.2, 0.6), anchor="mm")
    sub = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    diagram(sub, t)
    k = ramp(t, t0 + 1.0, 2.2)
    polyline(sub, partial(AROUND, k), ROAD, 16)
    pin(sub, A_PT, "A", (40, 44, 52))
    pin(sub, B_PT, "B", PINK)
    if k > 0.05:
        text(sub, (W / 2, 250), "road route: all the way around", 32, ROAD, ramp(t, t0 + 1.4, 0.6), bold=False, anchor="mm")
    sub.putalpha(sub.getchannel("A").point(lambda v: int(v * a)))
    layer.alpha_composite(sub)
    b = a * ramp(t, t0 + 3.4, 0.6)
    text(layer, (W / 2, 860), "Google Maps doesn't take shortcuts under walkable buildings.", 46, TEXT, b, anchor="mm")
    text(layer, (W / 2, 930), "HDB void decks, malls and linkways are left out, so the walk is longer than it needs to be.",
         32, MUTED, a * ramp(t, t0 + 4.4, 0.6), bold=False, anchor="mm")


def scene_solution(layer, t, t0=11.6, t1=17.4):
    a = fade(t, t0, t1, 0.4, 0.5)
    if a <= 0:
        return
    text(layer, (W / 2, 140), "步行 walks you through them.", 64, TEXT, a * ramp(t, t0 + 0.2, 0.6), anchor="mm")
    sub = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    diagram(sub, t)
    polyline(sub, AROUND, ROAD, 12, alpha=0.35)
    k = ramp(t, t0 + 0.9, 1.6)
    polyline(sub, partial(THROUGH, k), PINK, 16, dash=(34, 20))
    pin(sub, A_PT, "A", (40, 44, 52))
    pin(sub, B_PT, "B", PINK)
    text(sub, (W / 2, 680), "under the void decks", 34, PINK, ramp(t, t0 + 1.8, 0.6), anchor="mm")
    sub.putalpha(sub.getchannel("A").point(lambda v: int(v * a)))
    layer.alpha_composite(sub)
    text(layer, (W / 2, 880), "Void decks · malls · MRT stations · covered linkways", 44, TEXT, a * ramp(t, t0 + 2.6, 0.6), anchor="mm")


def stat_card(layer, t, start, title, road_km, road_min, our_km, our_min, saved, via, alpha):
    """Lower-third card: road route struck out, then 步行's number counting down to its value."""
    road = f"{road_km} km · {road_min} min"
    rw = text_width(road, 44)
    ox = 44 + max(516, rw + 70)          # x offset of 步行's column
    lo = float(our_km)
    width = ox + text_width(f"{lo:.2f} km", 72) + 18 + text_width(f"· {our_min} min", 40) + 50
    width = max(width, 44 + text_width(saved, 34) + 20 + text_width(via, 28, bold=False) + 50)
    x0, y0, x1, y1 = 80, 690, 80 + width, 1000
    rrect(layer, (x0, y0, x1, y1), 28, fill=SURFACE, outline=LINE, width=2, alpha=alpha * 0.96)
    text(layer, (x0 + 44, y0 + 50), title, 38, TEXT, alpha, anchor="lm")
    ka = ramp(t, start + 0.5, 0.5)
    text(layer, (x0 + 44, y0 + 120), "Road route", 28, MUTED, alpha * ka, bold=False, anchor="lm")
    text(layer, (x0 + 44, y0 + 170), road, 44, ROAD, alpha * ka, anchor="lm")
    strike = ramp(t, start + 1.3, 0.5)
    if strike > 0:
        ImageDraw.Draw(layer).line([(x0 + 40, y0 + 172), (x0 + 48 + rw * strike, y0 + 172)], fill=blend(PINK, alpha), width=5)
    kb = ramp(t, start + 1.6, 1.2)
    hi = float(road_km.split("–")[-1])
    shown = hi + (lo - hi) * kb
    text(layer, (x0 + ox, y0 + 120), "步行", 30, PINK, alpha * ramp(t, start + 1.6, 0.4), anchor="lm")
    text(layer, (x0 + ox, y0 + 176), f"{shown:.2f} km", 72, PINK, alpha * ramp(t, start + 1.6, 0.4), anchor="lm")
    text(layer, (x0 + ox + text_width(f"{lo:.2f} km", 72) + 18, y0 + 186), f"· {our_min} min", 40, TEXT,
         alpha * ramp(t, start + 2.8, 0.4), anchor="lm")
    kc = ramp(t, start + 3.0, 0.5)
    text(layer, (x0 + 44, y0 + 250), saved, 34, TEXT, alpha * kc, anchor="lm")
    text(layer, (x0 + 44 + text_width(saved, 34) + 20, y0 + 252), via, 28, MUTED, alpha * kc, bold=False, anchor="lm")


def footage_scene(frame, layer, t, t0, t1, name, zoom, caption, card, note=None):
    a = fade(t, t0, t1, 0.5, 0.5)
    if a <= 0:
        return
    shot = ken_burns(name, t, t0, t1 - t0, *zoom).convert("RGBA")
    shot.alpha_composite(VIGNETTE)
    shot.putalpha(int(255 * a))
    frame.alpha_composite(shot)
    text(layer, (80, 90), caption, 46, TEXT, a * ramp(t, t0 + 0.3, 0.5), anchor="lm")
    if card:
        stat_card(layer, t, alpha=a, **card)
    if note:
        nw = text_width(note, 22, bold=False)
        rrect(layer, (W / 2 - nw / 2 - 18, H - 62, W / 2 + nw / 2 + 18, H - 22), 12, fill=BG, alpha=a * 0.85)
        text(layer, (W / 2, H - 42), note, 22, MUTED, a, bold=False, anchor="mm")


def callout(layer, t, t0, t1, lines, box, accent, alpha_scale=1.0):
    a = fade(t, t0, t1, 0.5, 0.5) * alpha_scale
    if a <= 0:
        return
    x0, y0, x1, y1 = box
    rrect(layer, box, 26, fill=SURFACE, outline=accent, width=3, alpha=a * 0.96)
    ImageDraw.Draw(layer).rounded_rectangle((x0 + 44, y0 + 34, x0 + 52, y0 + 76), 4, fill=blend(accent, a))
    y = y0 + 56
    for i, (s, size, color, bold) in enumerate(lines):
        for ln in wrap(s, size, x1 - x0 - 88, bold):
            indent = 26 if i == 0 else 0
            text(layer, (x0 + 44 + indent, y), ln, size, color, a * ramp(t, t0 + 0.2 + i * 0.35, 0.5), bold=bold, anchor="lm")
            y += int(size * 1.45)
        y += 14


def scene_compare(layer, t, t0=41.2, t1=48.6):
    a = fade(t, t0, t1, 0.5, 0.5)
    if a <= 0:
        return
    text(layer, (W / 2, 120), "Same walk. Two ways to do it.", 60, TEXT, a * ramp(t, t0 + 0.1, 0.5), anchor="mm")
    cols = [(160, "Road-following route", "the way map apps like Google Maps walk", ROAD), (1000, "步行", "the way locals walk", PINK)]
    rows = [
        ("Goes around HDB blocks and malls", "Cuts through void decks, malls and linkways"),
        ("Longer walk, longer time", "Up to 370 m shorter on our test walks"),
        ("Directions by road name", "Plain-English steps, block by block, e.g. via the void deck of Blk 744"),
        ("No idea which parts are sheltered", "Rain warning + how much of the walk is under cover"),
    ]
    for ci, (x, head, sub, color) in enumerate(cols):
        ka = a * ramp(t, t0 + 0.4 + ci * 0.3, 0.5)
        rrect(layer, (x, 200, x + 760, 960), 30, fill=SURFACE, outline=color if ci else LINE, width=3 if ci else 2, alpha=ka * 0.95)
        text(layer, (x + 50, 270), head, 50, color if ci else TEXT, ka, anchor="lm")
        text(layer, (x + 50, 325), sub, 28, MUTED, ka, bold=False, anchor="lm")
        for ri, row in enumerate(rows):
            kr = a * ramp(t, t0 + 1.0 + ri * 0.45, 0.45)
            y = 420 + ri * 132
            mark(layer, (x + 66, y), bool(ci), PINK if ci else ROAD, kr)
            lines = wrap(row[ci], 32, 610, bold=bool(ci))
            for li, ln in enumerate(lines):
                text(layer, (x + 110, y + (li - (len(lines) - 1) / 2) * 44), ln, 32, TEXT if ci else MUTED, kr, bold=bool(ci), anchor="lm")
    text(layer, (W / 2, 1010), "Road routes measured with OSRM and Valhalla on OpenStreetMap, which follow roads and footpaths as Google Maps does. Results from our test walks.",
         22, MUTED, a * 0.9, bold=False, anchor="mm")


def scene_end(layer, t, t0=48.6, t1=54.0):
    a = fade(t, t0, t1, 0.6, 0.8)
    if a <= 0:
        return
    k = ramp(t, t0 + 0.2, 0.8)
    text(layer, (W / 2, 430), "步行", 200, TEXT, a * k, anchor="mm")
    line1, line2 = "Stop walking ", "around the block."
    total = text_width(line1, 60) + text_width(line2, 60)
    x = W / 2 - total / 2
    ta = a * ramp(t, t0 + 0.9, 0.6)
    text(layer, (x, 620), line1, 60, TEXT, ta, anchor="lm")
    text(layer, (x + text_width(line1, 60), 620), line2, 60, PINK, ta, anchor="lm")
    text(layer, (W / 2, 720), "Shorter walks through Singapore's void decks, malls and linkways.", 34, MUTED, a * ramp(t, t0 + 1.4, 0.6), bold=False, anchor="mm")
    text(layer, (W / 2, 860), "by 两兄弟", 40, TEXT, a * ramp(t, t0 + 1.9, 0.6), anchor="mm")


DURATION = 54.0


def render(t):
    frame = Image.new("RGBA", (W, H), BG + (255,))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    scene_title(layer, t)
    scene_problem(layer, t)
    scene_solution(layer, t)
    footage_scene(frame, layer, t, 17.4, 26.4, "lavender.png",
                  (1.0, 1.32, (0.40, 0.50), (0.36, 0.52)),
                  "CT Hub 2  →  Golden Mile Food Centre",
                  dict(start=17.4, title="Real route, real numbers", road_km="1.29", road_min=17, our_km="1.06", our_min=14,
                       saved="234 m shorter, 3 min saved", via="via Aperia Mall, ICA Services Centre, a void deck"),
                  note="Real 步行 screenshot. Road route: OSRM and Valhalla on OpenStreetMap.")
    footage_scene(frame, layer, t, 26.4, 33.6, "yishun.png",
                  (1.06, 1.36, (0.38, 0.52), (0.42, 0.56)),
                  "Yishun MRT  →  Chong Pang",
                  dict(start=26.4, title="Through 9 HDB void decks", road_km="1.39–1.50", road_min="18–19", our_km="1.13", our_min=15,
                       saved="Up to 370 m shorter", via="the shortcut the neighbours take"),
                  note="Real 步行 screenshot. Road routes: OSRM 1.39 km, Valhalla 1.50 km.")
    # Directions + rain: zoom into the app's side panel.
    footage_scene(frame, layer, t, 33.6, 41.2, "yishun_rain.png",
                  (1.0, 1.12, (0.62, 0.55), (0.66, 0.6)),
                  "Directions a local would give, and a rain check", None,
                  note="Example with a simulated thundery-showers forecast. 步行 reads NEA's live 2-hour forecast.")
    callout(layer, t, 34.2, 37.8, [
        ("Plain-English directions", 40, PINK, True),
        ('"Continue straight through the void decks of Blk 744, Blk 743, Blk 741 and Blk 740, about 250 m."', 34, TEXT, False),
    ], (80, 700, 1180, 950), PINK)
    callout(layer, t, 37.6, 41.2, [
        ("Rain coming? You’ll know.", 40, RAIN, True),
        ("Thundery showers forecast for Yishun. This walk is 62% sheltered. Same shortest route, just a heads-up.", 34, TEXT, False),
    ], (80, 700, 1180, 950), RAIN)
    scene_compare(layer, t)
    scene_end(layer, t)
    frame.alpha_composite(layer)
    return frame.convert("RGB")


def main():
    global VIGNETTE
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", type=float, help="render one frame at this time (s) to promo/preview.png")
    args = ap.parse_args()
    VIGNETTE = vignette()
    os.makedirs(OUT, exist_ok=True)
    if args.preview is not None:
        render(args.preview).save(os.path.join(OUT, "preview.png"))
        print("wrote promo/preview.png")
        return
    import imageio_ffmpeg
    out = os.path.join(OUT, "buxing-promo.mp4")
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    n = int(DURATION * FPS)
    for i in range(n):
        proc.stdin.write(render(i / FPS).tobytes())
        if i % (FPS * 5) == 0:
            print(f"  {i / FPS:4.0f}s / {DURATION:.0f}s", flush=True)
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed")
    render(50.5).save(os.path.join(OUT, "poster.png"))
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB) and promo/poster.png")


if __name__ == "__main__":
    main()
