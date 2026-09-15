# -*- coding: utf-8 -*-
"""精细像素世界地图 v4：右陆左海，河流自雪山经上游瀑布、石滩、石桥、回水湾平缓入海。
大量细节：分层水体/岸线泡沫/草地植被/泥土小径/石桥/山石皴理/雪顶/冰裂/水雾。
400x250 逻辑像素 x4 = 1600x1000。节点坐标与 v3 一致（百分比不变）。"""
import os, math, random
from PIL import Image

W, H, CELL = 400, 250, 4
OUT = r"C:\Users\qxl\web-fishing-game\frontend\assets\worldmap.png"
rnd = random.Random(7)

PAL = {
    'sea': (22, 66, 108), 'sea_d': (15, 48, 82), 'sea_l': (40, 110, 168),
    'shal': (44, 130, 190),          # 近岸浅水
    'foam': (207, 232, 248), 'foam_d': (158, 203, 232),
    'land': (36, 80, 48), 'grass': (47, 106, 60), 'grass_l': (63, 138, 76), 'grass_d': (28, 64, 38),
    'meadow': (55, 118, 68),
    'dirt': (122, 90, 56), 'path': (160, 128, 82), 'path_d': (122, 96, 60),
    'sand': (224, 200, 143), 'sand_d': (201, 168, 106), 'sand_wet': (188, 160, 110),
    'wood': (138, 106, 66), 'wood_d': (95, 70, 38), 'wood_l': (168, 134, 90),
    'rock': (122, 132, 144), 'rock_d': (90, 100, 112), 'cliff': (74, 84, 96),
    'ice': (191, 228, 248), 'ice_d': (158, 203, 224), 'snow': (255, 255, 255),
    'tree': (47, 106, 60), 'tree_d': (31, 74, 46), 'tree_l': (74, 154, 88), 'trunk': (95, 70, 38),
    'oak': (58, 122, 70), 'oak_l': (82, 158, 94),
    'red': (232, 74, 58), 'gold': (255, 210, 62), 'dark': (10, 22, 38),
}

img = Image.new('RGB', (W, H), PAL['sea'])
p = img.load()

def setp(x, y, c):
    x, y = int(round(x)), int(round(y))
    if 0 <= x < W and 0 <= y < H:
        p[x, y] = c

def ellipse(cx, cy, rx, ry, c, dither=None):
    rx, ry = max(rx, .5), max(ry, .5)
    for y in range(max(0, int(cy - ry)), min(H, int(cy + ry) + 1)):
        for x in range(max(0, int(cx - rx)), min(W, int(cx + rx) + 1)):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                if dither is not None and (x + y) % 2 == 0:
                    setp(x, y, dither)
                else:
                    setp(x, y, c)

def rect(x0, y0, x1, y1, c):
    for y in range(int(y0), int(y1) + 1):
        for x in range(int(x0), int(x1) + 1):
            setp(x, y, c)

def line(x0, y0, x1, y1, c, thick=1):
    steps = int(max(abs(x1 - x0), abs(y1 - y0), 1))
    for i in range(steps + 1):
        x = x0 + (x1 - x0) * i / steps
        y = y0 + (y1 - y0) * i / steps
        for dx in range(-(thick // 2), thick // 2 + 1):
            for dy in range(-(thick // 2), thick // 2 + 1):
                setp(x + dx, y + dy, c)

def tri(x0, y0, x1, y1, x2, y2, c):
    pts = [(x0, y0), (x1, y1), (x2, y2)]
    ymin, ymax = int(min(q[1] for q in pts)), int(max(q[1] for q in pts))
    for y in range(ymin, ymax + 1):
        xs = []
        for i in range(3):
            xa, ya = pts[i]; xb, yb = pts[(i + 1) % 3]
            if ya == yb:
                continue
            if min(ya, yb) <= y <= max(ya, yb):
                xs.append(xa + (y - ya) * (xb - xa) / (yb - ya))
        if len(xs) >= 2:
            for x in range(int(min(xs)), int(max(xs)) + 1):
                setp(x, y, c)

def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)

def speckle(x0, y0, x1, y1, c, density=0.05, cond=None):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            if rnd.random() < density and (cond is None or cond(x, y)):
                setp(x, y, c)

def pine(x, y, s=1.0):
    """松树：三层树冠 + 明暗 + 树干 + 投影"""
    ellipse(x + 1, y + 2 * s, 6 * s, 1.6 * s, shade(PAL['grass_d'], .8))   # 投影
    for k, (hh, cc) in enumerate([(5, PAL['tree_d']), (4, PAL['tree']), (3, PAL['tree_l'])]):
        cy = y - k * 3 * s
        tri(x - 7 * s + k * s, cy, x + 7 * s - k * s, cy, x, cy - hh * s, cc)
        # 受光边
        line(x, cy - hh * s, x - (7 - k) * s * .8, cy - 1, PAL['tree_l'])
    rect(x - 1, y, x + 1, y + 2 * s, PAL['trunk'])
    setp(x - 1, y - 6 * s, PAL['tree_l'])

def oak(x, y, s=1.0):
    """阔叶树：团状树冠三层 + 树干"""
    ellipse(x + 1, y + 2 * s, 5 * s, 1.4 * s, shade(PAL['grass_d'], .8))
    ellipse(x, y - 3 * s, 5 * s, 4 * s, PAL['tree_d'])
    ellipse(x - 1 * s, y - 4 * s, 3.5 * s, 3 * s, PAL['oak'])
    ellipse(x - 1.5 * s, y - 5 * s, 2 * s, 1.6 * s, PAL['oak_l'])
    rect(x - 1, y - 1 * s, x + 1, y + 2 * s, PAL['trunk'])

def bush(x, y, s=1.0):
    ellipse(x, y, 3.5 * s, 2.5 * s, PAL['tree_d'])
    ellipse(x - 1, y - 1, 2 * s, 1.5 * s, PAL['tree'])
    setp(x + 1, y - 1, PAL['tree_l']); setp(x - 2, y, PAL['tree_l'])

def flower(x, y, c):
    setp(x, y, c); setp(x - 1, y, c); setp(x + 1, y, c); setp(x, y - 1, c)
    setp(x, y + 1, PAL['grass_d'])

def rock(x, y, r=3):
    ellipse(x + 1, y + 1, r, r * .5, shade(PAL['grass_d'], .75))   # 投影
    ellipse(x, y, r, r - 1, PAL['rock_d'])
    ellipse(x - 0.5, y - 0.5, max(r - 1.5, .5), max(r - 2, .5), PAL['rock'])
    setp(x - 1, y - 1, (184, 194, 204))

def grass_tuft(x, y):
    setp(x, y, PAL['grass_l']); setp(x + 1, y - 1, PAL['grass_l']); setp(x + 2, y, PAL['grass'])

def foam_ring(cx, cy, rx, ry):
    """礁石/岸线周围的碎浪环"""
    for ang in range(0, 360, 14):
        x = cx + rx * math.cos(math.radians(ang))
        y = cy + ry * math.sin(math.radians(ang))
        setp(x, y, PAL['foam'])

def is_land(x, y):
    return x >= coast_x(y)

def coast_x(y):
    return 168 + 10 * math.sin(y / 40) + (14 * math.exp(-((y - 128) / 34) ** 2))

# ============ 1. 海洋（左）：深浅渐变 + 涌浪线 ============
for y in range(H):
    t = y / H
    for x in range(W):
        c = tuple(int(PAL['sea'][i] + (PAL['sea_d'][i] - PAL['sea'][i]) * t) for i in range(3))
        p[x, y] = c
# 涌浪长弧线（成组，左上→右下走向）
for gy in range(10, H - 16, 22):
    for gx in range(4, 165, 40):
        ox, oy = gx + rnd.randint(-6, 6), gy + rnd.randint(-5, 5)
        if is_land(ox, oy):
            continue
        for i in range(9):
            setp(ox + i, oy + int(1.6 * math.sin(i / 2.4)), PAL['sea_l'])
# 细密碎波
speckle(0, 0, 168, H, PAL['sea_l'], 0.012, lambda x, y: not is_land(x, y))

# ============ 2. 陆地（右）：草地双色噪点 + 草地斑块 ============
for y in range(H):
    cx = coast_x(y)
    for x in range(int(cx), W):
        n = (x * 7 + y * 3) % 5
        p[x, y] = PAL['land'] if n else PAL['grass']
        if x < cx + 2:
            p[x, y] = PAL['sand']
        elif x < cx + 5:
            p[x, y] = PAL['grass_d']
# 草地斑块（浅绿团）
for _ in range(22):
    x = rnd.randint(185, W - 8); y = rnd.randint(6, H - 6)
    ellipse(x, y, rnd.randint(4, 9), rnd.randint(2, 4), PAL['meadow'], dither=PAL['grass'])
# 草簇与花
for _ in range(34):
    x = rnd.randint(180, W - 4); y = rnd.randint(4, H - 4)
    if p[x, y] in (PAL['land'], PAL['grass'], PAL['meadow']):
        grass_tuft(x, y)
for _ in range(16):
    x = rnd.randint(185, W - 6); y = rnd.randint(6, H - 6)
    if p[x, y] in (PAL['land'], PAL['grass'], PAL['meadow']):
        flower(x, y, rnd.choice([PAL['gold'], (232, 122, 106), (214, 154, 255), (240, 240, 240)]))

# ============ 3. 泥土小径（码头 → 石桥 → 沙滩） ============
def path_dot(x, y):
    ellipse(x, y, 2.2, 1.6, PAL['path'])
    if (x + y) % 3 == 0:
        setp(x, y, PAL['path_d'])
path_pts = [(282, 82), (272, 96), (262, 108), (252, 118), (240, 126), (226, 130), (210, 132), (196, 138), (184, 148), (176, 160), (172, 172)]
for i in range(len(path_pts) - 1):
    x0, y0 = path_pts[i]; x1, y1 = path_pts[i + 1]
    steps = int(max(abs(x1 - x0), abs(y1 - y0)))
    for s in range(steps + 1):
        path_dot(x0 + (x1 - x0) * s / steps, y0 + (y1 - y0) * s / steps)

# ============ 4. 雪山（右上，岩面皴理 + 雪顶 + 山麓林线） ============
for x in range(318, 400):
    for y in range(H):
        hgt = 30 + 9 * math.sin(x / 13) + rnd.randint(-2, 2)
        if y < hgt:
            # 岩面皴理：斜向明暗条
            rocky = PAL['cliff'] if (x + y * 2) % 4 else PAL['rock_d']
            p[x, y] = rocky
            if y < hgt - 13:
                p[x, y] = PAL['snow'] if (x * 2 + y) % 3 else (228, 240, 248)
            elif y < hgt - 10 and (x + y) % 3 == 0:
                p[x, y] = (158, 168, 180)   # 雪线过渡
# 山麓小松
for x in range(322, 396, 12):
    y0 = 30 + 9 * math.sin(x / 13) + 2
    pine(x, y0 + 2, 0.7)

# ============ 5. 霜月冰湖（上中，锁定区）：雪堆 + 冰裂网 + 冰钓洞 + 雪人 ============
ellipse(268, 24, 34, 17, PAL['ice'])
ellipse(268, 22, 23, 9, (228, 244, 252))
# 冰面光泽抖动
for _ in range(30):
    x = rnd.randint(240, 296); y = rnd.randint(12, 38)
    if p[x, y] in (PAL['ice'], (228, 244, 252)):
        setp(x, y, PAL['snow'] if rnd.random() < .5 else PAL['ice_d'])
for ang in range(0, 360, 2):
    x = 268 + 37 * math.cos(math.radians(ang))
    y = 24 + 20 * math.sin(math.radians(ang))
    setp(x, y, PAL['snow']); setp(x, y + 1, PAL['snow'])
    if ang % 6 == 0:
        setp(x, y + 2, PAL['ice_d'])
# 冰裂网
line(254, 19, 268, 30, PAL['ice_d']); line(268, 30, 282, 21, PAL['ice_d']); line(268, 30, 274, 36, PAL['ice_d'])
line(258, 26, 252, 32, PAL['ice_d']); line(276, 26, 284, 30, PAL['ice_d'])
# 冰钓洞
ellipse(260, 30, 3, 2, (42, 86, 118))
setp(259, 29, (220, 236, 246))
# 雪堆
for x, y in [(246, 34), (292, 30)]:
    ellipse(x, y, 4, 2, PAL['snow'])
# 雪人（围巾 + 纽扣 + 树枝手）
sx, sy = 296, 22
ellipse(sx + 1, sy + 8, 5, 1.6, shade(PAL['grass_d'], .8))
ellipse(sx, sy + 4, 4, 4, PAL['snow'])
ellipse(sx, sy - 2, 3, 3, PAL['snow'])
setp(sx - 1, sy - 3, PAL['dark']); setp(sx + 1, sy - 3, PAL['dark'])
setp(sx, sy - 1, (232, 122, 60))
rect(sx - 2, sy - 7, sx + 2, sy - 5, PAL['dark'])
line(sx - 3, sy + 1, sx + 3, sy + 1, PAL['red'])          # 围巾
setp(sx, sy + 3, PAL['dark']); setp(sx, sy + 5, PAL['dark'])
line(sx - 4, sy + 2, sx - 6, sy - 1, PAL['wood_d']); line(sx + 4, sy + 2, sx + 6, sy, PAL['wood_d'])
pine(238, 10, 1.1); pine(310, 14, 1.0)

# ============ 6. 静水湖（右中）：深度环 + 码头细节 + 睡莲 + 芦苇 ============
ellipse(298, 112, 54, 44, PAL['sea'])
ellipse(298, 116, 40, 32, PAL['sea_d'])
ellipse(298, 114, 30, 22, PAL['sea'], dither=PAL['sea_d'])
ellipse(286, 96, 14, 7, PAL['sea_l'], dither=PAL['sea'])
# 湖心倒影纹
for i in range(3):
    line(288 + i * 8, 108 + i * 7, 296 + i * 8, 108 + i * 7, PAL['sea_l'])
# 湖岸
for ang in range(0, 360, 2):
    x = 298 + 57 * math.cos(math.radians(ang))
    y = 112 + 47 * math.sin(math.radians(ang))
    setp(x, y, PAL['grass_d']); setp(x, y + 1, PAL['grass_d'])
for ang in range(0, 360, 3):
    x = 298 + 55 * math.cos(math.radians(ang))
    y = 112 + 45 * math.sin(math.radians(ang))
    setp(x, y, PAL['dirt'])
pine(250, 72, 1.0); oak(344, 92, 1.1); bush(268, 66); bush(118, 84) if False else None; rock(348, 118, 2)
# 老旧码头（北岸）：双层木板 + 桩 + 绳 + 灯笼 + 水桶
for i in range(16):
    for j in range(5):
        c = PAL['wood'] if (i % 2 == 0) else shade(PAL['wood'], .85)
        setp(272 + i, 74 + j, c)
    setp(272 + i, 74, PAL['wood_d']); setp(272 + i, 78, PAL['wood_d'])
for i in range(0, 16, 4):
    setp(273 + i, 75, PAL['wood_l'])                  # 板面受光
for px_ in (273, 281, 288):
    rect(px_, 72, px_, 80, PAL['wood_d'])
    setp(px_, 71, PAL['wood'])
line(273, 72, 281, 73, (200, 180, 140)); line(281, 73, 288, 72, (200, 180, 140))
# 灯笼
rect(288, 68, 290, 71, PAL['dark'])
setp(289, 69, PAL['gold']); setp(289, 70, (255, 235, 150))
for ang in range(0, 360, 45):
    setp(289 + 4 * math.cos(math.radians(ang)), 70 + 4 * math.sin(math.radians(ang)), (255, 225, 120))
# 水桶
rect(276, 71, 278, 74, PAL['wood_d'])
setp(277, 72, PAL['sea_l'])
# 睡莲 + 涟漪
for x, y in [(316, 100), (324, 110), (308, 126), (332, 132), (286, 140)]:
    ellipse(x, y, 2, 1, PAL['tree_l'])
    setp(x, y - 1, (240, 200, 220))
    for ang in range(0, 360, 60):
        setp(x + 3.5 * math.cos(math.radians(ang)), y + 2.5 * math.sin(math.radians(ang)), PAL['sea_l'])
# 芦苇丛（南岸，高低错落 + 芦花）
for bx, bh in [(268, 13), (273, 16), (279, 11), (263, 9), (284, 10), (289, 8)]:
    line(bx, 156, bx, 156 - bh, PAL['tree'])
    line(bx + 1, 156, bx + 2, 156 - bh + 3, PAL['tree_d'])
    setp(bx - 1, 156 - bh - 1, (168, 132, 90)); setp(bx, 156 - bh - 2, (168, 132, 90)); setp(bx + 1, 156 - bh - 1, (168, 132, 90))
for _ in range(12):
    x = rnd.randint(268, 330); y = rnd.randint(88, 148)
    setp(x, y, (127, 196, 236)); setp(x + 1, y, (127, 196, 236))

# ============ 7. 急流河：雪山源头 → 上游瀑布 → 石滩 → 石桥 → 回水湾 → 入海 ============
def river_path(y):
    t = max(0, min(1, (y - 26) / 100))
    return 352 - 170 * t + 18 * math.sin(t * 3.5)
# 上游瀑布：岩阶 + 白练 + 瀑潭 + 水雾
fall_cx = river_path(44)
for x in range(int(fall_cx - 13), int(fall_cx + 13)):
    for dy in range(3):
        setp(x, 40 + dy, PAL['cliff'] if (x + dy) % 2 else PAL['rock_d'])
    setp(x, 43, PAL['snow'])
    setp(x, 39, PAL['rock'])
for y in range(44, 58):
    w1 = 9 + (y - 44) * 0.35
    for x in range(int(fall_cx - w1 / 2), int(fall_cx + w1 / 2)):
        setp(x, y, PAL['foam'] if (x * 3 + y) % 4 else PAL['foam_d'])
# 白练上的水纹
for y in range(45, 57, 2):
    line(fall_cx - 3, y, fall_cx + 3, y, (240, 248, 252))
for _ in range(10):                                   # 瀑潭水花 + 水雾
    setp(fall_cx + rnd.randint(-10, 10), rnd.randint(54, 60), PAL['foam'])
    setp(fall_cx + rnd.randint(-12, 12), rnd.randint(56, 62), (230, 244, 252))
# 河床（瀑布以下）
for y in range(58, 128):
    xc = river_path(y)
    w0 = 9 + y * 0.02
    for x in range(int(xc - w0), int(xc + w0)):
        setp(x, y, PAL['sea'] if (x + y) % 3 else PAL['sea_d'])
    setp(int(xc - w0), y, PAL['grass_d']); setp(int(xc + w0), y, PAL['grass_d'])
    setp(int(xc - w0) - 1, y, PAL['dirt']); setp(int(xc + w0) + 1, y, PAL['dirt'])
# 瀑布上方源头溪流
for y in range(26, 41):
    xc = river_path(y)
    w0 = 6
    for x in range(int(xc - w0), int(xc + w0)):
        setp(x, y, PAL['sea'] if (x + y) % 3 else PAL['sea_d'])
    setp(int(xc - w0), y, PAL['rock_d']); setp(int(xc + w0), y, PAL['rock_d'])
# 石滩乱石（每块石头带碎浪环）
for x, y, r in [(300, 72, 4), (292, 80, 5), (306, 86, 3), (288, 90, 3)]:
    rock(x, y, r)
    foam_ring(x, y, r + 1.5, r + 0.5)
for _ in range(12):
    y = rnd.randint(62, 96); xc = river_path(y)
    x = rnd.randint(int(xc - 6), int(xc + 6))
    line(x, y, x + 3, y + 1, PAL['foam'])
# 石桥（小径跨河处，约 y=118 河段上方改到 y=96 附近河面）—— 位于回水湾上游口
br_y = 96
br_x = river_path(br_y)
bw = int(9 + br_y * 0.02) + 4
rect(br_x - bw, br_y - 2, br_x + bw, br_y + 1, PAL['wood'])
line(br_x - bw, br_y - 2, br_x + bw, br_y - 2, PAL['wood_d'])
line(br_x - bw, br_y + 1, br_x + bw, br_y + 1, PAL['wood_d'])
for i in range(int(br_x - bw), int(br_x + bw), 4):
    line(i, br_y - 2, i, br_y + 1, PAL['wood_d'])
setp(br_x - bw, br_y - 3, PAL['wood_d']); setp(br_x + bw, br_y - 3, PAL['wood_d'])
setp(br_x - bw, br_y + 2, PAL['wood_d']); setp(br_x + bw, br_y + 2, PAL['wood_d'])
# 回水湾（下游加宽 + 涡纹）
for y in range(102, 122):
    xc = river_path(y)
    for x in range(int(xc + 8), int(xc + 20)):
        setp(x, y, PAL['sea'] if (x + y) % 2 else shade(PAL['sea'], 1.1))
    setp(int(xc + 20), y, PAL['grass_d'])
for r in (3, 5, 7):                                   # 涡纹同心弧
    ecx, ecy = river_path(112) + 14, 112
    for ang in range(-40, 200, 25):
        setp(ecx + r * math.cos(math.radians(ang)), ecy + r * .6 * math.sin(math.radians(ang)), PAL['sea_l'])
# 入海口：喇叭口渐宽、河水与海水抖动交融、三角洲沙洲、入湾浪弧
for y in range(112, 132):
    xc = river_path(y)
    flare = max(0, y - 112) * 1.1
    w1 = (9 + y * 0.02) + flare
    mix = (y - 112) / 20                          # 越靠近海口混入海色越多
    for x in range(int(xc - w1), int(xc + w1)):
        c = PAL['sea'] if (x + y) % 2 == 0 else shade(PAL['sea'], 1.05)
        if rnd.random() < mix * 0.55:
            c = shade(PAL['sea'], .88)
        setp(x, y, c)
    setp(int(xc - w1), y, PAL['grass_d']); setp(int(xc + w1), y, PAL['grass_d'])
# 三角洲沙洲（汊口两岛，泡沫环绕）
d1x = river_path(126) - 10
ellipse(d1x, 128, 6, 3, PAL['sand_d'])
ellipse(d1x - 1, 127, 4, 2, PAL['sand'])
foam_ring(d1x, 128, 8, 4.5)
d2x = river_path(131) + 6
ellipse(d2x, 133, 5, 2.5, PAL['sand_d'])
foam_ring(d2x, 133, 7, 4)
# 入湾浪弧（以海口为圆心向海侧扩散的同心弧）
mx = int(coast_x(126))
for rr in (6, 10, 14, 18):
    for ang in range(145, 216, 9):
        x = mx + rr * math.cos(math.radians(ang))
        y = 128 + rr * .5 * math.sin(math.radians(ang))
        if not is_land(x, y):
            setp(x, y, PAL['foam'])

# ============ 8. 落日海湾：湿沙/干沙 + 泡沫线 + 遮阳伞 + 防波堤灯塔 + 礁石沉船 ============
for y in range(150, 210):
    cx = coast_x(y)
    for x in range(int(cx) - 2, int(cx) + 14):
        p[x, y] = PAL['sand'] if (x + y) % 4 else PAL['sand_d']
    for x in range(int(cx) - 2, int(cx) + 2):        # 湿沙带
        p[x, y] = PAL['sand_wet']
    for x in range(int(cx) - 4, int(cx) - 1):
        setp(x, y, PAL['foam'])
# 滩草
for y in range(156, 206, 9):
    grass_tuft(int(coast_x(y)) + 11, y)
ux, uy = int(coast_x(178)) + 6, 170                  # 遮阳伞 + 投影
ellipse(ux + 1, uy + 10, 5, 1.6, PAL['sand_wet'])
line(ux, uy, ux, uy + 9, PAL['wood_d'])
for dx in range(-6, 7):
    h = 3 - abs(dx) // 2
    for dy in range(h):
        setp(ux + dx, uy - dy, PAL['red'] if dx % 2 else PAL['snow'])
setp(ux, uy - 3, PAL['gold'])                        # 伞顶珠
for x, y in [(int(coast_x(196)) + 4, 192), (int(coast_x(188)) + 8, 186)]:
    setp(x, y, (242, 216, 216)); setp(x + 1, y, (216, 168, 168))
for dx, dy in [(0, 0), (-2, 0), (2, 0), (0, -2), (0, 2)]:
    setp(int(coast_x(200)) + 8 + dx, 200 + dy, (232, 150, 90))
# 防波堤巨石链 + 灯塔（近岸环抱海湾）
for x, y, r in [(126, 64, 7), (140, 72, 8), (154, 66, 7), (152, 86, 6)]:
    rock(x, y, r)
    foam_ring(x, y, r + 1.5, r + 0.5)
lx, ly = 140, 44
rect(lx - 3, ly, lx + 3, ly + 22, PAL['snow'])
rect(lx - 3, ly + 5, lx + 3, ly + 9, PAL['red'])
rect(lx - 3, ly + 14, lx + 3, ly + 18, PAL['red'])
line(lx - 3, ly + 22, lx + 3, ly + 22, PAL['rock_d'])  # 基座
rect(lx - 2, ly - 5, lx + 2, ly, PAL['dark'])
setp(lx, ly - 3, PAL['gold'])
rect(lx - 3, ly + 10, lx - 2, ly + 12, PAL['dark'])    # 小窗
for ang in range(-60, 241, 40):
    setp(lx + 7 * math.cos(math.radians(ang)), ly - 3 + 7 * math.sin(math.radians(ang)), (255, 235, 150))
# 礁石区 + 沉船（左下）
for x, y, r in [(62, 182, 8), (80, 196, 6), (94, 184, 5)]:
    rock(x, y, r)
    foam_ring(x, y, r + 1.5, r + 0.5)
hull = PAL['wood_d']
for i in range(16):
    line(50 + i, 212 - i * 0.35, 50 + i, 218 - i * 0.35, hull)
line(50, 212, 66, 206, PAL['wood'])
line(58, 210, 58, 196, PAL['wood_d'])
line(58, 198, 66, 202, (200, 180, 140))
setp(54, 211, (232, 122, 106)); setp(55, 212, (232, 122, 106))
setp(62, 208, (214, 154, 120))
for i in range(3):                                   # 船板缝
    line(52 + i * 5, 212 - i * 1.7, 52 + i * 5, 217 - i * 1.7, PAL['dark'])
for _ in range(5):                                   # 残骸气泡
    setp(56 + rnd.randint(-6, 8), rnd.randint(198, 210), PAL['sea_l'])
for x, y in [(70, 176), (86, 172)]:
    setp(x, y, (232, 122, 106)); setp(x + 1, y - 2, (232, 122, 106)); setp(x + 2, y, (216, 106, 90)); setp(x - 1, y - 1, (216, 106, 90))
for _ in range(14):
    x = rnd.randint(20, 150); y = rnd.randint(40, 220)
    setp(x, y, (90, 164, 216)); setp(x + 1, y, (90, 164, 216))

# ============ 9. 四围林地边框 + 暗角 ============
for x, y, s in [(190, 12, 1.2), (210, 8, 1.0), (392, 180, 1.2), (388, 220, 1.0), (200, 238, 1.1), (230, 242, 1.0)]:
    pine(x, y, s)
for x, y in [(224, 16), (380, 200), (214, 234)]:
    bush(x, y)
oak(186, 226, 1.2); oak(394, 152, 1.0)
for y in range(H):
    for x in range(W):
        dx = max(0, (24 - min(x, W - 1 - x)) / 24)
        dy = max(0, (18 - min(y, H - 1 - y)) / 18)
        f = max(dx, dy)
        if f > 0:
            p[x, y] = shade(p[x, y], 1 - f * .25)

img = img.resize((W * CELL, H * CELL), Image.NEAREST)
img.save(OUT)
print('saved', OUT, img.size)
