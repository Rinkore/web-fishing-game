# -*- coding: utf-8 -*-
"""导航栏像素图标 13 个（16x16 x3 = 48px，透明底）。"""
import os, math
from PIL import Image
from gen_fish import Canvas, hex2rgb, shade

ROOT = r"C:\Users\qxl\web-fishing-game\frontend\assets\nav"
os.makedirs(ROOT, exist_ok=True)
CELL, W, H = 3, 16, 16

def new():
    return Canvas(W, H)

def finish(cv, name):
    cv.render(os.path.join(ROOT, name + '.png'))

def i_fishing(cv):
    """鱼竿 + 鱼"""
    cv.line(3, 13, 12, 3, hex2rgb('#8a6a42'), thick=1)
    cv.line(12, 3, 12, 7, hex2rgb('#c8d4dc'))
    cv.ellipse(9, 10, 3.5, 2, hex2rgb('#3ec9f0'))
    cv.tri(12, 9, 12, 11, 14, 10, hex2rgb('#3ec9f0'))
    cv.fill(7, 9, 8, 10, (20, 24, 30))

def i_bd(cv):
    """钓竿配置：扳手"""
    cv.line(3, 13, 11, 5, hex2rgb('#9aa4ae'), thick=2)
    cv.ellipse(12, 4, 2.5, 2.5, hex2rgb('#9aa4ae'))
    cv.ellipse(12, 4, 1, 1, None)
    cv.set(12, 4, None)

def i_ground(cv):
    """渔场动态：波浪"""
    for x in range(2, 14):
        y = 6 + (x % 4 // 2)
        cv.set(x, y, hex2rgb('#3ec9f0'))
    for x in range(2, 14):
        y = 10 + ((x + 2) % 4 // 2)
        cv.set(x, y, hex2rgb('#2a6ea0'))
    cv.set(3, 7, hex2rgb('#7fc4ec')); cv.set(9, 9, hex2rgb('#7fc4ec'))

def i_inventory(cv):
    """背包"""
    cv.fill(4, 6, 12, 13, hex2rgb('#b08a4f'))
    cv.fill(4, 6, 12, 8, hex2rgb('#7d5e33'))
    cv.fill(6, 3, 10, 6, hex2rgb('#b08a4f'))
    cv.set(8, 5, hex2rgb('#5f4626'))
    cv.fill(7, 9, 9, 11, hex2rgb('#8a6a42'))

def i_chest(cv):
    """宝匣"""
    cv.fill(3, 6, 13, 13, hex2rgb('#8a6a42'))
    cv.fill(3, 6, 13, 8, hex2rgb('#5f4626'))
    cv.fill(7, 5, 9, 13, hex2rgb('#ffd23e'))
    cv.set(8, 9, hex2rgb('#7a5a1e'))

def i_shop(cv):
    """商店小屋"""
    cv.fill(3, 7, 13, 13, hex2rgb('#8a949e'))
    cv.poly([(2, 7), (8, 2), (14, 7)], hex2rgb('#e84a3a'))
    cv.fill(6, 9, 8, 13, hex2rgb('#5a6470'))
    cv.fill(10, 9, 12, 11, hex2rgb('#7fc4ec'))

def i_market(cv):
    """天平/金币"""
    cv.line(8, 2, 8, 11, hex2rgb('#c9963e'), thick=1)
    cv.line(4, 4, 12, 4, hex2rgb('#c9963e'))
    cv.line(4, 4, 3, 7, hex2rgb('#c9963e')); cv.line(4, 4, 5, 7, hex2rgb('#c9963e'))
    cv.line(12, 4, 11, 7, hex2rgb('#c9963e')); cv.line(12, 4, 13, 7, hex2rgb('#c9963e'))
    cv.fill(2, 7, 6, 8, hex2rgb('#ffd23e'))
    cv.fill(10, 7, 14, 8, hex2rgb('#ffd23e'))
    cv.line(5, 13, 11, 13, hex2rgb('#c9963e'))

def i_trade(cv):
    """握手：双向箭头"""
    cv.line(3, 8, 8, 8, hex2rgb('#34e0c0'), thick=2)
    cv.tri(3, 8, 6, 5, 6, 11, hex2rgb('#34e0c0'))
    cv.line(13, 8, 8, 8, hex2rgb('#ffd23e'), thick=2)
    cv.tri(13, 8, 10, 5, 10, 11, hex2rgb('#ffd23e'))

def i_mall(cv):
    """购物车 + 锁"""
    cv.fill(3, 5, 11, 10, hex2rgb('#8a949e'))
    cv.set(5, 12, hex2rgb('#5a6470')); cv.set(9, 12, hex2rgb('#5a6470'))
    cv.line(3, 5, 2, 3, hex2rgb('#8a949e'))
    cv.fill(11, 7, 14, 11, hex2rgb('#c9963e'))
    cv.line(12, 7, 12, 5, hex2rgb('#c9963e')); cv.line(13, 7, 13, 5, hex2rgb('#c9963e'))

def i_codex(cv):
    """书本"""
    cv.fill(3, 3, 13, 13, hex2rgb('#7a5a8a'))
    cv.fill(4, 4, 12, 12, hex2rgb('#e8e4da'))
    cv.line(8, 4, 8, 12, hex2rgb('#8a949e'))
    cv.line(5, 6, 7, 6, hex2rgb('#5a6470')); cv.line(5, 8, 7, 8, hex2rgb('#5a6470'))
    cv.line(9, 6, 11, 6, hex2rgb('#5a6470')); cv.line(9, 8, 11, 8, hex2rgb('#5a6470'))

def i_records(cv):
    """奖杯"""
    cv.fill(5, 3, 11, 8, hex2rgb('#ffd23e'))
    cv.set(4, 4, hex2rgb('#ffd23e')); cv.set(12, 4, hex2rgb('#ffd23e'))
    cv.fill(7, 8, 9, 11, hex2rgb('#c9963e'))
    cv.fill(5, 12, 11, 13, hex2rgb('#c9963e'))
    cv.set(7, 5, (255, 240, 180))

def i_feedback(cv):
    """信箱"""
    cv.fill(3, 4, 13, 12, hex2rgb('#c9853f'))
    cv.fill(3, 4, 13, 7, hex2rgb('#8a5a28'))
    cv.fill(5, 6, 11, 10, hex2rgb('#f2ecd8'))
    cv.line(5, 6, 8, 9, hex2rgb('#8a5a28')); cv.line(11, 6, 8, 9, hex2rgb('#8a5a28'))
    cv.line(13, 5, 15, 3, hex2rgb('#e84a3a'))

def i_logs(cv):
    """卷轴"""
    cv.fill(4, 3, 12, 13, hex2rgb('#e8d8b0'))
    cv.fill(4, 3, 12, 4, hex2rgb('#c9a86a'))
    cv.fill(4, 12, 12, 13, hex2rgb('#c9a86a'))
    cv.line(6, 6, 10, 6, hex2rgb('#7d5e33')); cv.line(6, 8, 10, 8, hex2rgb('#7d5e33')); cv.line(6, 10, 8, 10, hex2rgb('#7d5e33'))

ICONS = {
    'fishing': i_fishing, 'bd': i_bd, 'ground': i_ground, 'inventory': i_inventory,
    'chest': i_chest, 'shop': i_shop, 'market': i_market, 'trade': i_trade,
    'mall': i_mall, 'codex': i_codex, 'records': i_records, 'feedback': i_feedback,
    'logs': i_logs,
}

if __name__ == '__main__':
    for name, fn in ICONS.items():
        cv = new()
        fn(cv)
        finish(cv, name)
        print('nav', name)
