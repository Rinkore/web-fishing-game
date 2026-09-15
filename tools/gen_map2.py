# -*- coding: utf-8 -*-
"""精细像素世界地图 v3：右侧陆地（淡水：静水湖/急流河/霜月冰湖），左侧海洋（落日海湾），
河流自右上山地流下，经石滩、回水湾，在海岸悬崖成瀑布入海。
400x250 逻辑像素 x4 = 1600x1000。"""
import os, math, random
from PIL import Image

W, H, CELL = 400, 250, 4
OUT = r"C:\Users\qxl\web-fishing-game\frontend\assets\worldmap.png"
rnd = random.Random(7)

PAL = {
    'sea': (22, 66, 108), 'sea_d': (15, 48, 82), 'sea_l': (40, 110, 168),
    'foam': (207, 232, 248), 'foam_d': (158, 203, 232),
    'land': (36, 80, 48), 'grass': (47, 106, 60), 'grass_l': (63, 138, 76), 'grass_d': (28, 64, 38),
    'dirt': (122, 90, 56), 'sand': (224, 200, 143), 'sand_d': (201, 168, 106),
    'wood': (138, 106, 66), 'wood_d': (95, 70, 38),
    'rock': (122, 132, 144), 'rock_d': (90, 100, 112), 'cliff': (74, 84, 96),
    'ice': (191, 228, 248), 'ice_d': (158, 203, 224), 'snow': (255, 255, 255),
    'tree': (47, 106, 60), 'tree_d': (31, 74, 46), 'tree_l': (74, 154, 88), 'trunk': (95, 70, 38),
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

def pine(x, y, s=1.0):
    for k, (hh, cc) in enumerate([(5, PAL['tree_d']), (4, PAL['tree']), (3, PAL['tree_l'])]):
        cy = y - k * 3 * s
        tri(x - 7 * s + k * s, cy, x + 7 * s - k * s, cy, x, cy - hh * s, cc)
    rect(x - 1, y, x + 1, y + 2 * s, PAL['trunk'])
    setp(x - 1, y - 6 * s, PAL['tree_l'])

def bush(x, y, s=1.0):
    ellipse(x, y, 3.5 * s, 2.5 * s, PAL['tree_d'])
    ellipse(x - 1, y - 1, 2 * s, 1.5 * s, PAL['tree'])
    setp(x + 1, y - 1, PAL['tree_l']); setp(x - 2, y, PAL['tree_l'])

def flower(x, y, c):
    setp(x, y, c); setp(x - 1, y, c); setp(x + 1, y, c); setp(x, y - 1, c)
    setp(x, y + 1, PAL['grass_d'])

def rock(x, y, r=3):
    ellipse(x, y, r, r - 1, PAL['rock_d'])
    ellipse(x - 0.5, y - 0.5, max(r - 1.5, .5), max(r - 2, .5), PAL['rock'])
    setp(x - 1, y - 1, (184, 194, 204))

def grass_tuft(x, y):
    setp(x, y, PAL['grass_l']); setp(x + 1, y - 1, PAL['grass_l']); setp(x + 2, y, PAL['grass'])

# ============ 1. 海洋（左 42%） ============
def coast_x(y):
    """海岸线 x 坐标：中部略弯，湾处在瀑布口向内凹"""
    return 168 + 10 * math.sin(y / 40) + (14 * math.exp(-((y - 128) / 34) ** 2))
for y in range(H):
    t = y / H
    for x in range(W):
        c = tuple(int(PAL['sea'][i] + (PAL['sea_d'][i] - PAL['sea'][i]) * t) for i in range(3))
        p[x, y] = c
# 海面波纹
for _ in range(60):
    x = rnd.randint(4, 160); y = rnd.randint(6, H - 6)
    for i in range(rnd.randint(2, 4)):
        setp(x + i, y, PAL['sea_l'])

# ============ 2. 陆地（右侧 58%，草地纹理） ============
for y in range(H):
    cx = coast_x(y)
    for x in range(int(cx), W):
        n = (x * 7 + y * 3) % 5
        p[x, y] = PAL['land'] if n else PAL['grass']
        if x < cx + 2:
            p[x, y] = PAL['sand']     # 海岸沙边
        elif x < cx + 5:
            p[x, y] = PAL['grass_d']  # 岸线描边
        elif rnd.random() < .03:
            p[x, y] = PAL['grass_l']
# 海浪拍岸白花
for y in range(6, H - 4, 6):
    cx = coast_x(y)
    for dx in range(3):
        setp(cx - 2 - dx, y, PAL['foam'])
# 陆地点缀
for _ in range(30):
    x = rnd.randint(180, W - 4); y = rnd.randint(4, H - 4)
    if p[x, y] in (PAL['land'], PAL['grass']):
        grass_tuft(x, y)
for _ in range(12):
    x = rnd.randint(185, W - 6); y = rnd.randint(6, H - 6)
    if p[x, y] in (PAL['land'], PAL['grass']):
        flower(x, y, rnd.choice([PAL['gold'], (232, 122, 106), (214, 154, 255)]))

# ============ 3. 静水湖（陆上，右中） ============
ellipse(298, 112, 54, 44, PAL['sea'])
ellipse(298, 116, 40, 32, PAL['sea_d'])
ellipse(298, 114, 30, 22, PAL['sea'], dither=PAL['sea_d'])
ellipse(286, 96, 14, 7, PAL['sea_l'], dither=PAL['sea'])   # 浅水反光（小而含蓄）
for ang in range(0, 360, 2):
    x = 298 + 57 * math.cos(math.radians(ang))
    y = 112 + 47 * math.sin(math.radians(ang))
    setp(x, y, PAL['grass_d']); setp(x, y + 1, PAL['grass_d'])
for ang in range(0, 360, 3):
    x = 298 + 55 * math.cos(math.radians(ang))
    y = 112 + 45 * math.sin(math.radians(ang))
    setp(x, y, PAL['dirt'])
pine(250, 72, 1.0); bush(268, 66); bush(340, 80); rock(348, 118, 2)
# 老旧码头（湖北岸，木板 + 桩 + 绳 + 灯笼）
for i in range(16):
    for j in range(5):
        c = PAL['wood'] if (i % 2 == 0) else shade(PAL['wood'], .85)
        setp(272 + i, 74 + j, c)
    setp(272 + i, 74, PAL['wood_d']); setp(272 + i, 78, PAL['wood_d'])
for px_ in (273, 281, 288):
    rect(px_, 72, px_, 80, PAL['wood_d'])
    setp(px_, 71, PAL['wood'])
line(273, 72, 281, 73, (200, 180, 140)); line(281, 73, 288, 72, (200, 180, 140))
rect(288, 68, 290, 71, PAL['dark'])
setp(289, 69, PAL['gold']); setp(289, 70, (255, 235, 150))
for ang in range(0, 360, 45):
    setp(289 + 4 * math.cos(math.radians(ang)), 70 + 4 * math.sin(math.radians(ang)), (255, 225, 120))
# 睡莲
for x, y in [(316, 100), (324, 110), (308, 126), (332, 132), (286, 140)]:
    ellipse(x, y, 2, 1, PAL['tree_l'])
    setp(x, y - 1, (240, 200, 220))
# 芦苇（南岸一丛）
for bx, bh in [(268, 13), (273, 16), (279, 11), (263, 9), (284, 10)]:
    line(bx, 156, bx, 156 - bh, PAL['tree'])
    setp(bx - 1, 156 - bh - 1, (168, 132, 90)); setp(bx, 156 - bh - 2, (168, 132, 90)); setp(bx + 1, 156 - bh - 1, (168, 132, 90))
for _ in range(12):
    x = rnd.randint(268, 330); y = rnd.randint(88, 148)
    setp(x, y, (127, 196, 236)); setp(x + 1, y, (127, 196, 236))

# ============ 4. 急流河（右上山地 → 西南入海，沿途石滩/回水湾/瀑布） ============
# 山地（右上，河流源头）
for x in range(326, 400):
    for y in range(H):
        hgt = 22 + 7 * math.sin(x / 13) + rnd.randint(-2, 2)
        if y < hgt:
            p[x, y] = PAL['rock_d'] if (x + y) % 3 else PAL['cliff']
            if y < hgt - 12:
                p[x, y] = PAL['snow'] if (x * 2 + y) % 3 else (228, 240, 248)
def river_path(y):
    """河流中线：从 (352,30) 向西南弯到瀑布口 (182,126)"""
    t = (y - 28) / (126 - 28)
    t = max(0, min(1, t))
    return 352 - 170 * t + 18 * math.sin(t * 3.5)
# 上游瀑布：横断河床的岩阶 + 白练 + 瀑潭水花（y 40-58）
fall_cx = river_path(44)
for x in range(int(fall_cx - 13), int(fall_cx + 13)):
    for dy in range(3):
        setp(x, 40 + dy, PAL['cliff'] if (x + dy) % 2 else PAL['rock_d'])
    setp(x, 43, PAL['snow'])                        # 岩阶顶亮边
for y in range(44, 58):                              # 白练跌入瀑潭
    w1 = 9 + (y - 44) * 0.35
    for x in range(int(fall_cx - w1 / 2), int(fall_cx + w1 / 2)):
        setp(x, y, PAL['foam'] if (x * 3 + y) % 4 else PAL['foam_d'])
for _ in range(8):                                   # 瀑潭水花
    setp(fall_cx + rnd.randint(-10, 10), rnd.randint(54, 60), PAL['foam'])
# 河床：瀑布以下（石滩急流段 → 回水湾 → 平缓入海口）
for y in range(58, 128):
    xc = river_path(y)
    w0 = 9 + y * 0.02
    for x in range(int(xc - w0), int(xc + w0)):
        setp(x, y, PAL['sea'] if (x + y) % 3 else PAL['sea_d'])
    setp(int(xc - w0), y, PAL['grass_d']); setp(int(xc + w0), y, PAL['grass_d'])
    setp(int(xc - w0) - 1, y, PAL['dirt']); setp(int(xc + w0) + 1, y, PAL['dirt'])
# 瀑布上方：雪山脚下的源头溪流（窄、夹在岩壁间）
for y in range(26, 41):
    xc = river_path(y)
    w0 = 6
    for x in range(int(xc - w0), int(xc + w0)):
        setp(x, y, PAL['sea'] if (x + y) % 3 else PAL['sea_d'])
    setp(int(xc - w0), y, PAL['rock_d']); setp(int(xc + w0), y, PAL['rock_d'])
# 石滩（中游乱石，瀑布下游）
for x, y, r in [(300, 72, 4), (292, 80, 5), (306, 86, 3), (288, 90, 3)]:
    rock(x, y, r)
# 急流白花
for _ in range(12):
    y = rnd.randint(62, 96); xc = river_path(y)
    x = rnd.randint(int(xc - 6), int(xc + 6))
    line(x, y, x + 3, y + 1, PAL['foam'])
# 回水湾（下游加宽静水）
for y in range(96, 118):
    xc = river_path(y)
    for x in range(int(xc + 8), int(xc + 20)):
        setp(x, y, PAL['sea'] if (x + y) % 2 else shade(PAL['sea'], 1.1))
    setp(int(xc + 20), y, PAL['grass_d'])
# 入海口：河面放宽、平缓汇入大海（无悬崖）+ 泡沫扇
for y in range(116, 130):
    xc = river_path(y)
    w1 = 12 + (y - 116) * 1.2
    for x in range(int(xc - w1), int(xc + w1)):
        setp(x, y, PAL['sea'] if (x + y) % 2 else shade(PAL['sea'], 1.05))
for ang in range(-35, 36, 10):
    for rr in range(4, 16, 4):
        setp(int(coast_x(126)) - rr, 126 + rr * math.sin(math.radians(ang)) * .4, PAL['foam'])

# ============ 5. 落日海湾（左海：沙滩/防波堤灯塔/礁石沉船） ============
# 沙滩（瀑布口下方的海岸带加宽成滩）
for y in range(150, 210):
    cx = coast_x(y)
    for x in range(int(cx) - 2, int(cx) + 14):
        p[x, y] = PAL['sand'] if (x + y) % 4 else PAL['sand_d']
    for x in range(int(cx) - 4, int(cx) - 1):
        setp(x, y, PAL['foam'])
ux, uy = int(coast_x(178)) + 6, 170                      # 遮阳伞
line(ux, uy, ux, uy + 9, PAL['wood_d'])
for dx in range(-6, 7):
    h = 3 - abs(dx) // 2
    for dy in range(h):
        setp(ux + dx, uy - dy, PAL['red'] if dx % 2 else PAL['snow'])
for x, y in [(int(coast_x(196)) + 4, 192), (int(coast_x(188)) + 8, 186)]:
    setp(x, y, (242, 216, 216)); setp(x + 1, y, (216, 168, 168))
for dx, dy in [(0, 0), (-2, 0), (2, 0), (0, -2), (0, 2)]:  # 海星
    setp(int(coast_x(200)) + 8 + dx, 200 + dy, (232, 150, 90))
# 防波堤巨石链 + 灯塔（近岸，环抱海湾）
for x, y, r in [(126, 64, 7), (140, 72, 8), (154, 66, 7), (152, 86, 6)]:
    rock(x, y, r)
lx, ly = 140, 44
rect(lx - 3, ly, lx + 3, ly + 22, PAL['snow'])
rect(lx - 3, ly + 5, lx + 3, ly + 9, PAL['red'])
rect(lx - 3, ly + 14, lx + 3, ly + 18, PAL['red'])
rect(lx - 2, ly - 5, lx + 2, ly, PAL['dark'])
setp(lx, ly - 3, PAL['gold'])
for ang in range(-60, 241, 40):
    setp(lx + 7 * math.cos(math.radians(ang)), ly - 3 + 7 * math.sin(math.radians(ang)), (255, 235, 150))
# 礁石区 + 沉船（左下）
for x, y, r in [(62, 182, 8), (80, 196, 6), (94, 184, 5)]:
    rock(x, y, r)
hull = PAL['wood_d']
for i in range(16):
    line(50 + i, 212 - i * 0.35, 50 + i, 218 - i * 0.35, hull)
line(50, 212, 66, 206, PAL['wood'])
line(58, 210, 58, 196, PAL['wood_d'])
line(58, 198, 66, 202, (200, 180, 140))
setp(54, 211, (232, 122, 106)); setp(55, 212, (232, 122, 106))
setp(62, 208, (214, 154, 120))
for x, y in [(70, 176), (86, 172)]:
    setp(x, y, (232, 122, 106)); setp(x + 1, y - 2, (232, 122, 106)); setp(x + 2, y, (216, 106, 90)); setp(x - 1, y - 1, (216, 106, 90))
for _ in range(14):
    x = rnd.randint(20, 150); y = rnd.randint(40, 220)
    setp(x, y, (90, 164, 216)); setp(x + 1, y, (90, 164, 216))

# ============ 6. 霜月冰湖（陆地右上，山地旁） ============
ellipse(268, 24, 34, 17, PAL['ice'])
ellipse(268, 22, 23, 9, (228, 244, 252))
for ang in range(0, 360, 3):
    x = 268 + 37 * math.cos(math.radians(ang))
    y = 24 + 20 * math.sin(math.radians(ang))
    setp(x, y, PAL['snow']); setp(x, y + 1, PAL['snow'])
line(254, 19, 268, 30, PAL['ice_d']); line(268, 30, 282, 21, PAL['ice_d']); line(268, 30, 274, 36, PAL['ice_d'])
for x, y in [(246, 12), (290, 14), (280, 9), (256, 10)]:
    setp(x, y, PAL['snow'])
sx, sy = 296, 22                       # 雪人
ellipse(sx, sy + 4, 4, 4, PAL['snow'])
ellipse(sx, sy - 2, 3, 3, PAL['snow'])
setp(sx - 1, sy - 3, PAL['dark']); setp(sx + 1, sy - 3, PAL['dark'])
setp(sx, sy - 1, (232, 122, 60))
rect(sx - 2, sy - 7, sx + 2, sy - 5, PAL['dark'])
setp(sx, sy + 2, PAL['red']); setp(sx, sy + 4, PAL['red'])
pine(238, 10, 1.1); pine(310, 14, 1.0)

# ============ 7. 四围陆地边框（上/右/下缘的林地） ============
for x in range(W):
    for y in range(H):
        edge = min(y, H - 1 - y, W - 1 - x)
        if x > coast_x(y) and edge < 7 and p[x, y] not in (PAL['rock_d'], PAL['cliff'], PAL['snow'], (228, 240, 248)):
            if p[x, y] in (PAL['land'], PAL['grass']):
                p[x, y] = PAL['grass_d'] if edge < 2 else p[x, y]
for x, y, s in [(190, 12, 1.2), (210, 8, 1.0), (392, 180, 1.2), (388, 220, 1.0), (200, 238, 1.1), (230, 242, 1.0)]:
    pine(x, y, s)
for x, y in [(224, 16), (380, 200), (214, 234)]:
    bush(x, y)

# ============ 8. 暗角 ============
for y in range(H):
    for x in range(W):
        dx = max(0, (24 - min(x, W - 1 - x)) / 24)
        dy = max(0, (18 - min(y, H - 1 - y)) / 18)
        f = max(dx, dy)
        if f > 0:
            c = p[x, y]
            p[x, y] = shade(c, 1 - f * .25)

img = img.resize((W * CELL, H * CELL), Image.NEAREST)
img.save(OUT)
print('saved', OUT, img.size)
