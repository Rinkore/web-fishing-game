# -*- coding: utf-8 -*-
"""扩展地图：icemap.png（霜月冰湖活动场）+ voyagemap.png（出海航线预告）。
均为 400x250 逻辑像素 x4。"""
import os, math, random
from PIL import Image

ROOT = r"C:\Users\qxl\web-fishing-game\frontend\assets"
rnd = random.Random(11)

def hx(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def make_canvas(w, h, c):
    img = Image.new('RGB', (w, h), c)
    return img, img.load()

def setp(p, W, H, x, y, c):
    x, y = int(round(x)), int(round(y))
    if 0 <= x < W and 0 <= y < H:
        p[x, y] = c

def ellipse(p, W, H, cx, cy, rx, ry, c, dither=None):
    rx, ry = max(rx, .5), max(ry, .5)
    for y in range(max(0, int(cy - ry)), min(H, int(cy + ry) + 1)):
        for x in range(max(0, int(cx - rx)), min(W, int(cx + rx) + 1)):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                if dither is not None and (x + y) % 2 == 0:
                    setp(p, W, H, x, y, dither)
                else:
                    setp(p, W, H, x, y, c)

def line(p, W, H, x0, y0, x1, y1, c, thick=1, dash=0):
    steps = int(max(abs(x1 - x0), abs(y1 - y0), 1))
    for i in range(steps + 1):
        if dash and (i // dash) % 2:
            continue
        x = x0 + (x1 - x0) * i / steps
        y = y0 + (y1 - y0) * i / steps
        for dx in range(-(thick // 2), thick // 2 + 1):
            for dy in range(-(thick // 2), thick // 2 + 1):
                setp(p, W, H, x + dx, y + dy, c)

def rect(p, W, H, x0, y0, x1, y1, c):
    for y in range(int(y0), int(y1) + 1):
        for x in range(int(x0), int(x1) + 1):
            setp(p, W, H, x, y, c)

def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)

# ================= 冰湖活动场 =================
def gen_icemap():
    W, H = 400, 250
    img, p = make_canvas(W, H, hx('#e8f4fc'))
    snow, snow_d = hx('#e8f4fc'), hx('#c8e0f0')
    ice, ice_d = hx('#bfe4f8'), hx('#9ecbe0')
    ice_dark = hx('#6aa8c8')
    # 雪地底色 + 噪点
    for y in range(H):
        for x in range(W):
            if (x * 7 + y * 13) % 17 == 0:
                p[x, y] = snow_d
    # 天空角：极光色带（顶部）
    for x in range(W):
        for y in range(22):
            t = y / 22
            c = tuple(int(hx('#dff2fc')[i] + (hx('#a8dcf0')[i] - hx('#dff2fc')[i]) * t) for i in range(3))
            p[x, y] = c
    for x in range(0, W, 3):  # 极光弧
        ay = 8 + 6 * math.sin(x / 30)
        setp(p, W, H, x, ay, hx('#7fe8c8'))
        setp(p, W, H, x, ay + 1, hx('#7fe8c8'))
    # 中央大冰湖
    ellipse(p, W, H, 200, 145, 150, 88, ice)
    ellipse(p, W, H, 200, 138, 110, 60, hx('#d8eefc'))
    ellipse(p, W, H, 200, 150, 150, 88, None, None) if False else None
    # 冰湖边缘描边（雪堆）
    for ang in range(0, 360, 2):
        x = 200 + 154 * math.cos(math.radians(ang))
        y = 145 + 92 * math.sin(math.radians(ang))
        setp(p, W, H, x, y, snow)
        setp(p, W, H, x, y + 1, snow_d)
    # 冰裂纹（主干 + 分支）
    crack = ice_d
    line(p, W, H, 110, 100, 200, 150, crack)
    line(p, W, H, 200, 150, 290, 120, crack)
    line(p, W, H, 200, 150, 240, 200, crack)
    line(p, W, H, 150, 125, 130, 160, crack)
    line(p, W, H, 250, 132, 268, 162, crack)
    # 冰下暗色深水带
    ellipse(p, W, H, 190, 160, 60, 30, hx('#8fc0dc'), dither=ice)
    # 冰钓洞（未来的钓点位置参考装饰）
    for x, y in [(160, 120), (240, 115), (200, 165), (155, 170)]:
        ellipse(p, W, H, x, y, 5, 4, hx('#4a86ac'))
        ellipse(p, W, H, x, y, 3, 2.5, hx('#2a5a7c'))
        setp(p, W, H, x - 6, y - 4, snow); setp(p, W, H, x + 6, y - 4, snow)
    # 冰屋（右上岸）
    ix, iy = 300, 60
    for dy in range(18):
        w0 = 16 * math.cos(dy / 18 * math.pi / 2)
        for dx in range(int(-w0), int(w0) + 1):
            setp(p, W, H, ix + dx, iy + dy - 8, snow if (dx + dy) % 3 else snow_d)
    rect(p, W, H, ix - 4, iy + 4, ix + 4, iy + 10, hx('#5a7a94'))  # 门
    setp(p, W, H, ix, iy + 7, hx('#ffd23e'))                       # 门内暖光
    # 企鹅（冰湖左缘 + 右侧）
    for px_, py_ in [(108, 130), (116, 138), (292, 170)]:
        ellipse(p, W, H, px_, py_, 3, 4, hx('#1a2a3a'))
        ellipse(p, W, H, px_, py_ + 1, 2, 2.5, hx('#f2f6fa'))
        setp(p, W, H, px_, py_ - 3, hx('#e8a53a'))
        setp(p, W, H, px_ - 2, py_ + 5, hx('#e8a53a')); setp(p, W, H, px_ + 2, py_ + 5, hx('#e8a53a'))
    # 雪松（四周）
    def snow_pine(x, y, s=1.0):
        for k, (hh, cc) in enumerate([(5, hx('#5a8a9e')), (4, hx('#6a9aae')), (3, hx('#8abace'))]):
            cy = y - k * 3 * s
            w0 = 7 * s - k * s
            for dy2 in range(int(hh * s)):
                w1 = w0 * (1 - dy2 / (hh * s))
                for dx in range(int(-w1), int(w1) + 1):
                    setp(p, W, H, x + dx, cy - hh * s + dy2 + hh * s, cc)
        rect(p, W, H, x - 1, y, x + 1, y + 2 * s, hx('#5f4626'))
    for x, y, s in [(30, 40, 1.3), (56, 30, 1.0), (370, 44, 1.2), (30, 210, 1.1), (368, 212, 1.3), (90, 226, 1.0)]:
        snow_pine(x, y, s)
    # 飘雪点
    for _ in range(50):
        x = rnd.randint(0, W - 1); y = rnd.randint(0, H - 1)
        if p[x, y] == snow or p[x, y] == ice or p[x, y] == hx('#d8eefc'):
            setp(p, W, H, x, y, hx('#ffffff'))
    img = img.resize((W * 4, H * 4), Image.NEAREST)
    img.save(os.path.join(ROOT, 'icemap.png'))
    return img.size

# ================= 出海航线预告 =================
def gen_voyagemap():
    W, H = 400, 250
    img, p = make_canvas(W, H, hx('#123c68'))
    water, water_d = hx('#1a4a78'), hx('#123c68')
    fog, fog_d = hx('#8aa4b8'), hx('#6a8498')
    for y in range(H):  # 海面渐变
        t = y / H
        c = tuple(int(water[i] + (water_d[i] - water[i]) * t) for i in range(3))
        for x in range(W):
            p[x, y] = c
    for _ in range(70):  # 波纹
        x = rnd.randint(4, W - 8); y = rnd.randint(10, H - 6)
        for i in range(rnd.randint(2, 4)):
            setp(p, W, H, x + i, y, hx('#2a6ea0'))
    # 近岸母港（左下）
    land = hx('#2f6a3c')
    for x in range(90):
        for y in range(H):
            coast = 200 - x * 0.6
            if y > coast:
                p[x, y] = land if (x + y) % 3 else shade(land, .8)
    # 港口栈桥 + 船
    wood, wood_d = hx('#8a6a42'), hx('#5f4626')
    rect(p, W, H, 60, 186, 96, 190, wood)
    for x in (62, 74, 86, 94):
        rect(p, W, H, x, 184, x, 192, wood_d)
    # 帆船
    bx, by = 104, 186
    rect(p, W, H, bx - 6, by, bx + 8, by + 5, wood_d)
    rect(p, W, H, bx, by - 14, bx + 1, by, wood)
    for dy in range(12):  # 三角帆
        for dx in range(8 - dy // 2):
            setp(p, W, H, bx + 2 + dx, by - 12 + dy, hx('#e8e4da') if (dx + dy) % 2 else hx('#d8d4c8'))
    setp(p, W, H, bx - 2, by + 2, hx('#ffd23e'))  # 船灯
    # 航线（虚线，绕弯到两个雾岛）
    route = hx('#ffd23e')
    pts = [(110, 182), (170, 150), (240, 158), (290, 120), (300, 92), (340, 64)]
    for i in range(len(pts) - 1):
        line(p, W, H, *pts[i], *pts[i + 1], route, dash=4)
    for x, y in pts[1:-1]:
        setp(p, W, H, x, y, hx('#ffe98a'))
    # 雾中群岛（两座剪影 + 浓雾）
    def fog_island(cx, cy, s):
        # 山形剪影
        for dy in range(int(30 * s)):
            w0 = (30 * s - dy) * 0.8
            for dx in range(int(-w0), int(w0) + 1):
                setp(p, W, H, cx + dx, cy - dy, fog_d if (dx + dy) % 2 else fog)
        # 雾团
        for _ in range(60):
            x = cx + rnd.randint(int(-40 * s), int(40 * s))
            y = cy + rnd.randint(-6, 14)
            ellipse(p, W, H, x, y, rnd.randint(6, 14) * s, rnd.randint(3, 6) * s, hx('#c8d8e4'))
        # 山顶 ?
        setp(p, W, H, cx, cy - 34 * s, hx('#ffd23e'))
        setp(p, W, H, cx, cy - 30 * s, hx('#ffd23e'))
        setp(p, W, H, cx - 1, cy - 26 * s, hx('#ffd23e'))
    fog_island(250, 120, 1.0)
    fog_island(345, 60, 0.8)
    # 罗盘玫瑰（右上）
    cx, cy = 366, 210
    ellipse(p, W, H, cx, cy, 14, 14, hx('#0d2c50'))
    for ang in range(0, 360, 45):
        line(p, W, H, cx, cy, cx + 12 * math.cos(math.radians(ang)), cy + 12 * math.sin(math.radians(ang)), hx('#7a8490'))
    setp(p, W, H, cx, cy - 10, hx('#e84a3a'))
    ellipse(p, W, H, cx, cy, 2, 2, hx('#ffd23e'))
    img = img.resize((W * 4, H * 4), Image.NEAREST)
    img.save(os.path.join(ROOT, 'voyagemap.png'))
    return img.size

if __name__ == '__main__':
    print('icemap', gen_icemap())
    print('voyagemap', gen_voyagemap())
