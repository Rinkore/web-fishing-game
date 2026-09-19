# -*- coding: utf-8 -*-
"""程序化生成像素鱼贴图（与精灵表风格一致：鱼头朝左、像素块、透明底）。
输出到 frontend/assets/fish/<id>.png，仅生成 SHEET 里已有的 17 种之外的鱼。"""
import argparse, os, math, random
from pathlib import Path
from PIL import Image

OUT_DIR = str(Path(__file__).resolve().parents[1] / "frontend" / "assets" / "fish")
CELL = 5                      # 1 逻辑像素 = 5 实际像素
W, H = 44, 26                 # 逻辑画布
SHEET_IDS = {"crucian","carp","grass","white","tilapia","minnow","sardine","croaker",
             "yellowcat","silvercarp","bighead","riverperch","tuna","culter","blackcarp",
             "bass","seabass"}

def hex2rgb(h):
    if isinstance(h, tuple):
        return h
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c)

class Canvas:
    def __init__(self, w=W, h=H):
        self.w, self.h = w, h
        self.px = [[None] * w for _ in range(h)]

    def set(self, x, y, c):
        x, y = int(x), int(y)
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = c

    def fill(self, x0, y0, x1, y1, c):
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                self.set(x, y, c)

    def ellipse(self, cx, cy, rx, ry, c):
        for y in range(self.h):
            for x in range(self.w):
                if ((x - cx) / max(rx, .1)) ** 2 + ((y - cy) / max(ry, .1)) ** 2 <= 1:
                    self.set(x, y, c)

    def tri(self, x0, y0, x1, y1, x2, y2, c):
        """填充三角形（扫描线）"""
        pts = [(x0, y0), (x1, y1), (x2, y2)]
        ymin, ymax = int(min(p[1] for p in pts)), int(max(p[1] for p in pts))
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
                    self.set(x, y, c)

    def line(self, x0, y0, x1, y1, c, thick=1):
        steps = int(max(abs(x1 - x0), abs(y1 - y0), 1))
        for i in range(steps + 1):
            x = x0 + (x1 - x0) * i / steps
            y = y0 + (y1 - y0) * i / steps
            for dx in range(-(thick // 2), thick // 2 + 1):
                for dy in range(-(thick // 2), thick // 2 + 1):
                    self.set(x + dx, y + dy, c)

    def poly(self, pts, c):
        for i in range(1, len(pts) - 1):
            self.tri(pts[0][0], pts[0][1], pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1], c)

    def render(self, path):
        img = Image.new("RGBA", (self.w * CELL, self.h * CELL), (0, 0, 0, 0))
        p = img.load()
        for y in range(self.h):
            for x in range(self.w):
                c = self.px[y][x]
                if c:
                    for dy in range(CELL):
                        for dx in range(CELL):
                            p[x * CELL + dx, y * CELL + dy] = (*c, 255)
        img.save(path)
        return img.size


def draw_fish(cv, base, belly=None, fin=None, *, len_=26, height=12, cx=20, cy=13,
              tail='fork', dorsal=True, pelvic=True, pectoral=True, adipose=False,
              stripes=0, stripe_c=None, spots=0, spot_c=None, eye=1.2, mouth=True,
              head_dark=0, sword=0, whiskers=0, glow=None, lateral=None, rand=7):
    """通用鱼形：头朝左。glow=整体外发光色。"""
    rnd = random.Random(rand)
    base = hex2rgb(base)
    fin = hex2rgb(fin) if fin else shade(base, 0.82)
    belly = hex2rgb(belly) if belly else shade(base, 1.25)
    dark = shade(base, 0.72)
    eye_c, stripe_c = (16, 20, 28), hex2rgb(stripe_c) if stripe_c else dark
    spot_c = hex2rgb(spot_c) if spot_c else dark

    hl, hr = len_ / 2, len_ / 2          # 头在左
    x_head, x_tail = cx - hl, cx + hr

    # ---- 尾巴 ----
    if tail == 'fork':
        cv.tri(x_tail - 1, cy - height * .38, x_tail - 1, cy + height * .38, x_tail + 7, cy - height * .78, fin)
        cv.tri(x_tail - 1, cy - height * .38, x_tail - 1, cy + height * .38, x_tail + 7, cy + height * .78, fin)
    elif tail == 'fan':
        cv.tri(x_tail - 1, cy - height * .42, x_tail - 1, cy + height * .42, x_tail + 6, cy, fin)
    elif tail == 'none':
        pass
    # ---- 身体 ----
    cv.ellipse(cx - 1, cy, hl, height / 2, base)
    # 腹部渐变（下半部变浅）
    for y in range(cv.h):
        for x in range(cv.w):
            if cv.px[y][x] == base and y > cy + 1:
                f = 1 + 0.35 * min(1, (y - cy) / (height / 2 + .1))
                cv.px[y][x] = tuple(min(255, int(v * f)) for v in base)
    # 背部加深
    for y in range(cv.h):
        for x in range(cv.w):
            if cv.px[y][x] is not None and y < cy - height * .28:
                c = cv.px[y][x]
                cv.px[y][x] = shade(c, 0.88)
    # ---- 条纹 ----
    for i in range(stripes):
        sx = x_head + (i + 1) * len_ / (stripes + 1)
        for y in range(cv.h):
            for x in range(cv.w):
                if cv.px[y][x] is not None and abs(x - sx) < 1.3:
                    cv.px[y][x] = stripe_c
    # ---- 侧线 ----
    if lateral:
        lc = hex2rgb(lateral)
        cv.line(x_head + 3, cy + 1, x_tail - 2, cy, lc, thick=1)
    # ---- 斑点 ----
    for _ in range(spots):
        sx = rnd.uniform(x_head + 4, x_tail - 4)
        sy = rnd.uniform(cy - height * .3, cy + height * .3)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if cv.px[int(sy + dy)][int(sx + dx)] is not None:
                    cv.set(sx + dx, sy + dy, spot_c)
    # ---- 背鳍 ----
    if dorsal:
        cv.tri(cx - 4, cy - height / 2 + 1, cx + 6, cy - height / 2 + 1, cx - 1, cy - height / 2 - 4, fin)
    if adipose:  # 脂鳍（小）
        cv.fill(cx + 8, cy - height / 2 - 1, cx + 10, cy - height / 2, fin)
    # ---- 腹鳍 / 胸鳍 ----
    if pelvic:
        cv.tri(cx + 2, cy + height / 2 - 1, cx + 5, cy + height / 2 - 1, cx + 3, cy + height / 2 + 3, fin)
    if pectoral:
        cv.tri(x_head + 5, cy + 1, x_head + 8, cy + 2, x_head + 4, cy + 4, shade(fin, 1.1))
    # ---- 头阴影（有些鱼头深色）----
    if head_dark:
        hc = shade(base, head_dark)
        for y in range(cv.h):
            for x in range(cv.w):
                if cv.px[y][x] is not None and x < x_head + len_ * .28:
                    cv.px[y][x] = hc
    # ---- 嘴 ----
    if mouth:
        cv.fill(x_head - 1, cy, x_head, cy + 1, dark)
    # ---- 剑吻 ----
    if sword:
        cv.tri(x_head, cy - 1.5, x_head, cy + 1.5, x_head - sword, cy, base)
    # ---- 须 ----
    for i in range(whiskers):
        yy = cy - 1 + i * 2
        cv.line(x_head + 1, yy, x_head - 4, yy + 2, dark, thick=1)
    # ---- 眼睛 ----
    ex, ey = x_head + len_ * .18, cy - height * .12
    cv.fill(ex - eye, ey - eye, ex + eye, ey + eye, eye_c)
    cv.set(ex - eye + .5, ey - eye + .5, (240, 240, 240))
    # ---- 发光 ----
    if glow:
        g = hex2rgb(glow)
        out = Canvas(cv.w, cv.h)
        for y in range(cv.h):
            for x in range(cv.w):
                if cv.px[y][x] is None:
                    near = any(0 <= y+dy < cv.h and 0 <= x+dx < cv.w and cv.px[y+dy][x+dx] is not None
                               for dy in (-1, 0, 1) for dx in (-1, 0, 1))
                    if near:
                        out.set(x, y, g)
        for y in range(cv.h):
            for x in range(cv.w):
                if cv.px[y][x] is None:
                    cv.px[y][x] = out.px[y][x]


def gen_loach(cv):
    """泥鳅：细长底栖，偏棕"""
    draw_fish(cv, '#8a6f4d', belly='#b59a72', len_=30, height=5.5, cx=21, cy=14,
              tail='fan', dorsal=False, pelvic=False, pectoral=False, eye=1, rand=11)
    cv.line(8, 12, 8, 16, hex2rgb('#6d5638'), thick=1)  # 触须

def gen_bream(cv):
    """鳊鱼：高而扁的菱形身体"""
    c = hex2rgb('#5d6e5a'); fin = hex2rgb('#48573f'); belly = hex2rgb('#c9cdb4')
    dark = hex2rgb('#3f4d3a')
    cv.poly([(10, 13), (16, 4), (30, 6), (36, 13), (30, 20), (16, 22)], c)
    for y in range(cv.h):
        for x in range(cv.w):
            if cv.px[y][x] == c and y > 14:
                cv.px[y][x] = belly if y > 17 else shade(c, 1.2)
    cv.tri(35, 10, 35, 16, 41, 13, fin)                 # 尾
    cv.tri(18, 5, 26, 6, 22, 1, fin)                    # 背鳍
    cv.tri(20, 21, 26, 20, 23, 24, fin)                 # 臀鳍
    cv.fill(12, 12, 14, 14, dark); cv.set(12.5, 12.5, (240, 240, 240))  # 眼

def gen_clam(cv, base, pearl='#f4f0ff', glow=None):
    """珍珠贝：贝壳 + 珍珠"""
    c = hex2rgb(base); p = hex2rgb(pearl); edge = shade(c, .75)
    cv.ellipse(22, 15, 13, 8, c)                        # 下壳
    cv.tri(9, 15, 22, 3, 35, 15, c)                     # 上壳
    for t in range(0, 6):                               # 壳射线
        cv.line(22, 14, 11 + t * 4.4, 5 + (t % 2), edge)
    cv.ellipse(22, 16, 4.5, 3.5, p)                     # 珍珠
    cv.ellipse(20.5, 15, 1.2, .9, (255, 255, 255))
    if glow:
        g = hex2rgb(glow)
        for ang in range(0, 360, 45):
            x = 22 + math.cos(math.radians(ang)) * 7
            y = 15 + math.sin(math.radians(ang)) * 5
            cv.set(x, y, g)

def gen_lobster(cv):
    """琥珀龙虾"""
    amber = hex2rgb('#c97b2e'); dark = hex2rgb('#8f5218'); claw = hex2rgb('#e09a4a')
    cv.ellipse(16, 14, 9, 4.5, amber)                   # 身体
    cv.ellipse(8, 13, 4, 3.5, claw)                     # 头
    cv.fill(4, 12, 6, 14, dark)                         # 眼柄
    cv.set(4, 12, (20, 20, 28)); cv.set(6, 12, (20, 20, 28))
    cv.line(6, 10, 2, 6, dark); cv.line(8, 10, 6, 5, dark)      # 长触角
    cv.tri(11, 11, 13, 8, 13, 12, claw)                 # 大螯
    cv.tri(11, 17, 13, 20, 13, 16, claw)
    for i in range(4):                                  # 尾节
        cv.fill(24 + i * 3, 12, 25 + i * 3, 16, shade(amber, 1 - i * .08))
    cv.tri(35, 12, 35, 16, 39, 14, dark)                # 尾扇
    for i in range(3):                                  # 步足
        cv.line(14 + i * 4, 18, 13 + i * 4, 22, dark)

def gen_orb(cv, base, ring, star='#ffffff'):
    """宝珠/蛋形物品"""
    c = hex2rgb(base); r = hex2rgb(ring)
    cv.ellipse(22, 13, 8, 8, c)
    cv.ellipse(19, 10, 2.5, 2, hex2rgb(star))
    for ang in range(0, 360, 30):                       # 环绕光点
        x = 22 + math.cos(math.radians(ang)) * 11
        y = 13 + math.sin(math.radians(ang)) * 9
        cv.set(x, y, r)
    cv.ellipse(22, 13, 10, 10, None) if False else None

def gen_ray(cv, base, belly='#cfd8dd', glow=None):
    """魟鱼：扁平菱形 + 长尾"""
    c = hex2rgb(base); fin = hex2rgb(belly)
    cv.poly([(22, 8), (8, 13), (22, 18), (36, 13)], c)  #  disc
    cv.poly([(22, 10), (14, 13), (22, 16), (30, 13)], shade(c, 1.25))
    cv.line(36, 13, 43, 15, shade(c, .8))               # 尾
    cv.set(38, 12, shade(c, .6))
    cv.fill(17, 11, 19, 13, (16, 20, 28)); cv.set(17, 11, (240, 240, 240))  # 眼x2
    cv.fill(26, 11, 28, 13, (16, 20, 28)); cv.set(26, 11, (240, 240, 240))
    cv.set(22, 14, shade(c, .6))                        # 嘴
    if glow:
        g = hex2rgb(glow)
        for ang in range(0, 360, 60):
            cv.set(22 + math.cos(math.radians(ang)) * 13, 13 + math.sin(math.radians(ang)) * 10, g)

def gen_eel(cv):
    """电光鳗：蛇形 + 电纹"""
    c = hex2rgb('#3b6ea5'); lite = hex2rgb('#7fd4ff')
    pts = [(6, 16), (12, 10), (20, 15), (28, 10), (36, 14)]
    for i in range(len(pts) - 1):
        cv.line(*pts[i], *pts[i + 1], c, thick=4)
    cv.ellipse(6, 16, 3, 2.5, c)
    cv.fill(4, 15, 6, 17, (16, 20, 28))
    for i, (x, y) in enumerate([(12, 12), (20, 17), (28, 12), (33, 13)]):
        cv.line(x, y, x + 2, y - 3, lite)
        cv.line(x + 2, y - 3, x + 1, y - 5, lite)
        cv.line(x + 1, y - 5, x + 3, y - 6, lite)
    cv.line(36, 14, 42, 11, shade(c, .8), thick=2)      # 尾尖

def gen_sunfish(cv):
    """翻车鱼： tall oval, 背臀鳍长"""
    c = hex2rgb('#6f7d8c'); fin = hex2rgb('#54606e'); belly = hex2rgb('#aeb9c2')
    cv.ellipse(22, 13, 10, 9, c)
    for y in range(cv.h):
        for x in range(cv.w):
            if cv.px[y][x] == c and y > 14:
                cv.px[y][x] = belly
    cv.tri(14, 5, 30, 5, 22, 0, fin)                    # 背鳍
    cv.tri(14, 21, 30, 21, 22, 25, fin)                 # 臀鳍
    cv.fill(13, 10, 16, 13, (16, 20, 28)); cv.set(13, 10, (240, 240, 240))
    cv.set(12, 16, shade(c, .6))                        # 小口

def gen_white(cv):
    """白条：细长银身、完整叉尾与深色侧线，四周保留至少 2 格。"""
    draw_fish(cv, '#aebbc7', belly='#e8eef2', fin='#7d8e9e', len_=28, height=6,
              cx=20, cy=13, tail='fork', dorsal=True, pelvic=False, pectoral=True,
              lateral='#526879', eye=.8, rand=71)
    cv.fill(6, 12, 7, 13, hex2rgb('#4c6170'))            # 微翘小口

def gen_sardine(cv):
    """沙丁鱼：蓝背银腹，细鳍与叉尾均落在安全区内。"""
    draw_fish(cv, '#3978a6', belly='#d9e5ec', fin='#285a82', len_=28, height=7,
              cx=20, cy=13, tail='fork', dorsal=True, pelvic=True, pectoral=True,
              lateral='#8fc4df', eye=.9, rand=73)
    cv.line(9, 10, 29, 10, hex2rgb('#245174'))

def gen_culter(cv):
    """翘嘴鲌：银灰梭形、上翘吻、背鳍与完整深叉尾。"""
    draw_fish(cv, '#a7b2bd', belly='#edf1f3', fin='#788795', len_=28, height=8,
              cx=20, cy=13, tail='fork', dorsal=True, pelvic=True, pectoral=True,
              lateral='#d7e0e5', eye=.9, rand=79)
    jaw = hex2rgb('#697986')
    cv.line(6, 13, 4, 11, jaw)
    cv.line(4, 11, 7, 11, jaw)

def gen_yellowcheek(cv):
    """鳡鱼：修长掠食鱼体、金色颊斑，吻端和叉尾均不触边。"""
    draw_fish(cv, '#87944f', belly='#d8d5a5', fin='#65713b', len_=28, height=8,
              cx=20, cy=13, tail='fork', dorsal=True, pelvic=True, pectoral=True,
              head_dark=.86, lateral='#b9b96f', eye=.9, rand=83)
    cv.fill(8, 10, 12, 13, hex2rgb('#d8c35f'))           # 金黄颊部
    cv.line(6, 14, 4, 14, hex2rgb('#596430'))            # 完整尖吻

def gen_silvercarp(cv):
    """鲢鱼：高背银身、浅腹与完整叉尾，避免旧图尾鳍裁断。"""
    draw_fish(cv, '#aeb8b5', belly='#e6e9e3', fin='#7d8b87', len_=26, height=11,
              cx=20, cy=13, tail='fork', dorsal=True, pelvic=True, pectoral=True,
              lateral='#cbd2cc', eye=1, rand=89)
    cv.line(11, 9, 11, 17, hex2rgb('#76827e'))            # 鳃盖
    cv.fill(7, 13, 8, 14, hex2rgb('#6b7773'))             # 小口

def gen_koi(cv, base='#e8e4da', patch='#e07830', patch2=None, patches=3, rand=5, glow=None):
    """锦鲤：base 底色 + 两块补丁色（黄金锦鲤 = 金底白斑橙斑）。"""
    c = hex2rgb(base); pc = hex2rgb(patch); p2 = hex2rgb(patch2) if patch2 else None
    rnd = random.Random(rand)
    draw_fish(cv, base, belly=shade(c, 1.12), len_=26, height=11, cx=20, cy=13,
              tail='fork', dorsal=False, eye=1.1, rand=rand, glow=glow)
    for i in range(patches):
        px_, py_ = rnd.uniform(14, 28), rnd.uniform(9, 16)
        cc = pc if i % 2 == 0 or not p2 else p2
        cv.ellipse(px_, py_, rnd.uniform(2.5, 4.5), rnd.uniform(2, 3.5), cc)

def gen_arowana(cv):
    """金龙鱼（亚洲龙鱼）：长圆筒身、大红背金鳞、靠后的长背/臀鳍、圆尾、口须。"""
    gold = hex2rgb('#e8a52c')        # 金鳞
    gold2 = hex2rgb('#f2c14e')       # 亮金
    red = hex2rgb('#c93a2e')         # 红背
    fin = hex2rgb('#d98a1e')         # 鳍
    dark = hex2rgb('#7a4e10')
    # 身体：细长椭圆（头左尾右）
    cv.ellipse(20, 13, 15, 4.5, gold)
    # 背部铺红、向腹部渐金
    for y in range(cv.h):
        for x in range(cv.w):
            if cv.px[y][x] == gold:
                if y < 11:
                    cv.px[y][x] = red if y < 9.5 else hex2rgb('#e8843c')
                elif y > 14:
                    cv.px[y][x] = gold2
    # 大圆鳞：错位网格
    for row, yy in enumerate((10.5, 13, 15.5)):
        for i in range(7):
            xx = 10 + i * 3 + (1.5 if row % 2 else 0)
            if 6 < xx < 33:
                cv.line(xx, yy - 1.5, xx, yy + 1.5, dark)
                cv.set(xx - 1, yy + 1.5, dark)
    # 背鳍：靠后、长条低鳍带鳍条
    cv.poly([(22, 8.5), (31, 9.5), (31, 6.5), (24, 7)], fin)
    for x in range(24, 31, 2):
        cv.line(x, 8, x, 6, dark)
    # 臀鳍：靠后长条
    cv.poly([(22, 17.5), (31, 16.5), (31, 19.5), (24, 19)], fin)
    for x in range(24, 31, 2):
        cv.line(x, 18, x, 20, dark)
    # 圆尾扇
    cv.ellipse(35.5, 13, 3.5, 4, fin)
    cv.line(33, 10, 38, 10, dark); cv.line(33, 16, 38, 16, dark)
    # 头：微翘吻部 + 须
    cv.poly([(5.5, 12.5), (4, 11.5), (6, 11)], red)
    cv.line(5, 12, 2.5, 10.5, dark, thick=1)
    cv.line(5, 13.5, 2.5, 15, dark, thick=1)
    # 眼
    cv.fill(8, 11, 10, 13, (16, 20, 28)); cv.set(8, 11, (255, 240, 200))
    # 鳃盖
    cv.line(11, 9.5, 11, 16.5, dark)
    cv.line(12, 10, 12, 16, hex2rgb('#a86a12'))

def gen_swordfish(cv):
    draw_fish(cv, '#3e5f8a', belly='#c3d3e2', len_=22, height=10, cx=22, cy=13,
              tail='crescent-ish', sword=9, eye=1.1, rand=3)
    cv.tri(33, 10, 33, 16, 40, 13, hex2rgb('#33517a'))  # 新月尾
    cv.tri(15, 7, 24, 8, 19, 3, hex2rgb('#33517a'))     # 高背鳍

def gen_sturgeon(cv):
    draw_fish(cv, '#6d6a63', belly='#a9a49a', len_=30, height=7, cx=21, cy=13,
              tail='shark', adipose=True, eye=1, rand=9)
    cv.tri(31, 10, 31, 16, 40, 13, hex2rgb('#57544e'))  # 歪尾
    for i in range(5):                                  # 骨板
        cv.fill(12 + i * 4, 9, 13 + i * 4, 10, hex2rgb('#c9c4b8'))
        cv.fill(12 + i * 4, 16, 13 + i * 4, 17, hex2rgb('#c9c4b8'))

def gen_arapaima(cv):
    draw_fish(cv, '#7a3f2e', belly='#c98d5a', len_=32, height=8, cx=21, cy=13,
              tail='round', dorsal=False, eye=1, rand=13)
    cv.ellipse(37, 13, 4, 4.5, hex2rgb('#5f3022'))      # 圆尾
    for i in range(6):                                  # 红鳞缘
        cv.line(10 + i * 4, 10, 11 + i * 4, 16, hex2rgb('#d4552e'))

def gen_dragonfish(cv):
    """深海龙鱼：黑身 + 发光钓灯"""
    draw_fish(cv, '#1c2438', belly='#2c3a55', len_=24, height=8, cx=20, cy=14,
              tail='fork', dorsal=False, eye=1.4, mouth=True, rand=17)
    cv.line(9, 9, 6, 4, hex2rgb('#1c2438'), thick=1)    # 钓竿
    cv.set(6, 4, hex2rgb('#9fe8ff')); cv.set(5, 4, hex2rgb('#9fe8ff'))
    cv.set(6, 3, hex2rgb('#e8fbff'))
    cv.fill(11, 13, 14, 15, (255, 120, 60))            # 大口牙光


def build(fid):
    cv = Canvas()
    if fid == 'loach': gen_loach(cv)
    elif fid == 'bream': gen_bream(cv)
    elif fid == 'catfish':
        draw_fish(cv, '#4a5568', belly='#8b95a3', len_=26, height=12, cx=20, cy=13,
                  tail='fan', whiskers=3, head_dark=.8, eye=1.1, rand=19)
    elif fid == 'grouper':
        draw_fish(cv, '#7a6a55', belly='#b3a68f', len_=24, height=13, cx=20, cy=13,
                  tail='fan', spots=8, eye=1, mouth=False, rand=23)
        cv.fill(7, 13, 10, 16, hex2rgb('#5c4f3e'))      # 厚唇
    elif fid == 'cobia':
        draw_fish(cv, '#4f4a42', belly='#d8d2c4', len_=28, height=9, cx=21, cy=13,
                  tail='fork', stripes=2, eye=1, rand=29)
    elif fid == 'rubysnapper':
        draw_fish(cv, '#c43b4e', belly='#f0a0a8', len_=24, height=12, cx=20, cy=13,
                  tail='fork', eye=1.6, rand=31)
        cv.fill(12, 11, 14, 13, (30, 22, 18)); cv.set(12, 11, (255, 214, 150))  # 金目大眼
    elif fid == 'sturgeon': gen_sturgeon(cv)
    elif fid == 'sunfish': gen_sunfish(cv)
    elif fid == 'mandarin':
        draw_fish(cv, '#5f7a52', belly='#c4cfa8', len_=22, height=11, cx=20, cy=13,
                  tail='fan', spots=10, eye=1, rand=37)
    elif fid == 'arapaima': gen_arapaima(cv)
    elif fid == 'blackbass':
        draw_fish(cv, '#4f6b3a', belly='#c8d6a8', len_=24, height=10, cx=20, cy=13,
                  tail='fan', lateral='#e8e4c8', eye=1.1, rand=41)
        cv.fill(6, 12, 10, 16, hex2rgb('#3c5230'))      # 大口
    elif fid == 'mackerel':
        draw_fish(cv, '#3f6f8e', belly='#c9dbe4', len_=28, height=8, cx=21, cy=13,
                  tail='fork', stripes=5, eye=1, rand=43)
    elif fid == 'yellowcheek': gen_yellowcheek(cv)
    elif fid == 'silvercarp': gen_silvercarp(cv)
    elif fid == 'culter': gen_culter(cv)
    elif fid == 'sardine': gen_sardine(cv)
    elif fid == 'white': gen_white(cv)
    elif fid == 'bluefin':
        draw_fish(cv, '#2e4f7e', belly='#dfe6ee', len_=26, height=10, cx=20, cy=13,
                  tail='fork', eye=1.1, rand=61)
        cv.fill(14, 8, 17, 11, hex2rgb('#ffd23e'))      # 黄鳍
        cv.fill(24, 16, 26, 19, hex2rgb('#ffd23e'))
    elif fid == 'koi': gen_koi(cv, base='#e8b52e', patch='#f8f4e8', patch2='#e8843c')
    elif fid == 'moonkoi': gen_koi(cv, base='#dfe6ee', patch='#9fb8d8', patches=2, rand=53, glow='#cfe0ff')
    elif fid == 'swordfish': gen_swordfish(cv)
    elif fid == 'pearl': gen_clam(cv, '#7a5f8a')
    elif fid == 'dragonpearl': gen_orb(cv, '#3ec6b8', '#ffd34d')
    elif fid == 'amberlobster': gen_lobster(cv)
    elif fid == 'voltaiceel': gen_eel(cv)
    elif fid == 'ghostray': gen_ray(cv, '#aebfd0', glow='#e8f4ff')
    elif fid == 'arowana': gen_arowana(cv)
    elif fid == 'dragonfish': gen_dragonfish(cv)
    else:
        raise ValueError(fid)
    return cv

ALL = ['loach','bream','catfish','grouper','cobia','rubysnapper','sturgeon','sunfish',
       'mandarin','arapaima','blackbass','mackerel','yellowcheek','bluefin','koi','swordfish',
       'pearl','amberlobster','voltaiceel','ghostray','arowana','moonkoi','dragonfish',
       'culter','sardine','white','silvercarp']

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ids', nargs='+', choices=ALL, help='Only regenerate the listed fish ids')
    args = parser.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    for fid in (args.ids or ALL):
        size = build(fid).render(os.path.join(OUT_DIR, fid + '.png'))
        print(fid, size)
