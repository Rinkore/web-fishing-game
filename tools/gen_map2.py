# -*- coding: utf-8 -*-
"""精细像素世界地图 v2：400x250 逻辑像素 x4 = 1600x1000。
静水湖(左) / 急流河(中) / 落日海湾(右) / 霜月冰湖(上)，大量细节：抖动着色、
松树、码头灯笼、睡莲、灯塔、沉船、雪人、花丛、岩石、水波纹理。"""
import os, math, random
from PIL import Image

W, H, CELL = 400, 250, 4
OUT = r"C:\Users\qxl\web-fishing-game\frontend\assets\worldmap.png"
rnd = random.Random(7)

PAL = {
    'water': (26, 74, 120), 'water_d': (18, 56, 94), 'water_l': (45, 122, 184),
    'foam': (207, 232, 248), 'foam_d': (158, 203, 232),
    'land': (36, 80, 48), 'grass': (47, 106, 60), 'grass_l': (63, 138, 76), 'grass_d': (28, 64, 38),
    'dirt': (122, 90, 56), 'sand': (224, 200, 143), 'sand_d': (201, 168, 106),
    'wood': (138, 106, 66), 'wood_d': (95, 70, 38),
    'rock': (122, 132, 144), 'rock_d': (90, 100, 112),
    'ice': (191, 228, 248), 'ice_d': (158, 203, 224), 'snow': (255, 255, 255),
    'tree': (47, 106, 60), 'tree_d': (31, 74, 46), 'tree_l': (74, 154, 88), 'trunk': (95, 70, 38),
    'red': (232, 74, 58), 'gold': (255, 210, 62), 'dark': (10, 22, 38),
}

img = Image.new('RGB', (W, H), PAL['water_d'])
p = img.load()

def setp(x, y, c):
    x, y = int(round(x)), int(round(y))
    if 0 <= x < W and 0 <= y < H:
        p[x, y] = c

def getp(x, y):
    x, y = int(round(x)), int(round(y))
    if 0 <= x < W and 0 <= y < H:
        return p[x, y]
    return None

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
    """松树：三层树冠 + 树干 + 高光"""
    w = 7 * s
    for k, (hh, cc) in enumerate([(5, PAL['tree_d']), (4, PAL['tree']), (3, PAL['tree_l'])]):
        cy = y - k * 3 * s
        tri(x - w + k * s, cy, x + w - k * s, cy, x, cy - hh * s, cc)
    rect(x - 1, y, x + 1, y + 2 * s, PAL['trunk'])
    setp(x - 1, y - 6 * s, PAL['snow'] if s > 1.1 else PAL['tree_l'])

def bush(x, y, s=1.0):
    ellipse(x, y, 3.5 * s, 2.5 * s, PAL['tree_d'])
    ellipse(x - 1, y - 1, 2 * s, 1.5 * s, PAL['tree'])
    setp(x + 1, y - 1, PAL['tree_l']); setp(x - 2, y, PAL['tree_l'])

def flower(x, y, c):
    setp(x, y, c); setp(x - 1, y, c); setp(x + 1, y, c); setp(x, y - 1, c)
    setp(x, y + 1, PAL['grass_d'])

def rock(x, y, r=3):
    ellipse(x, y, r, r - 1, PAL['rock_d'])
    ellipse(x - 0.5, y - 0.5, r - 1.5, r - 2, PAL['rock'])
    setp(x - 1, y - 1, (184, 194, 204))

def grass_tuft(x, y):
    setp(x, y, PAL['grass_l']); setp(x + 1, y - 1, PAL['grass_l']); setp(x + 2, y, PAL['grass'])

def is_water(c):
    return c in (PAL['water'], PAL['water_d'], PAL['water_l'], shade(PAL['water'], .85))

# ============ 1. 基础水体（深海渐变 + 波纹抖动） ============
for y in range(H):
    t = y / H
    c = tuple(int(PAL['water'][i] + (PAL['water_d'][i] - PAL['water'][i]) * t) for i in range(3))
    for x in range(W):
        p[x, y] = c
# 水波纹理：短水平弧线群
for _ in range(90):
    x = rnd.randint(4, W - 8); y = rnd.randint(6, H - 6)
    ln = rnd.randint(2, 5)
    for i in range(ln):
        setp(x + i, y, PAL['water_l'])
    if rnd.random() < .4:
        setp(x + 1, y - 1, PAL['water_l'])

# ============ 2. 四围陆地（厚边框，草地纹理） ============
for x in range(W):
    for y in range(H):
        edge = min(x, y, W - 1 - x, H - 1 - y)
        n = 9 + int(3 * math.sin(x / 17) + 2 * math.sin(y / 13))
        if edge < n:
            p[x, y] = PAL['land'] if (x * 7 + y * 3) % 5 else PAL['grass']
            if edge == n or edge == n - 1:
                p[x, y] = PAL['grass_d']          # 岸线描边
            if rnd.random() < .06:
                p[x, y] = PAL['grass_l']          # 草地噪点
# 陆地点缀
for _ in range(26):
    x = rnd.randint(3, W - 3); y = rnd.randint(3, H - 3)
    edge = min(x, y, W - 1 - x, H - 1 - y)
    if 3 < edge < 16:
        grass_tuft(x, y)
for _ in range(14):
    x = rnd.randint(3, W - 3); y = rnd.randint(3, H - 3)
    edge = min(x, y, W - 1 - x, H - 1 - y)
    if 3 < edge < 14:
        flower(x, y, rnd.choice([(255, 210, 62), (232, 122, 106), (214, 154, 255)]))
# 松树群（左上、湖与河之间、右上）
for x, y, s in [(14, 12, 1.3), (26, 9, 1.0), (40, 14, 1.2), (100, 10, 1.1), (120, 7, 0.9),
                (240, 8, 1.2), (258, 12, 1.0), (392, 60, 1.1), (394, 90, 1.0), (8, 200, 1.2), (14, 226, 1.0)]:
    pine(x, y, s)
for x, y in [(52, 8), (134, 12), (228, 10), (380, 76), (24, 216)]:
    bush(x, y)

# ============ 3. 静水湖（左，含码头/睡莲/芦苇/波光） ============
ellipse(78, 125, 62, 55, PAL['water'])
ellipse(78, 130, 46, 42, PAL['water_d'])
ellipse(78, 128, 34, 30, PAL['water'], dither=PAL['water_d'])   # 深水抖动过渡
ellipse(70, 100, 30, 16, PAL['water_l'])                        # 浅水反光
# 湖岸：草边 + 泥土内缘
for ang in range(0, 360, 2):
    x = 78 + 65 * math.cos(math.radians(ang))
    y = 125 + 58 * math.sin(math.radians(ang))
    setp(x, y, PAL['grass_d']); setp(x, y + 1, PAL['grass_d'])
for ang in range(0, 360, 3):
    x = 78 + 63 * math.cos(math.radians(ang))
    y = 125 + 56 * math.sin(math.radians(ang))
    setp(x, y, PAL['dirt'])
# 湖岸松与灌
pine(30, 78, 1.0); bush(46, 70); bush(118, 84); rock(128, 120, 2)
# 老旧码头（左上，木板 + 桩 + 绳 + 灯笼）
for i in range(16):
    for j in range(5):
        c = PAL['wood'] if (i % 2 == 0) else shade(PAL['wood'], .85)
        setp(52 + i, 82 + j, c)
    setp(52 + i, 82, PAL['wood_d']); setp(52 + i, 86, PAL['wood_d'])
for px_ in (53, 61, 68):                                        # 木桩
    rect(px_, 80, px_, 88, PAL['wood_d'])
    setp(px_, 79, PAL['wood'])
line(53, 80, 61, 81, (200, 180, 140)); line(61, 81, 68, 80, (200, 180, 140))  # 绳
# 码头灯笼
rect(68, 76, 70, 79, PAL['dark'])
setp(69, 77, PAL['gold']); setp(69, 78, (255, 235, 150))
for ang in range(0, 360, 45):
    setp(69 + 4 * math.cos(math.radians(ang)), 78 + 4 * math.sin(math.radians(ang)), (255, 225, 120))
# 睡莲（湖面点缀）
for x, y in [(96, 108), (104, 118), (88, 134), (112, 140), (66, 148)]:
    ellipse(x, y, 2, 1, PAL['tree_l'])
    setp(x, y - 1, (240, 200, 220))
# 芦苇（左下湖岸，一丛）
for bx, bh in [(36, 13), (41, 16), (47, 11), (31, 9), (52, 10)]:
    line(bx, 162, bx, 162 - bh, PAL['tree'])
    setp(bx - 1, 162 - bh - 1, (168, 132, 90)); setp(bx, 162 - bh - 2, (168, 132, 90)); setp(bx + 1, 162 - bh - 1, (168, 132, 90))
# 湖面波光
for _ in range(14):
    x = rnd.randint(45, 115); y = rnd.randint(88, 158)
    setp(x, y, (127, 196, 236)); setp(x + 1, y, (127, 196, 236))

# ============ 4. 急流河（中，S 弯 + 乱石 + 白花 + 瀑布） ============
def river_cx(y):
    return 200 + 14 * math.sin(y / 34)
for y in range(14, 246):
    w0 = 15 + y * 0.03
    xc = river_cx(y)
    for x in range(int(xc - w0), int(xc + w0)):
        c = PAL['water'] if (x + y) % 3 else PAL['water_d']
        setp(x, y, c)
    setp(int(xc - w0), y, PAL['grass_d']); setp(int(xc + w0), y, PAL['grass_d'])
    setp(int(xc - w0) - 1, y, PAL['dirt']); setp(int(xc + w0) + 1, y, PAL['dirt'])
# 上游乱石（石滩）与溅花
for x, y, r in [(190, 52, 4), (202, 60, 5), (196, 70, 3), (208, 48, 3)]:
    rock(x, y, r)
for _ in range(16):
    y = rnd.randint(30, 170); xc = river_cx(y)
    x = rnd.randint(int(xc - 10), int(xc + 10))
    line(x, y, x + 3, y + 1, PAL['foam'])
# 中游回水湾（河面加宽 + 静水色）
for y in range(100, 140):
    xc = river_cx(y)
    for x in range(int(xc + 12), int(xc + 26)):
        setp(x, y, PAL['water'] if (x + y) % 2 else shade(PAL['water'], 1.1))
    setp(int(xc + 26), y, PAL['grass_d'])
# 下游瀑布：变宽 + 白练 + 水雾
for y in range(185, 246):
    xc = river_cx(y)
    w1 = 17 + (y - 185) * 0.45
    for x in range(int(xc - w1), int(xc + w1)):
        c = PAL['foam'] if (x * 3 + y) % 4 else PAL['foam_d']
        setp(x, y, c)
rect(int(river_cx(184)) - 15, 182, int(river_cx(184)) + 15, 184, (240, 248, 252))
for _ in range(10):                                              # 水雾
    x = river_cx(190) + rnd.randint(-18, 18); y = rnd.randint(184, 192)
    setp(x, y, (230, 244, 252))

# ============ 5. 落日海湾（右：沙滩/贝壳/防波堤灯塔/礁石沉船） ============
ellipse(338, 140, 84, 108, PAL['water'])
ellipse(330, 150, 60, 80, PAL['water'], dither=PAL['water_d'])
# 海岸沙滩（右上）
for x in range(272, 400):
    for y in range(H):
        coast = 42 + 16 * math.sin(x / 32)
        if y < coast:
            p[x, y] = PAL['sand'] if (x + y) % 4 else PAL['sand_d']
        elif y < coast + 3:
            p[x, y] = PAL['foam']                                 # 浪花边
# 沙滩装饰：遮阳伞 + 海星 + 贝壳
ux, uy = 306, 22
line(ux, uy, ux, uy + 9, PAL['wood_d'])
for dx in range(-6, 7):
    h = 3 - abs(dx) // 2
    for dy in range(h):
        setp(ux + dx, uy - dy, PAL['red'] if dx % 2 else PAL['snow'])
for x, y in [(288, 30), (330, 34), (352, 26)]:
    setp(x, y, (242, 216, 216)); setp(x + 1, y, (216, 168, 168))   # 贝壳
for x, y in [(320, 36)]:
    for dx, dy in [(0, 0), (-2, 0), (2, 0), (0, -2), (0, 2)]:      # 海星
        setp(x + dx, y + dy, (232, 150, 90))
# 防波堤（右中巨石链 + 灯塔）
for x, y, r in [(330, 108, 7), (344, 116, 8), (360, 110, 7), (374, 122, 6)]:
    rock(x, y, r)
lx, ly = 352, 88                                                  # 灯塔
rect(lx - 3, ly, lx + 3, ly + 22, PAL['snow'])
rect(lx - 3, ly + 5, lx + 3, ly + 9, PAL['red'])
rect(lx - 3, ly + 14, lx + 3, ly + 18, PAL['red'])
rect(lx - 2, ly - 5, lx + 2, ly, PAL['dark'])
setp(lx, ly - 3, PAL['gold'])
for ang in range(-60, 241, 40):                                   # 灯光束
    setp(lx + 7 * math.cos(math.radians(ang)), ly - 3 + 7 * math.sin(math.radians(ang)), (255, 235, 150))
# 礁石区 + 沉船（右下）
for x, y, r in [(300, 196, 8), (318, 210, 6), (332, 198, 5)]:
    rock(x, y, r)
# 沉船残骸：斜置船体 + 断桅
hull = PAL['wood_d']
for i in range(16):
    line(288 + i, 226 - i * 0.35, 288 + i, 232 - i * 0.35, hull)
line(288, 226, 304, 220, PAL['wood'])
line(296, 224, 296, 210, PAL['wood_d'])                           # 断桅
line(296, 212, 304, 216, (200, 180, 140))                         # 破帆绳
setp(292, 225, (232, 122, 106)); setp(293, 226, (232, 122, 106))  # 珊瑚附着
setp(300, 222, (214, 154, 120))
# 珊瑚丛
for x, y in [(308, 190), (324, 186)]:
    setp(x, y, (232, 122, 106)); setp(x + 1, y - 2, (232, 122, 106)); setp(x + 2, y, (216, 106, 90)); setp(x - 1, y - 1, (216, 106, 90))
# 海面波光
for _ in range(16):
    x = rnd.randint(280, 390); y = rnd.randint(70, 230)
    setp(x, y, (90, 164, 216)); setp(x + 1, y, (90, 164, 216))

# ============ 6. 霜月冰湖（上中：冰面 + 裂纹 + 雪 + 雪人） ============
ellipse(148, 33, 38, 20, PAL['ice'])
ellipse(148, 30, 26, 11, (228, 244, 252))
for ang in range(0, 360, 3):
    x = 148 + 41 * math.cos(math.radians(ang))
    y = 33 + 23 * math.sin(math.radians(ang))
    setp(x, y, PAL['snow']); setp(x, y + 1, PAL['snow'])
line(133, 27, 148, 38, PAL['ice_d']); line(148, 38, 163, 29, PAL['ice_d']); line(148, 38, 156, 44, PAL['ice_d'])
for x, y in [(124, 18), (170, 20), (160, 14), (136, 15), (180, 28)]:
    setp(x, y, PAL['snow'])                                       # 雪点
# 雪人（冰湖右缘）
sx, sy = 176, 30
ellipse(sx, sy + 4, 4, 4, PAL['snow'])
ellipse(sx, sy - 2, 3, 3, PAL['snow'])
setp(sx - 1, sy - 3, PAL['dark']); setp(sx + 1, sy - 3, PAL['dark'])
setp(sx, sy - 1, (232, 122, 60))                                  # 胡萝卜鼻
rect(sx - 2, sy - 7, sx + 2, sy - 5, PAL['dark'])                 # 小帽
setp(sx, sy + 2, PAL['red']); setp(sx, sy + 4, PAL['red'])
# 霜月冰湖周围雪松
pine(112, 8, 1.1); pine(188, 10, 1.0)

# ============ 7. 暗角（四角压暗，聚焦中央） ============
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
