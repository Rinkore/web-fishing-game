# -*- coding: utf-8 -*-
"""钓场图标 ×4（28x28 逻辑像素 x5）：stillwater 静水湖 / rapids 急流河 / sunset 落日海湾 / frostmoon 霜月冰湖。"""
import os, math
from PIL import Image
from gen_fish import Canvas, hex2rgb, shade

OUT = r"C:\Users\qxl\web-fishing-game\frontend\assets\ground"
os.makedirs(OUT, exist_ok=True)
CELL = 5
W = H = 28

def water(cv, y0=18, c='#2a6ea0', lite='#5aa4d8'):
    c, lite = hex2rgb(c), hex2rgb(lite)
    cv.fill(0, y0, W - 1, H - 1, c)
    for x in range(0, W, 4):
        cv.fill(x, y0, min(x + 1, W - 1), y0, lite)
    for x in range(2, W, 6):
        cv.fill(x, y0 + 4, min(x + 1, W - 1), y0 + 4, shade(c, 1.25))

def g_stillwater(cv):
    """静水湖：湖面 + 小栈桥 + 睡莲"""
    cv.ellipse(14, 15, 12, 10, hex2rgb('#2a6ea0'))
    cv.ellipse(14, 16, 8, 6, hex2rgb('#1f5784'))
    cv.fill(6, 8, 12, 10, hex2rgb('#8a6a42'))       # 栈桥
    cv.fill(6, 8, 6, 12, hex2rgb('#5f4626'))
    cv.fill(18, 12, 20, 13, hex2rgb('#4a9a58'))     # 睡莲
    cv.set(19, 11, hex2rgb('#f0c8dc'))
    cv.fill(23, 18, 25, 19, hex2rgb('#4a9a58'))
    for ang in range(0, 360, 20):                   # 岸线
        cv.set(14 + 13.5 * math.cos(math.radians(ang)), 15 + 11.5 * math.sin(math.radians(ang)), hex2rgb('#2f6a3c'))

def g_rapids(cv):
    """急流河：S 弯河流 + 瀑布 + 白花"""
    c = hex2rgb('#2a6ea0')
    for y in range(2, 27):
        xc = 14 + 6 * math.sin(y / 5)
        cv.fill(int(xc - 3), y, int(xc + 3), y, c)
    cv.fill(9, 8, 19, 9, hex2rgb('#6a7480'))        # 瀑布岩阶
    for x in range(11, 18):                          # 白练
        for y in range(10, 14):
            cv.set(x, y, hex2rgb('#cfe8f8') if (x + y) % 2 else hex2rgb('#e8f6ff'))
    for x, y in [(11, 17), (16, 20), (12, 23)]:
        cv.fill(x, y, x + 2, y, hex2rgb('#cfe8f8'))  # 白花
    cv.ellipse(22, 6, 3, 2.5, hex2rgb('#8a949e'))    # 石滩石
    cv.ellipse(6, 22, 3, 2.5, hex2rgb('#8a949e'))

def g_sunset(cv):
    """落日海湾：沙滩 + 灯塔 + 海"""
    water(cv, y0=16)
    cv.poly([(0, 28), (0, 10), (12, 10), (6, 28)], hex2rgb('#e0c88f'))  # 沙滩
    # 灯塔
    cv.fill(17, 4, 20, 14, hex2rgb('#f2f2f2'))
    cv.fill(17, 7, 20, 9, hex2rgb('#e84a3a'))
    cv.fill(17, 11, 20, 13, hex2rgb('#e84a3a'))
    cv.fill(17, 2, 20, 4, hex2rgb('#2a2e33'))
    cv.set(18, 3, hex2rgb('#ffd23e'))
    for x in range(4, 14, 3):                        # 浪花
        cv.set(x, 17, hex2rgb('#d8ecf8'))

def g_frostmoon(cv):
    """霜月冰湖：冰面 + 裂纹 + 雪花"""
    cv.ellipse(14, 15, 12, 9, hex2rgb('#bfe4f8'))
    cv.ellipse(14, 13, 8, 5, hex2rgb('#e4f4fc'))
    cv.line(8, 12, 14, 17, hex2rgb('#9ecbe0'))
    cv.line(14, 17, 20, 13, hex2rgb('#9ecbe0'))
    for x, y in [(5, 5), (22, 4), (25, 10), (3, 22), (24, 24)]:
        cv.set(x, y, hex2rgb('#ffffff'))
        cv.set(x - 1, y, hex2rgb('#ffffff')); cv.set(x + 1, y, hex2rgb('#ffffff'))
        cv.set(x, y - 1, hex2rgb('#ffffff')); cv.set(x, y + 1, hex2rgb('#ffffff'))

ICONS = {'stillwater': g_stillwater, 'rapids': g_rapids, 'sunset': g_sunset, 'frostmoon': g_frostmoon}

if __name__ == '__main__':
    for name, fn in ICONS.items():
        cv = Canvas(W, H)
        fn(cv)
        # 覆盖默认 CELL：Canvas.render 用 gen_fish.CELL=5，正好
        print(name, cv.render(os.path.join(OUT, name + '.png')))
