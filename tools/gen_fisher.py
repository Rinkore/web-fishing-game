# -*- coding: utf-8 -*-
"""像素侠客渔夫 v2：坐姿 + 精细版（参考 Downloads 侠客垂钓图，抽象化绘制）。
三帧甩杆：fisher_a.png 后摆 / fisher_b.png 前挥 / fisher_hold.png 入水持竿（常驻）。
36x30 逻辑像素 x4，透明底，角色面朝右盘坐。"""
import os, math
from gen_fish import Canvas, hex2rgb, shade

OUT = r"C:\Users\qxl\web-fishing-game\frontend\assets\ui"
W, H = 36, 30

HAT = hex2rgb('#c9a86a'); HAT_D = hex2rgb('#a8845a'); HAT_L = hex2rgb('#dcc48f')
SKIN = hex2rgb('#d8a878'); SKIN_D = hex2rgb('#b08a5f')
ROBE = hex2rgb('#f2f2f2'); ROBE_D = hex2rgb('#b8c4d8'); ROBE_L = hex2rgb('#ffffff')
RIB = hex2rgb('#2a3a5c'); RIB_L = hex2rgb('#3a4a74')
GOLD = hex2rgb('#c9963e')
DARK = hex2rgb('#2a2e3a')
ROD = hex2rgb('#5f4626'); LINE = hex2rgb('#c8d4dc')
GOURD = hex2rgb('#a8763e'); GOURD_D = hex2rgb('#7d5a2e')

def body(cv):
    """坐姿侠客本体（三帧共用）"""
    # 背剑（先画，压在身体下）：鞘 + 金镡 + 柄
    cv.line(9, 3, 15, 17, DARK, thick=2)
    cv.set(11, 11, GOLD); cv.set(12, 10, GOLD)          # 剑镡
    cv.set(8, 3, DARK); cv.set(9, 2, DARK); cv.set(10, 3, DARK)  # 柄首
    # 飘带三条（左后飞扬，亮暗相间带尖角）
    cv.poly([(12, 11), (1, 4), (2, 8), (11, 14)], RIB)
    cv.set(1, 4, RIB_L); cv.set(2, 5, RIB_L)
    cv.poly([(11, 14), (0, 11), (1, 15), (11, 17)], RIB_L)
    cv.set(0, 11, RIB)
    cv.poly([(11, 17), (3, 20), (4, 17), (12, 15)], RIB)
    # 袍摆（盘坐铺开：左宽右收，露出右靴尖）
    cv.poly([(10, 18), (19, 18), (23, 21), (25, 26), (7, 26), (8, 21)], ROBE)
    for x in (11, 13, 16, 19):                       # 摆褶
        cv.line(x, 20, x + 1, 25, ROBE_D)
    cv.line(23, 21, 25, 26, ROBE_D)                  # 右缘
    cv.line(8, 21, 7, 26, ROBE_D)                    # 左缘
    cv.line(12, 19, 14, 25, ROBE_L)                  # 高光褶
    # 右靴尖（袍下探出）
    cv.fill(22, 24, 24, 26, DARK)
    cv.set(25, 25, DARK)
    # 上身（微前倾）+ V 领
    cv.poly([(11, 12), (18, 12), (19, 19), (10, 19)], ROBE)
    cv.line(13, 12, 15, 16, ROBE_D)
    cv.line(16, 12, 15, 16, ROBE_D)
    cv.line(19, 14, 19, 19, ROBE_D)                  # 右侧褶影
    # 腰绦 + 结
    cv.line(10, 18, 18, 18, GOLD, thick=1)
    cv.set(17, 19, GOLD); cv.set(17, 20, GOLD)
    # 腰挂葫芦（左侧）
    cv.ellipse(6, 21, 2.2, 2.6, GOURD)
    cv.ellipse(6, 18, 1.3, 1.5, GOURD_D)
    cv.line(6, 16, 6, 17, hex2rgb('#5f4626'))
    cv.set(5, 20, shade(GOURD, 1.25))
    # 头（斗笠下阴影，脸微侧向右）
    cv.fill(12, 9, 16, 12, SKIN_D)
    cv.set(17, 10, SKIN_D); cv.set(17, 11, SKIN_D)   # 下巴探出
    cv.set(15, 10, DARK)                             # 眯眼
    # 斗笠（宽锥 + 编织纹 + 高光）
    cv.poly([(4, 9), (24, 9), (15, 3), (11, 3)], HAT)
    for x0, x1 in [(7, 11), (11, 13), (16, 15), (20, 17)]:
        cv.line(x0, 8, x1, 4, HAT_D)
    cv.line(4, 9, 24, 9, HAT_D)
    cv.line(12, 3, 15, 3, HAT_L)
    cv.line(6, 8, 10, 6, HAT_L)                      # 受光面
    # 持竿手臂（白袖 → 手）
    cv.line(18, 14, 22, 16, ROBE, thick=2)
    cv.line(19, 15, 22, 17, ROBE_D, thick=1)
    cv.fill(21, 15, 23, 17, SKIN)
    # 渔轮（手柄处小轮 + 金轴）
    cv.set(23, 17, DARK); cv.set(24, 16, DARK); cv.set(24, 17, GOLD)

def frame_a(cv):
    """后摆蓄力"""
    cv.line(22, 15, 30, 2, ROD, thick=1)
    cv.line(22, 15, 28, 4, shade(ROD, 1.3))
    cv.set(24, 12, hex2rgb('#c94040')); cv.set(25, 11, hex2rgb('#c94040'))  # 红握把

def frame_b(cv):
    """前挥"""
    cv.line(22, 15, 33, 6, ROD, thick=1)
    cv.line(22, 15, 30, 8, shade(ROD, 1.3))
    cv.set(24, 13, hex2rgb('#c94040')); cv.set(25, 12, hex2rgb('#c94040'))

def frame_hold(cv):
    """入水持竿：竿前伸 + 渔线垂下 + 浮漂"""
    cv.line(22, 15, 34, 10, ROD, thick=1)
    cv.line(22, 15, 31, 11, shade(ROD, 1.3))
    cv.set(24, 14, hex2rgb('#c94040')); cv.set(25, 13, hex2rgb('#c94040'))
    cv.line(34, 10, 34, 25, LINE)
    cv.set(33, 24, hex2rgb('#f2f2f2'))
    cv.set(33, 25, hex2rgb('#e84a3a')); cv.set(34, 26, hex2rgb('#e84a3a'))
    cv.set(34, 24, hex2rgb('#f2f2f2'))

FRAMES = {'fisher_a': frame_a, 'fisher_b': frame_b, 'fisher_hold': frame_hold}

if __name__ == '__main__':
    for name, fn in FRAMES.items():
        cv = Canvas(W, H)
        body(cv)
        fn(cv)
        print(name, cv.render(os.path.join(OUT, name + '.png')))
    from PIL import Image
    sheet = Image.new('RGB', (3 * 160, 135), (24, 32, 48))
    for i, name in enumerate(FRAMES):
        im = Image.open(os.path.join(OUT, name + '.png')).convert('RGBA')
        sheet.paste(im, (i * 160 + 5, 5), im)
    sheet.save(r'C:\Users\qxl\web-fishing-game\tools\fisher_frames.png')
    print('preview saved')
