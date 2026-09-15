# -*- coding: utf-8 -*-
"""像素世界地图：静水湖(左) / 急流河(中) / 落日海湾(右) / 霜月冰湖(上)。
输出 frontend/assets/worldmap.png（320x200 逻辑像素 ×4 放大）。"""
import os, math, random
from PIL import Image

W, H, CELL = 320, 200, 4
OUT = r"C:\Users\qxl\web-fishing-game\frontend\assets\worldmap.png"
rnd = random.Random(42)

def hx(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)

img = Image.new('RGB', (W, H), hx('#123c68'))
p = img.load()

def setp(x, y, c):
    x, y = int(x), int(y)
    if 0 <= x < W and 0 <= y < H:
        p[x, y] = c

def ellipse(cx, cy, rx, ry, c):
    for y in range(H):
        for x in range(W):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                setp(x, y, c)

def line(x0, y0, x1, y1, c, thick=1):
    steps = int(max(abs(x1 - x0), abs(y1 - y0), 1))
    for i in range(steps + 1):
        x = x0 + (x1 - x0) * i / steps
        y = y0 + (y1 - y0) * i / steps
        for dx in range(-(thick // 2), thick // 2 + 1):
            for dy in range(-(thick // 2), thick // 2 + 1):
                setp(x + dx, y + dy, c)

# ---------- 陆地边缘（四围暗绿陆地，中间留出海/河/湖） ----------
land, grass = hx('#1f4a2e'), hx('#2f6a3c')
for x in range(W):
    for y in range(H):
        edge = min(x, y, W - 1 - x, H - 1 - y)
        n = 6 + rnd.randint(0, 4)
        if edge < n:
            p[x, y] = land if rnd.random() < .6 else grass

# ---------- 静水湖（左侧大湖） ----------
lake = hx('#1a4f80'); lake_d = hx('#154060')
ellipse(62, 100, 52, 46, lake)
ellipse(62, 104, 40, 36, lake_d)            # 深水
ellipse(60, 88, 30, 18, hx('#215d94'))      # 浅水反光
# 湖岸草圈
for ang in range(0, 360, 3):
    x = 62 + 55 * math.cos(math.radians(ang))
    y = 100 + 49 * math.sin(math.radians(ang))
    setp(x, y, grass); setp(x, y + 1, grass)
# 老旧码头（左上伸入湖中的木栈桥）
wood, wood_d = hx('#8a6a42'), hx('#5f4626')
for i in range(14):
    for j in range(4):
        p[42 + i, 66 + j] = wood if (i + j) % 3 else wood_d
p[55, 64] = wood_d; p[55, 65] = wood_d      # 系缆桩
# 芦苇（左下湖岸）
for bx, bh in [(28, 10), (33, 13), (38, 9), (24, 7)]:
    line(bx, 128, bx, 128 - bh, hx('#5f8a3c'))
    p[bx - 1, 128 - bh - 1] = hx('#a8845a'); p[bx, 128 - bh - 2] = hx('#a8845a'); p[bx + 1, 128 - bh - 1] = hx('#a8845a')
# 湖心波光
for _ in range(10):
    x = rnd.randint(35, 90); y = rnd.randint(75, 125)
    p[x, y] = hx('#7fc4ec')

# ---------- 急流河（中间纵向河带，上窄下宽） ----------
river = hx('#2a6ea0'); river_d = hx('#1f5784')
for y in range(14, 196):
    w0 = 12 + (y - 14) * 0.05
    xc = 158 + 10 * math.sin(y / 28)
    for x in range(int(xc - w0), int(xc + w0)):
        setp(x, y, river if (x + y) % 3 else river_d)
# 河岸
for y in range(14, 196):
    w0 = 12 + (y - 14) * 0.05 + 2
    xc = 158 + 10 * math.sin(y / 28)
    setp(int(xc - w0), y, grass); setp(int(xc + w0), y, grass)
# 上游乱石（石滩）
for x, y, r in [(152, 40, 4), (162, 46, 5), (156, 55, 3)]:
    ellipse(x, y, r, r - 1, hx('#8a949e'))
# 急流白花
for y in range(24, 140, 7):
    xc = 158 + 10 * math.sin(y / 28)
    line(xc - 4, y, xc + 3, y + 1, hx('#cfe8f8'))
# 瀑布（下游变宽变白）
for y in range(150, 196):
    xc = 158 + 10 * math.sin(y / 28)
    w1 = 14 + (y - 150) * 0.25
    for x in range(int(xc - w1), int(xc + w1)):
        setp(x, y, hx('#cfe8f8') if (x * 3 + y) % 4 else hx('#9ecbe8'))
for x in range(140, 178, 4):
    p[x, 149] = hx('#ffffff')

# ---------- 落日海湾（右侧大海 + 海岸） ----------
ocean = hx('#174878')
ellipse(270, 110, 68, 88, ocean)
# 海岸线（右上沙滩）
sand, sand_d = hx('#d8c08a'), hx('#b89c62')
for x in range(218, 320):
    for y in range(H):
        coast = 34 + 12 * math.sin(x / 26)
        if y < coast:
            p[x, y] = sand if (x + y) % 4 else sand_d
# 沙滩上贝壳
for x, y in [(236, 22), (258, 30), (284, 18)]:
    p[x, y] = hx('#f2d8d8'); p[x + 1, y] = hx('#d8a8a8')
# 防波堤（右侧海中巨石链）
for x, y in [(262, 88), (272, 96), (282, 92), (292, 102)]:
    ellipse(x, y, 6, 5, hx('#7a8490'))
    ellipse(x - 1, y - 1, 3, 2, hx('#9aa4ae'))
# 礁石区（右下）
for x, y, r in [(238, 150, 7), (252, 162, 6), (264, 154, 5)]:
    ellipse(x, y, r, r, hx('#4a5460'))
p[246, 144] = hx('#e87a6a'); p[247, 145] = hx('#e87a6a'); p[246, 146] = hx('#d86a5a')   # 珊瑚
# 海面波光
for _ in range(14):
    x = rnd.randint(215, 310); y = rnd.randint(55, 180)
    p[x, y] = hx('#5aa4d8')

# ---------- 霜月冰湖（左上结冰小湖，锁定区域） ----------
ice, ice_d = hx('#bfe4f8'), hx('#9ecbe0')
ellipse(118, 26, 30, 16, ice)
ellipse(118, 24, 20, 9, hx('#e4f4fc'))
for ang in range(0, 360, 4):                        # 雪边
    x = 118 + 32 * math.cos(math.radians(ang))
    y = 26 + 18 * math.sin(math.radians(ang))
    setp(x, y, hx('#ffffff')); setp(x, y + 1, hx('#ffffff'))
line(106, 22, 118, 30, ice_d)                        # 冰裂纹
line(118, 30, 130, 24, ice_d)
line(118, 30, 124, 34, ice_d)
for x, y in [(100, 14), (140, 16), (128, 12)]:       # 雪花点
    p[x, y] = hx('#ffffff')

img = img.resize((W * CELL, H * CELL), Image.NEAREST)
img.save(OUT)
print('saved', OUT, img.size)
