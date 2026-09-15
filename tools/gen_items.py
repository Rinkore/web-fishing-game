# -*- coding: utf-8 -*-
"""生成图鉴其余条目的贴图：材料(4) + 组件底材(30) -> assets/item/<id>.png；钓点(9) -> assets/spot/<id>.png。
像素风格与鱼贴图一致（透明底、最近邻放大）。"""
import os, math
from gen_fish import Canvas, hex2rgb, shade

ROOT = r"C:\Users\qxl\web-fishing-game\frontend\assets"
ITEM_DIR = os.path.join(ROOT, "item")
SPOT_DIR = os.path.join(ROOT, "spot")
CELL = 8
W = H = 28

def new():
    return Canvas(W, H)

def water(cv, y0=17, c='#2e6ea8', lite='#5aa4d8'):
    c, lite = hex2rgb(c), hex2rgb(lite)
    cv.fill(0, y0, W - 1, H - 1, c)
    for x in range(0, W, 4):
        cv.fill(x, y0, min(x + 1, W - 1), y0, lite)
    for x in range(2, W, 6):
        cv.fill(x, y0 + 4, min(x + 1, W - 1), y0 + 4, shade(c, 1.25))

# ---------- 材料 ----------
def m_bait_pack(cv):
    """诱饵包：束口布袋 + 露出的小虫"""
    bag, dark, tie = hex2rgb('#b08a4f'), hex2rgb('#7d5e33'), hex2rgb('#5f4626')
    cv.ellipse(14, 17, 9, 8, bag)
    cv.fill(9, 8, 19, 11, dark)                      # 束口
    cv.fill(12, 5, 16, 9, tie)                       # 绳结
    cv.line(14, 5, 11, 2, tie); cv.line(14, 5, 17, 2, tie)
    cv.fill(12, 15, 14, 18, shade(bag, 1.25))        # 高光
    worm = hex2rgb('#d97f6a')
    cv.line(6, 9, 4, 5, worm, thick=2); cv.line(4, 5, 6, 3, worm, thick=2)

def m_rope(cv):
    """耐磨绳：盘绕的绳圈"""
    c, dark = hex2rgb('#c9a86a'), hex2rgb('#8f7440')
    cv.ellipse(14, 15, 10, 9, c)
    cv.ellipse(14, 15, 6, 5, dark)
    cv.ellipse(14, 15, 3, 2.5, c)
    cv.line(21, 20, 25, 23, c, thick=2)              # 绳头
    cv.line(4, 11, 8, 9, shade(c, 1.2), thick=1)

def m_lure(cv):
    """反光假饵：勺形亮片 + 三锚钩"""
    spoon, hook = hex2rgb('#d8e2ea'), hex2rgb('#8a949e')
    cv.line(14, 2, 14, 8, hook)                      # 线
    cv.ellipse(14, 12, 3, 5, spoon)                  # 勺身
    cv.fill(13, 9, 14, 15, hex2rgb('#ffffff'))       # 反光
    cv.line(14, 17, 14, 20, hook)
    cv.line(14, 20, 11, 22, hook); cv.line(14, 20, 17, 22, hook)
    cv.line(11, 22, 11, 25, hook); cv.line(17, 22, 17, 25, hook)

def m_relic(cv):
    """沉船宝匣残片：破木板 + 铜角 + 裂纹"""
    wood, dark, brass = hex2rgb('#7a5a38'), hex2rgb('#54391f'), hex2rgb('#c9963e')
    cv.poly([(5, 8), (23, 6), (24, 20), (6, 22)], wood)
    cv.fill(5, 8, 9, 12, brass)                      # 铜角
    cv.line(10, 8, 12, 21, dark); cv.line(17, 7, 19, 20, dark)
    cv.line(13, 12, 16, 15, dark); cv.line(16, 15, 14, 17, dark)  # 裂纹

# ---------- 组件（按部位画基础形 + 底材配色/细节）----------
def c_rod(cv, color, grip='#3a2e22', ring=True, segments=0):
    rod = hex2rgb(color)
    cv.line(6, 24, 22, 5, rod, thick=2)              # 竿体
    cv.line(5, 26, 9, 22, hex2rgb(grip), thick=3)    # 握把
    cv.line(21, 6, 23, 3, shade(rod, 1.2), thick=1)  # 竿梢
    if ring:
        cv.ellipse(23, 3, 1.5, 1.5, hex2rgb('#9aa4ae'))
    for i in range(segments):                        # 竹节/骨节
        t = 0.3 + i * 0.2
        x, y = 6 + (22 - 6) * t, 24 + (5 - 24) * t
        cv.line(x - 1, y, x + 1, y, shade(rod, .7), thick=1)

def c_line(cv, color, hole='#3a3f46'):
    c = hex2rgb(color)
    cv.ellipse(14, 15, 9, 9, c)                      # 线杯
    cv.ellipse(14, 15, 3.5, 3.5, hex2rgb(hole))
    for r in (7, 5):                                 # 绕线圈
        for ang in range(0, 360, 30):
            cv.set(14 + math.cos(math.radians(ang)) * r, 15 + math.sin(math.radians(ang)) * r, shade(c, 1.15))
    cv.line(20, 9, 24, 5, c, thick=1)                # 抽出的线

def c_hook(cv, color, glow=False, barb=True):
    """鱼钩：钩眼 + 钩柄 + J 形钩弯 + 内弯钩尖 + 可选倒刺（用粗线描轮廓，不再用实心块）。"""
    c = hex2rgb(color)
    lite = shade(c, 1.3)
    # 钩眼（顶部小环）
    cv.set(13, 2, c); cv.set(15, 2, c)
    cv.set(12, 3, c); cv.set(16, 3, c)
    cv.set(13, 4, c); cv.set(15, 4, c)
    # 鱼线
    cv.line(14, 0, 14, 2, hex2rgb('#c8d4dc'), thick=1)
    # 钩柄
    cv.line(14, 4, 14, 14, c, thick=2)
    # 钩弯：圆心在 (10,14)、半径 4.5 的弧，从右侧(接柄)经底部扫到左上
    cx, cy, r = 10, 14, 4.5
    prev = None
    for deg in range(0, 205, 15):
        x = cx + r * math.cos(math.radians(deg))
        y = cy + r * math.sin(math.radians(deg))
        if prev:
            cv.line(prev[0], prev[1], x, y, c, thick=2)
        prev = (x, y)
    # 钩尖：从弧末端向圆心方向折返上翘
    tipx, tipy = prev
    cv.line(tipx, tipy, tipx + 2.2, tipy - 3.2, lite, thick=2)
    # 倒刺：钩尖根部的小倒钩
    if barb:
        cv.line(tipx + 1.2, tipy - 1.2, tipx + 3.0, tipy + 0.2, lite, thick=1)
    if glow:
        g = hex2rgb('#b07aff')
        for ang in range(0, 360, 60):
            cv.set(13 + math.cos(math.radians(ang)) * 9, 13 + math.sin(math.radians(ang)) * 9, g)

def c_bait_corn(cv):
    y, k = hex2rgb('#e8c33c'), hex2rgb('#c79a22')
    cv.ellipse(14, 15, 5, 9, y)
    for yy in range(8, 23, 3):
        for xx in range(11, 18, 3):
            cv.fill(xx, yy, xx + 1, yy + 1, k)
    cv.fill(12, 5, 16, 7, hex2rgb('#7fa04a'))        # 苞叶

def c_bait_rice(cv):
    c = hex2rgb('#f2ecd8')
    cv.ellipse(14, 17, 8, 6, hex2rgb('#d8cfb4'))     # 窝料团
    for x, y, a in [(10, 13, 0), (14, 12, 40), (18, 14, 80), (12, 17, 120), (17, 18, 30)]:
        cv.line(x, y, x + 2 * math.cos(math.radians(a)), y + 2 * math.sin(math.radians(a)), c, thick=1)

def c_bait_secret_base(cv):
    jar, liq = hex2rgb('#8a6fb0'), hex2rgb('#b07aff')
    cv.fill(10, 9, 18, 22, jar)
    cv.fill(10, 14, 18, 21, liq)
    cv.fill(11, 5, 17, 9, hex2rgb('#5a4632'))        # 软木塞
    cv.fill(12, 16, 14, 18, hex2rgb('#e0d4f5'))      # 光泽
    cv.fill(9, 11, 10, 20, shade(jar, .75)); cv.fill(18, 11, 19, 20, shade(jar, .75))

def c_bait_bionic(cv):
    c, fin = hex2rgb('#9fb8c8'), hex2rgb('#6a8a9e')
    cv.ellipse(14, 16, 8, 4, c)
    cv.tri(21, 14, 21, 18, 26, 16, fin)
    cv.tri(13, 12, 16, 12, 14, 9, fin)
    cv.fill(7, 15, 9, 17, (20, 24, 30))
    cv.line(4, 5, 10, 13, hex2rgb('#c8d4dc'), thick=1)  # 鱼线
    cv.fill(12, 14, 17, 15, hex2rgb('#e84a3a'))      # 红腹条

def c_reel(cv, color, accent='#2a2e33', blade=None):
    c, a = hex2rgb(color), hex2rgb(accent)
    cv.ellipse(11, 16, 7, 7, a)                      # 轮体
    cv.ellipse(11, 16, 4.5, 4.5, c)
    cv.ellipse(11, 16, 1.5, 1.5, a)
    cv.line(18, 16, 23, 16, a, thick=2)              # 摇臂
    cv.ellipse(24, 14, 1.5, 3, c)
    if blade:                                        # 涡轮叶片
        b = hex2rgb(blade)
        for ang in range(0, 360, 90):
            x = 11 + math.cos(math.radians(ang)) * 3
            y = 16 + math.sin(math.radians(ang)) * 3
            cv.line(11, 16, x, y, b, thick=1)

def c_acc_net(cv):
    c, mesh = hex2rgb('#c9853f'), hex2rgb('#8a5a28')
    cv.ellipse(14, 16, 9, 8, c)                      # 网袋口
    for x in range(7, 22, 3):                        # 网眼
        cv.line(x, 10, x, 22, mesh)
    for y in range(11, 23, 3):
        cv.line(6, y, 22, y, mesh)
    cv.line(5, 7, 9, 11, c, thick=2)                 # 提手

def c_acc_float(cv, glow=True):
    c = hex2rgb('#e84a3a')
    cv.ellipse(14, 15, 3, 7, c)
    cv.fill(12, 11, 16, 14, hex2rgb('#f2f2f2'))      # 白色梢
    cv.fill(13, 6, 15, 9, hex2rgb('#f2f2f2'))
    cv.fill(12, 21, 16, 23, hex2rgb('#2e6ea8'))      # 水线
    if glow:
        g = hex2rgb('#ffe98a')
        for ang in range(0, 360, 45):
            cv.set(14 + math.cos(math.radians(ang)) * 6, 10 + math.sin(math.radians(ang)) * 6, g)

def c_acc_scoop(cv):
    c, mesh = hex2rgb('#7fa04a'), hex2rgb('#54703a')
    cv.line(4, 5, 16, 17, c, thick=2)                # 杆
    cv.ellipse(19, 20, 7, 5, mesh)                   # 网兜
    cv.ellipse(19, 20, 5, 3.5, hex2rgb('#9fc46a'))
    cv.line(13, 15, 15, 13, c, thick=1)

def c_acc_sonar(cv):
    body, scr = hex2rgb('#3a4e5e'), hex2rgb('#7fd4a8')
    cv.fill(6, 7, 22, 23, body)
    cv.fill(8, 9, 20, 19, scr)
    cv.ellipse(13, 14, 3, 2, hex2rgb('#2a8a5e'))     # 屏幕上的鱼
    cv.fill(16, 13, 19, 14, hex2rgb('#2a8a5e'))
    cv.set(9, 10, hex2rgb('#d8f4e4')); cv.set(10, 11, hex2rgb('#d8f4e4'))
    cv.fill(9, 21, 19, 22, hex2rgb('#22303a'))

def c_acc_radar_base(cv):
    c, wave = hex2rgb('#5a7a9e'), hex2rgb('#7fd4ff')
    cv.ellipse(14, 19, 8, 6, c)                      # 碗状天线
    cv.fill(10, 19, 18, 22, shade(c, .7))
    cv.line(14, 19, 14, 7, shade(c, 1.2), thick=2)
    for r in (4, 7):
        for ang in (-60, -30, 0):
            x = 14 + math.cos(math.radians(ang)) * r
            y = 9 + math.sin(math.radians(ang)) * r
            cv.set(x, y, wave)

def c_charm_coin(cv):
    c, inner = hex2rgb('#e8b93c'), hex2rgb('#c9963e')
    cv.ellipse(14, 15, 8, 8, c)
    cv.ellipse(14, 15, 5.5, 5.5, inner)
    cv.fill(12, 13, 16, 17, c)                       # 方孔钱
    cv.fill(13, 14, 15, 16, hex2rgb('#7a5a1e'))
    cv.set(10, 10, hex2rgb('#fff2c8'))

def c_charm_jade(cv):
    c, dark = hex2rgb('#4ec98a'), hex2rgb('#2e8a5c')
    cv.ellipse(14, 16, 7, 5, c)                      # 玉鱼
    cv.tri(20, 13, 20, 19, 25, 16, c)
    cv.fill(8, 15, 10, 17, dark)
    cv.fill(9, 14, 11, 15, (255, 255, 255))
    cv.line(14, 5, 14, 10, dark); cv.line(14, 5, 11, 3, dark)  # 挂绳
    cv.fill(13, 10, 15, 12, dark)

def c_charm_gold_base(cv):
    c, dark = hex2rgb('#f0c040'), hex2rgb('#b8862e')
    cv.line(14, 3, 14, 9, dark, thick=1)
    cv.ellipse(14, 16, 6, 6, c)                      # 金鳞圆坠
    cv.poly([(14, 11), (19, 16), (14, 21), (9, 16)], dark)
    cv.poly([(14, 13), (17, 16), (14, 19), (11, 16)], c)

def c_charm_trident(cv):
    c = hex2rgb('#e8c34a')
    cv.line(14, 6, 14, 25, c, thick=2)               # 主杆
    cv.line(14, 6, 14, 2, c, thick=2)
    cv.line(14, 8, 9, 4, c, thick=2)                 # 左叉
    cv.line(14, 8, 19, 4, c, thick=2)                # 右叉
    cv.line(9, 4, 9, 2, c, thick=2); cv.line(19, 4, 19, 2, c, thick=2)
    cv.line(12, 12, 16, 12, shade(c, .8), thick=1)
    cv.ellipse(14, 25, 2, 1.5, shade(c, .8))

def c_comp_generic(cv):
    """通用组件：六角螺母 + 齿轮感"""
    c, hole = hex2rgb('#8a949e'), hex2rgb('#3a3f46')
    pts = [(14 + 9 * math.cos(math.radians(a)), 15 + 9 * math.sin(math.radians(a))) for a in range(30, 390, 60)]
    cv.poly(pts, c)
    cv.ellipse(14, 15, 3.5, 3.5, hole)
    for ang in range(0, 360, 45):
        x = 14 + math.cos(math.radians(ang)) * 11
        y = 15 + math.sin(math.radians(ang)) * 11
        cv.set(x, y, shade(c, .7))

def spark(cv, x, y, c):
    """十字闪光"""
    c = hex2rgb(c)
    cv.set(x, y, c); cv.set(x - 1, y, c); cv.set(x + 1, y, c); cv.set(x, y - 1, c); cv.set(x, y + 1, c)

def ring_pts(cv, cx, cy, r, c, step=36):
    c = hex2rgb(c)
    for ang in range(0, 360, step):
        cv.set(cx + math.cos(math.radians(ang)) * r, cy + math.sin(math.radians(ang)) * r, c)

def flame_wisp(cv, x, y, c):
    """上飘的小火焰苗"""
    c = hex2rgb(c)
    cv.set(x, y, c); cv.set(x, y - 1, c); cv.set(x - 1, y - 2, c); cv.set(x + 1, y - 3, c)

# ---------- 高阶物品（带光效） ----------
def m_relic(cv):
    """沉船宝匣残片：破木板 + 铜角 + 发光符文"""
    wood, dark, brass = hex2rgb('#7a5a38'), hex2rgb('#54391f'), hex2rgb('#c9963e')
    rune = hex2rgb('#5ee8d8')
    cv.poly([(5, 8), (23, 6), (24, 20), (6, 22)], wood)
    cv.fill(5, 8, 9, 12, brass)
    cv.line(10, 8, 12, 21, dark); cv.line(17, 7, 19, 20, dark)
    cv.line(13, 12, 16, 15, dark); cv.line(16, 15, 14, 17, dark)
    # 发光符文（刻痕上的青色微光）
    cv.line(20, 9, 22, 12, rune); cv.line(22, 12, 20, 15, rune)
    cv.set(21, 17, rune); cv.set(19, 10, rune)
    spark(cv, 22, 8, '#aef6ec'); spark(cv, 8, 19, '#aef6ec')

def c_rod_dragonbone(cv):
    """龙骨巨竿：骨白竿身 + 龙睛宝石 + 发光骨符"""
    c_rod(cv, '#e0d8c4', grip='#4a3020', segments=5)
    rune = hex2rgb('#ffb04a')
    cv.fill(6, 21, 9, 24, hex2rgb('#e84a3a'))          # 龙睛宝石（握把上）
    cv.set(7, 22, hex2rgb('#ffd8d8'))
    for t in (0.35, 0.55, 0.75):                       # 骨符微光
        x, y = 6 + 16 * t, 24 - 19 * t
        cv.set(x, y, rune)
    ring_pts(cv, 7, 22, 4, '#ff8a5a', step=60)

def c_line_dragon(cv):
    """龙筋线：红金线轴 + 龙鳞纹 + 火气"""
    c_line(cv, '#d8402e', hole='#5a1e14')
    gold = hex2rgb('#f0b53a')
    for ang in range(0, 360, 45):                      # 金鳞点
        cv.set(14 + math.cos(math.radians(ang)) * 6, 15 + math.sin(math.radians(ang)) * 6, gold)
    flame_wisp(cv, 10, 6, '#ff9a4a'); flame_wisp(cv, 18, 5, '#ffce6a')
    spark(cv, 22, 9, '#ffd88a')

def c_hook_ghost(cv):
    """千钩·鬼牙：幽紫鬼火钩"""
    c_hook(cv, '#5a4a8a', glow=True)
    ghost = hex2rgb('#9a7aff')
    for x, y in [(8, 6), (12, 3), (18, 6), (22, 11)]:  # 上浮鬼火
        flame_wisp(cv, x, y, ghost)
    spark(cv, 20, 4, '#c9b0ff')

def c_bait_secret(cv):
    """秘制香饵：紫光药瓶 + 升腾药雾"""
    c_bait_secret_base(cv)
    vapor = hex2rgb('#c9a0ff')
    for x, y in [(11, 4), (15, 3), (18, 5)]:
        flame_wisp(cv, x, y, vapor)
    spark(cv, 9, 3, '#e8d4ff'); spark(cv, 20, 6, '#e8d4ff')

def c_reel_electric(cv):
    """电动卷线器：金色电轮 + 电弧"""
    c_reel(cv, '#e8c33c', accent='#2a2e33')
    bolt = hex2rgb('#ffe98a')
    for x0, y0 in [(20, 5), (5, 8)]:
        cv.line(x0, y0, x0 + 2, y0 + 3, bolt); cv.line(x0 + 2, y0 + 3, x0, y0 + 4, bolt)
        cv.line(x0, y0 + 4, x0 + 2, y0 + 7, bolt)
    ring_pts(cv, 11, 16, 10, '#ffce3a', step=45)

def c_reel_turbo(cv):
    """涡轮卷线器：橙色涡流 + 疾风线"""
    c_reel(cv, '#e8843c', accent='#4a2e1a', blade='#ffe0b0')
    for r, cc in [(10, '#ffb04a'), (12, '#e8843c')]:
        for ang in range(15, 360, 60):
            cv.set(11 + math.cos(math.radians(ang)) * r, 16 + math.sin(math.radians(ang)) * r, hex2rgb(cc))
    for y in (5, 23):                                  # 疾风横线
        cv.line(3, y, 7, y, hex2rgb('#ffd8a8'))

def c_acc_radar(cv):
    """深海声呐雷达：蓝色强波束"""
    c_acc_radar_base(cv)
    wave = hex2rgb('#a8ecff')
    for r in (4, 7, 10):
        for ang in (-70, -45, -20, 5):
            cv.set(14 + math.cos(math.radians(ang)) * r, 9 + math.sin(math.radians(ang)) * r, wave)
    spark(cv, 22, 3, '#d8f6ff')

def c_charm_gold(cv):
    """金鳞坠饰：耀眼金坠 + 星光"""
    c_charm_gold_base(cv)
    ring_pts(cv, 14, 16, 9, '#ffe98a', step=45)
    spark(cv, 22, 9, '#fff2c8'); spark(cv, 6, 10, '#fff2c8'); spark(cv, 14, 3, '#fff2c8')

def c_charm_trident(cv):
    """海王徽记：金色三叉戟 + 海浪底座 + 神性光环"""
    ring_pts(cv, 14, 14, 12, '#7fd4ff', step=30)
    c = hex2rgb('#e8c34a')
    cv.line(14, 6, 14, 25, c, thick=2)
    cv.line(14, 6, 14, 2, c, thick=2)
    cv.line(14, 8, 9, 4, c, thick=2)
    cv.line(14, 8, 19, 4, c, thick=2)
    cv.line(9, 4, 9, 2, c, thick=2); cv.line(19, 4, 19, 2, c, thick=2)
    cv.line(12, 12, 16, 12, shade(c, .8), thick=1)
    cv.ellipse(14, 25, 2, 1.5, shade(c, .8))
    cv.set(14, 4, hex2rgb('#7fd4ff'))                  # 戟尖宝石光
    # 海浪底座
    w1, w2 = hex2rgb('#3a88bc'), hex2rgb('#7fc4ec')
    cv.fill(6, 24, 22, 27, w1)
    for x in range(6, 22, 4):
        cv.fill(x, 24, x + 1, 24, w2)
    spark(cv, 5, 6, '#c8ecff'); spark(cv, 23, 7, '#c8ecff')

COMPONENTS = {
    'comp_generic': c_comp_generic,
    # 竿身
    'rod_bamboo':     lambda cv: c_rod(cv, '#8fae5a', segments=4),
    'rod_fiberglass': lambda cv: c_rod(cv, '#7fb8d8'),
    'rod_carbon':     lambda cv: c_rod(cv, '#3a3f46', ring=True),
    'rod_dragonbone': c_rod_dragonbone,
    # 线组
    'line_nylon':   lambda cv: c_line(cv, '#d8e4ee'),
    'line_stealth': lambda cv: c_line(cv, '#b8c4cc', hole='#2a2e33'),
    'line_titan':   lambda cv: c_line(cv, '#aab4c0', hole='#1e2226'),
    'line_dragon':  c_line_dragon,
    # 钩
    'hook_barb':    lambda cv: c_hook(cv, '#8a949e'),
    'hook_swallow': lambda cv: c_hook(cv, '#c94040', barb=False),
    'hook_steel':   lambda cv: c_hook(cv, '#5a6470'),
    'hook_ghost':   c_hook_ghost,
    # 饵
    'bait_corn':   c_bait_corn,
    'bait_rice':   c_bait_rice,
    'bait_secret': c_bait_secret,
    'bait_bionic': c_bait_bionic,
    # 卷线器
    'reel_smooth':   lambda cv: c_reel(cv, '#c9853f'),
    'reel_magnetic': lambda cv: c_reel(cv, '#4a7ac9', accent='#22304a'),
    'reel_electric': c_reel_electric,
    'reel_turbo':    c_reel_turbo,
    # 配件
    'acc_net':    c_acc_net,
    'acc_float':  c_acc_float,
    'acc_scoop':  c_acc_scoop,
    'acc_sonar':  c_acc_sonar,
    'acc_radar':  c_acc_radar,
    # 饰品
    'charm_coin':     c_charm_coin,
    'charm_jade':     c_charm_jade,
    'charm_gold':     c_charm_gold,
    'charm_trident':  c_charm_trident,
}

MATERIALS = {'bait_pack': m_bait_pack, 'rope': m_rope, 'lure': m_lure, 'relic': m_relic}

# ---------- 宝匣（沉船打捞四档，逐级华丽） ----------
def chest_base(cv, wood, band, glow=None):
    wood, band = hex2rgb(wood), hex2rgb(band)
    cv.fill(5, 10, 23, 23, wood)                    # 箱体
    cv.fill(5, 10, 23, 15, shade(wood, .8))         # 箱盖
    cv.line(5, 15, 23, 15, shade(wood, .6))
    cv.fill(5, 10, 7, 23, band)                     # 包边
    cv.fill(21, 10, 23, 23, band)
    cv.fill(13, 13, 15, 17, band)                   # 锁扣
    cv.fill(13, 16, 15, 19, shade(band, .8))
    cv.set(14, 15, hex2rgb('#2a2018'))              # 锁孔
    if glow:
        g = hex2rgb(glow)
        for ang in range(0, 360, 45):
            cv.set(14 + math.cos(math.radians(ang)) * 11, 16 + math.sin(math.radians(ang)) * 10, g)

def ch_wreck(cv):
    """Ⅰ 沉船宝匣：风化木箱 + 藤壶"""
    chest_base(cv, '#6a5638', '#4a3c26')
    barn = hex2rgb('#b8c4b0')
    cv.set(7, 21, barn); cv.set(8, 20, barn); cv.set(22, 19, barn); cv.set(21, 22, barn)
    cv.line(10, 12, 12, 21, hex2rgb('#4a3c26'))     # 裂纹

def ch_deep(cv):
    """Ⅱ 深潜宝匣：铁箍深木箱 + 舷窗"""
    chest_base(cv, '#4a3f36', '#8a949e')
    cv.ellipse(14, 20, 3, 3, hex2rgb('#3ec9f0'))    # 舷窗
    cv.ellipse(14, 20, 1.5, 1.5, hex2rgb('#bfe8f8'))
    spark(cv, 22, 8, '#aef6ec')

def ch_abyss(cv):
    """Ⅲ 深渊宝匣：紫晶黑箱 + 幽光"""
    chest_base(cv, '#2e2438', '#6a5a8a', glow='#9a7aff')
    cv.set(14, 14, hex2rgb('#c9b0ff'))
    for x, y in [(8, 9), (20, 8), (23, 22), (6, 24)]:
        flame_wisp(cv, x, y, hex2rgb('#9a7aff'))

def ch_king(cv):
    """Ⅳ 海王遗匣：黄金圣箱 + 三叉戟纹章"""
    chest_base(cv, '#c9963e', '#ffd23e', glow='#ffe98a')
    tri = hex2rgb('#7a5a1e')
    cv.line(14, 18, 14, 22, tri, thick=1)           # 三叉戟纹
    cv.line(14, 18, 12, 19, tri); cv.line(14, 18, 16, 19, tri)
    spark(cv, 5, 8, '#fff2c8'); spark(cv, 23, 6, '#fff2c8'); spark(cv, 14, 4, '#fff2c8')

CHEST_ICONS = {'chest_wreck': ch_wreck, 'chest_deep': ch_deep, 'chest_abyss': ch_abyss, 'chest_king': ch_king}

# ---------- 钓点 ----------
def s_dock(cv):
    """老旧码头：木栈桥 + 水面"""
    water(cv)
    wood, dark = hex2rgb('#8a6a42'), hex2rgb('#5f4626')
    for x in range(3, 26, 5):                        # 桥桩
        cv.fill(x, 8, x + 1, 17, dark)
    cv.fill(2, 5, 25, 8, wood)                       # 桥面
    for x in range(3, 25, 4):
        cv.fill(x, 5, x, 8, dark)
    cv.fill(20, 2, 24, 5, dark)                      # 系缆桩
    cv.line(22, 2, 22, 0, hex2rgb('#c9a86a'), thick=1)

def s_reed(cv):
    """芦苇浅滩"""
    water(cv, y0=19)
    g1, g2, head = hex2rgb('#5f8a3c'), hex2rgb('#3f6628'), hex2rgb('#a8845a')
    for x, h in [(6, 14), (10, 17), (14, 13), (19, 16), (23, 12)]:
        cv.line(x, 19, x, 19 - h, g1, thick=1)
        cv.line(x + 1, 19, x + 2, 19 - h + 3, g2, thick=1)
        cv.fill(x - 1, 19 - h - 2, x + 1, 19 - h, head)   # 芦花
    cv.fill(4, 21, 24, 22, hex2rgb('#4a7a9e'))

def s_deep(cv):
    """深水区：暗色水面 + 浮漂"""
    water(cv, y0=13, c='#1e4a78', lite='#3a78a8')
    cv.ellipse(14, 20, 2, 4, hex2rgb('#e84a3a'))
    cv.fill(13, 17, 15, 19, hex2rgb('#f2f2f2'))
    cv.line(14, 24, 14, 27, hex2rgb('#c8d4dc'), thick=1)

def s_shoal(cv):
    """石滩：乱石 + 浅水花"""
    water(cv, y0=18)
    st1, st2 = hex2rgb('#8a949e'), hex2rgb('#6a7480')
    cv.ellipse(8, 16, 5, 4, st1)
    cv.ellipse(17, 14, 6, 5, st2)
    cv.ellipse(23, 18, 4, 3, st1)
    cv.fill(6, 13, 9, 14, hex2rgb('#b8c2cc'))
    cv.fill(15, 10, 18, 11, hex2rgb('#9aa4ae'))
    for x in range(2, 27, 5):
        cv.fill(x, 22, x + 1, 22, hex2rgb('#d8ecf8'))

def s_eddy(cv):
    """回水湾：漩涡"""
    water(cv, y0=15)
    c1, c2 = hex2rgb('#7fc4ec'), hex2rgb('#3a88bc')
    for r, cc in [(9, c1), (6, c2), (3.5, c1)]:
        for ang in range(-40, 320, 20):
            cv.set(14 + math.cos(math.radians(ang)) * r, 15 + math.sin(math.radians(ang)) * r * .7, cc)

def s_fall(cv):
    """瀑布潭：瀑布 + 深潭"""
    cv.fill(6, 1, 22, 8, hex2rgb('#6a7480'))         # 崖壁
    cv.fill(9, 8, 19, 21, hex2rgb('#bfe4f8'))        # 水帘
    for x in (11, 14, 17):
        cv.fill(x, 8, x, 21, hex2rgb('#e8f6ff'))
    water(cv, y0=20, c='#2a5a88', lite='#5aa4d8')
    for x in range(9, 20, 3):
        cv.fill(x, 19, x + 1, 19, hex2rgb('#ffffff'))

def s_beach(cv):
    """沙滩：沙丘 + 海 + 贝壳"""
    water(cv, y0=17, c='#3a88bc', lite='#7fc4ec')
    sand, sdark = hex2rgb('#e8cf8f'), hex2rgb('#c9a86a')
    cv.poly([(0, 28), (0, 12), (12, 12), (6, 28)], sand)
    cv.fill(2, 13, 8, 14, sdark)
    shell = hex2rgb('#f2d8d8')
    cv.ellipse(19, 23, 2.5, 2, shell)
    cv.fill(18, 22, 20, 22, hex2rgb('#d8a8a8'))
    cv.fill(23, 20, 25, 21, hex2rgb('#e8b9c9'))      # 海星?

def s_pier(cv):
    """防波堤：巨石堤 + 浪花"""
    water(cv)
    r1, r2 = hex2rgb('#7a8490'), hex2rgb('#5a6470')
    cv.ellipse(8, 14, 6, 5, r1)
    cv.ellipse(17, 11, 7, 6, r2)
    cv.ellipse(24, 15, 5, 5, r1)
    cv.fill(4, 5, 20, 8, hex2rgb('#9aa4ae'))         # 堤顶
    for x in range(3, 27, 4):
        cv.fill(x, 21, x + 1, 21, hex2rgb('#d8ecf8'))

def s_reef(cv):
    """礁石区：礁石 + 珊瑚"""
    water(cv, y0=16)
    rock, coral = hex2rgb('#4a5460'), hex2rgb('#e87a6a')
    cv.ellipse(9, 15, 6, 6, rock)
    cv.ellipse(20, 17, 7, 7, shade(rock, .8))
    cv.fill(18, 8, 20, 14, coral)                    # 珊瑚枝
    cv.fill(21, 10, 23, 15, shade(coral, 1.15))
    cv.fill(16, 11, 18, 15, shade(coral, .85))
    cv.fill(5, 9, 11, 10, hex2rgb('#6a7480'))

SPOTS = {'dock': s_dock, 'reed': s_reed, 'deep': s_deep, 'shoal': s_shoal,
         'eddy': s_eddy, 'fall': s_fall, 'beach': s_beach, 'pier': s_pier, 'reef': s_reef}

if __name__ == '__main__':
    os.makedirs(ITEM_DIR, exist_ok=True)
    os.makedirs(SPOT_DIR, exist_ok=True)
    for fid, fn in MATERIALS.items():
        cv = new(); fn(cv); print('item', fid, cv.render(os.path.join(ITEM_DIR, fid + '.png')))
    for fid, fn in COMPONENTS.items():
        cv = new(); fn(cv); print('item', fid, cv.render(os.path.join(ITEM_DIR, fid + '.png')))
    for fid, fn in CHEST_ICONS.items():
        cv = new(); fn(cv); print('item', fid, cv.render(os.path.join(ITEM_DIR, fid + '.png')))
    for fid, fn in SPOTS.items():
        cv = new(); fn(cv); print('spot', fid, cv.render(os.path.join(SPOT_DIR, fid + '.png')))
