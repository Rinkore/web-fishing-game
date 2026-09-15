# -*- coding: utf-8 -*-
"""UI pixel assets: RPG frame (9-slice), login hero, fisherman marker, bird."""
import os, math, random
from PIL import Image

ROOT = r"C:\Users\qxl\web-fishing-game\frontend\assets\ui"
os.makedirs(ROOT, exist_ok=True)

def hx(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def gen_frame():
    """RPG window frame 36x36, 9-slice, corner 12px."""
    S = 36
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    p = img.load()
    outer = hx('#0a1626')
    rim = hx('#48709c')
    rim_d = hx('#2c4f74')
    body = hx('#10233c')
    gold = hx('#ffd23e')
    for y in range(S):
        for x in range(S):
            edge = min(x, y, S - 1 - x, S - 1 - y)
            if edge < 2:
                p[x, y] = (*outer, 255)
            elif edge < 4:
                p[x, y] = (*(rim if (x + y) % 2 == 0 else rim_d), 255)
            elif edge < 5:
                p[x, y] = (*outer, 255)
            else:
                p[x, y] = (*body, 255)
    for cx, cy in [(5, 5), (S - 6, 5), (5, S - 6), (S - 6, S - 6)]:
        for dx, dy in [(0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)]:
            p[cx + dx, cy + dy] = (*gold, 255)
        p[cx - 1, cy - 1] = (255, 240, 180, 255)
    img.save(os.path.join(ROOT, 'frame.png'))
    return img.size

def gen_hero():
    """login hero: dusk lake silhouette scene 320x180 x3."""
    W, H = 320, 180
    img = Image.new('RGB', (W, H))
    p = img.load()
    sky_t = hx('#0c2340'); sky_b = hx('#1e5f8a'); hor = hx('#3f9ab8')
    for y in range(H):
        if y < 108:
            t = y / 108
            c = tuple(int(sky_t[i] + ((hor if t > .7 else sky_b)[i] - sky_t[i]) * (t if t <= .7 else (t - .7) / .3)) for i in range(3))
        else:
            t = (y - 108) / (H - 108)
            c = tuple(int(hx('#1a5a8a')[i] + (hx('#0a1c30')[i] - hx('#1a5a8a')[i]) * t) for i in range(3))
        for x in range(W):
            p[x, y] = c
    def setp(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            p[int(x), int(y)] = c
    def ellipse(cx, cy, rx, ry, c):
        for y in range(max(0, int(cy - ry)), min(H, int(cy + ry) + 1)):
            for x in range(max(0, int(cx - rx)), min(W, int(cx + rx) + 1)):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                    p[x, y] = c
    rnd = random.Random(3)
    for _ in range(40):
        x = rnd.randint(0, W - 1); y = rnd.randint(0, 84)
        setp(x, y, hx('#d8ecf8') if rnd.random() < .7 else hx('#8fc4e0'))
    ellipse(250, 36, 14, 14, hx('#f2ecd8'))
    ellipse(247, 33, 11, 11, hx('#fff8e8'))
    for ang in range(0, 360, 12):
        r = 19
        setp(250 + r * math.cos(math.radians(ang)), 36 + r * math.sin(math.radians(ang)), hx('#7fb8d8'))
    dark = hx('#0e2a44')
    for x in range(W):
        h1 = 74 - 16 * math.sin(x / 40) - 8 * math.sin(x / 17)
        for y in range(int(h1), 108):
            p[x, y] = dark
    dark2 = hx('#0a1f36')
    for x in range(W):
        h2 = 88 - 12 * math.sin(x / 28 + 2)
        for y in range(int(h2), 108):
            p[x, y] = dark2
    for i in range(14):
        y = 112 + i * 4
        w = 8 - i * 0.5
        if w > 0:
            for x in range(int(250 - w), int(250 + w)):
                if (x + y) % 2 == 0:
                    setp(x, y, hx('#9fc8dc'))
    for _ in range(24):
        x = rnd.randint(0, W - 6); y = rnd.randint(112, H - 4)
        for i in range(3):
            setp(x + i, y, hx('#3f9ab8'))
    sil = hx('#060f1c')
    for i in range(30):
        for j in range(3):
            p[20 + i, 138 + j] = sil
    for x in (24, 36, 48):
        for y in range(138, 152):
            p[x, y] = sil
    fx, fy = 44, 138
    for x in range(fx - 4, fx + 5):
        for y in range(fy - 16, fy - 12):
            if abs(x - fx) <= 4 - (y - (fy - 16)):
                setp(x, y, sil)
    ellipse(fx, fy - 10, 3, 3, sil)
    ellipse(fx, fy - 4, 4, 5, sil)
    for i in range(24):
        setp(fx + 3 + i, fy - 8 - i * 0.6, sil)
    for i in range(8):
        setp(fx + 27, fy - 22 + i, hx('#5a7a94'))
    setp(20, 134, hx('#ffd23e')); setp(21, 134, hx('#ffd23e')); setp(20, 135, hx('#ffb04a')); setp(21, 135, hx('#ffb04a'))
    for bx, bh in [(8, 12), (12, 9), (60, 10), (66, 13), (70, 8)]:
        for y in range(H - bh, H):
            setp(bx, y, sil)
    img = img.resize((W * 3, H * 3), Image.NEAREST)
    img.save(os.path.join(ROOT, 'hero.png'))
    return img.size

def gen_fisherman():
    """map fisherman marker 18x22 transparent."""
    W, H = 18, 22
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    p = img.load()
    hat = hx('#c9a86a'); hat_d = hx('#a8845a'); skin = hx('#e8b98a')
    coat = hx('#4a6a8a'); coat_d = hx('#3a5470')
    def setp(x, y, c):
        if 0 <= x < W and 0 <= y < H:
            p[x, y] = (*c, 255) if len(c) == 3 else c
    for y in range(3):
        w = 8 - y * 2
        for x in range(9 - w, 9 + w + 1):
            setp(x, y + 1, hat if y % 2 == 0 else hat_d)
    for y in range(4, 7):
        for x in range(7, 11):
            setp(x, y, skin)
    setp(7, 5, (40, 40, 48)); setp(10, 5, (40, 40, 48))
    for y in range(7, 16):
        for x in range(5, 13):
            setp(x, y, coat if (x + y) % 2 else coat_d)
    for y in range(16, 19):
        for x in range(7, 15):
            setp(x, y, coat_d)
    for x in range(12, 16):
        setp(x, 10, skin)
    for i in range(16):
        setp(14 + i * .6, 10 - i * .7, hx('#5f4626'))
    img = img.resize((W * 4, H * 4), Image.NEAREST)
    img.save(os.path.join(ROOT, 'fisherman.png'))
    return img.size

def gen_bird():
    """bird silhouette 12x6."""
    W, H = 12, 6
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    p = img.load()
    c = hx('#0e2a44') + (200,)
    for x, y in [(1, 2), (2, 1), (3, 2), (4, 3), (5, 3), (6, 3), (7, 3), (8, 2), (9, 1), (10, 2)]:
        p[x, y] = c
    p[5, 4] = c; p[6, 4] = c
    img = img.resize((W * 3, H * 3), Image.NEAREST)
    img.save(os.path.join(ROOT, 'bird.png'))
    return img.size

if __name__ == '__main__':
    print('frame', gen_frame())
    print('hero', gen_hero())
    print('fisherman', gen_fisherman())
    print('bird', gen_bird())
