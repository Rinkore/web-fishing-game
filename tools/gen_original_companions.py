#!/usr/bin/env python3
"""Generate original chibi pixel companions — one distinct silhouette per breed.

Every breed gets its own proportions (body length/height, leg length, muzzle,
ear and tail shapes) so breeds are recognisable at a glance; coat variants of
the same breed only swap palettes (Cast n Chill style). Drawn at 64x48 logical
resolution, outlined, then enlarged 4x with nearest-neighbour sampling.
Deterministic, transparent background, no external assets.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "frontend" / "assets" / "ui" / "char"
OUTLINE = (16, 24, 39, 255)
EYE = (12, 17, 24, 255)
NOSE = (20, 16, 22, 255)
HIGHLIGHT = (244, 231, 199, 255)

# 每只同伴的独立体型配方：
#   body  = 躯干盒 (x0,y0,x1,y1)        head = 头盒（不含吻部）
#   muzzle= 吻部长度 / 高度             legs = (腿长, 腿粗)
#   ears  = point / flop / long / cat / button
#   tail  = plume / curl / nub / thin / up / bushy
#   mark  = 品种斑纹函数名
CONFIGS = {
    # 金毛寻回犬：中等匀称、垂耳、羽毛尾、浅色口吻与胸毛
    "golden": dict(base=(205, 145, 72, 255), light=(244, 197, 111, 255), dark=(124, 78, 47, 255),
                   body=(12, 22, 38, 36), head=(36, 12, 50, 27), muzzle=(6, 5), legs=(7, 4),
                   ears="flop", tail="plume", mark="golden"),
    "retriever_red": dict(base=(170, 86, 44, 255), light=(216, 142, 82, 255), dark=(98, 50, 30, 255),
                   body=(12, 22, 38, 36), head=(36, 12, 50, 27), muzzle=(6, 5), legs=(7, 4),
                   ears="flop", tail="plume", mark="golden"),
    "retriever_cream": dict(base=(226, 198, 152, 255), light=(246, 232, 202, 255), dark=(162, 122, 82, 255),
                   body=(12, 22, 38, 36), head=(36, 12, 50, 27), muzzle=(6, 5), legs=(7, 4),
                   ears="flop", tail="plume", mark="golden"),
    "retriever_brown": dict(base=(122, 72, 44, 255), light=(172, 112, 72, 255), dark=(70, 42, 28, 255),
                   body=(12, 22, 38, 36), head=(36, 12, 50, 27), muzzle=(6, 5), legs=(7, 4),
                   ears="flop", tail="plume", mark="golden"),
    "retriever_black": dict(base=(54, 52, 56, 255), light=(112, 107, 112, 255), dark=(24, 22, 28, 255),
                   body=(12, 22, 38, 36), head=(36, 12, 50, 27), muzzle=(6, 5), legs=(7, 4),
                   ears="flop", tail="plume", mark="golden"),
    # 柯基：短腿、大立耳、无尾、白胸白腿
    "corgi": dict(base=(190, 103, 52, 255), light=(245, 217, 171, 255), dark=(107, 58, 39, 255),
                  body=(12, 26, 38, 38), head=(36, 15, 50, 30), muzzle=(5, 4), legs=(4, 4),
                  ears="point", tail="nub", mark="corgi"),
    # 阿拉斯加：狼相、立耳、卷尾上背、脸部白面具
    "malamute": dict(base=(93, 106, 123, 255), light=(222, 226, 220, 255), dark=(45, 55, 72, 255),
                     body=(12, 21, 39, 36), head=(37, 11, 51, 26), muzzle=(5, 4), legs=(7, 4),
                     ears="point", tail="curl", mark="malamute"),
    "malamute_red": dict(base=(152, 74, 48, 255), light=(226, 222, 212, 255), dark=(72, 42, 34, 255),
                     body=(12, 21, 39, 36), head=(37, 11, 51, 26), muzzle=(5, 4), legs=(7, 4),
                     ears="point", tail="curl", mark="malamute"),
    "malamute_white": dict(base=(228, 230, 228, 255), light=(248, 250, 248, 255), dark=(152, 160, 166, 255),
                     body=(12, 21, 39, 36), head=(37, 11, 51, 26), muzzle=(5, 4), legs=(7, 4),
                     ears="point", tail="curl", mark="malamute"),
    # 巴吉度：贴地长身、耳朵垂到嘴、短腿、忧郁下垂眼
    "basset": dict(base=(168, 102, 58, 255), light=(230, 207, 169, 255), dark=(91, 55, 42, 255),
                   body=(10, 26, 40, 38), head=(38, 15, 51, 30), muzzle=(6, 5), legs=(4, 4),
                   ears="long", tail="thin", mark="basset"),
    "basset_lemon": dict(base=(218, 180, 112, 255), light=(242, 224, 182, 255), dark=(142, 102, 62, 255),
                   body=(10, 26, 40, 38), head=(38, 15, 51, 30), muzzle=(6, 5), legs=(4, 4),
                   ears="long", tail="thin", mark="basset"),
    # 德牧：黑背鞍纹、立耳、下垂蓬尾、吻部黑
    "shepherd": dict(base=(151, 104, 57, 255), light=(211, 167, 100, 255), dark=(54, 52, 48, 255),
                     body=(12, 21, 39, 36), head=(37, 11, 51, 26), muzzle=(6, 4), legs=(7, 4),
                     ears="point", tail="bushy", mark="shepherd"),
    # 腊肠：超长身、超短腿、长吻、垂耳
    "dachshund": dict(base=(150, 76, 47, 255), light=(205, 126, 76, 255), dark=(77, 43, 38, 255),
                      body=(8, 27, 42, 37), head=(40, 16, 52, 29), muzzle=(7, 4), legs=(4, 3),
                      ears="flop", tail="thin", mark="dachshund"),
    "dachshund_cream": dict(base=(222, 182, 122, 255), light=(246, 218, 172, 255), dark=(142, 102, 66, 255),
                      body=(8, 27, 42, 37), head=(40, 16, 52, 29), muzzle=(7, 4), legs=(4, 3),
                      ears="flop", tail="thin", mark="dachshund"),
    "dachshund_tri": dict(base=(62, 60, 64, 255), light=(202, 152, 102, 255), dark=(28, 26, 32, 255),
                      body=(8, 27, 42, 37), head=(40, 16, 52, 29), muzzle=(7, 4), legs=(4, 3),
                      ears="flop", tail="thin", mark="dachshund_tri"),
    # 伯恩山：大体格、三色（黑/棕/白）、白面纹、蓬松羽尾
    "bernese": dict(base=(54, 57, 61, 255), light=(236, 225, 199, 255), dark=(27, 31, 40, 255), accent=(180, 91, 50, 255),
                    body=(11, 20, 40, 37), head=(37, 10, 52, 27), muzzle=(6, 5), legs=(8, 5),
                    ears="flop", tail="plume", mark="bernese"),
    # 缅因猫：猫！瘦身、大三角耳带耳簇、长胡须、尾巴高高卷起、条纹
    "mainecoon": dict(base=(156, 91, 54, 255), light=(224, 159, 93, 255), dark=(79, 52, 46, 255),
                      body=(13, 24, 37, 37), head=(36, 12, 50, 27), muzzle=(3, 3), legs=(8, 3),
                      ears="cat", tail="up", mark="mainecoon"),
    # 圣伯纳：巨头、白色大口吻带深色鼻镜、垂腮、桶身粗腿、白胸
    "saintbernard": dict(base=(170, 94, 54, 255), light=(240, 232, 216, 255), dark=(94, 52, 38, 255),
                         body=(10, 20, 40, 37), head=(36, 9, 53, 28), muzzle=(7, 7), legs=(8, 5),
                         ears="button", tail="bushy", mark="saintbernard"),
}


def outlined(sprite: Image.Image) -> Image.Image:
    alpha = sprite.getchannel("A")
    border_alpha = alpha.filter(ImageFilter.MaxFilter(3))
    border = Image.new("RGBA", sprite.size, OUTLINE)
    border.putalpha(border_alpha)
    border.alpha_composite(sprite)
    return border


def draw_tail(d: ImageDraw.ImageDraw, kind: str, cfg, body) -> None:
    c, dark = cfg["base"], cfg["dark"]
    x0, y0 = body[0], body[1]
    if kind == "nub":  # 柯基小圆尾
        d.ellipse((x0 - 3, y0 + 9, x0 + 2, y0 + 14), fill=c)
    elif kind == "curl":  # 阿拉斯加卷尾上背
        d.line((x0 + 1, y0 + 6, x0 - 4, y0 - 2, x0 + 1, y0 - 6, x0 + 8, y0 - 4), fill=dark, width=5)
        d.line((x0 + 1, y0 + 5, x0 - 3, y0 - 1, x0 + 2, y0 - 4, x0 + 7, y0 - 3), fill=c, width=3)
    elif kind == "plume":  # 羽毛尾（金毛/伯恩山）
        d.polygon(((x0 + 2, y0 + 12), (x0 - 8, y0 + 13), (x0 - 10, y0 + 5), (x0 - 5, y0 - 2), (x0 + 3, y0 + 6)), fill=c)
        d.line((x0 - 7, y0 + 10, x0, y0 + 5), fill=dark, width=1)
        d.line((x0 - 5, y0 + 12, x0 + 1, y0 + 8), fill=dark, width=1)
    elif kind == "up":  # 猫尾高卷
        d.line((x0 + 1, y0 + 10, x0 - 3, y0 - 2, x0 - 1, y0 - 12, x0 + 4, y0 - 14), fill=dark, width=4)
        d.line((x0 + 1, y0 + 9, x0 - 2, y0 - 2, x0, y0 - 11, x0 + 3, y0 - 12), fill=c, width=2)
        d.point((x0 + 4, y0 - 14), fill=cfg["light"])
    elif kind == "bushy":  # 下垂蓬尾（德牧/圣伯纳）
        d.polygon(((x0 + 2, y0 + 8), (x0 - 5, y0 + 10), (x0 - 7, y0 + 20), (x0 - 3, y0 + 25), (x0 + 2, y0 + 18)), fill=dark)
        d.polygon(((x0 + 2, y0 + 9), (x0 - 4, y0 + 11), (x0 - 5, y0 + 19), (x0 - 2, y0 + 22), (x0 + 1, y0 + 17)), fill=c)
    else:  # thin 细尾（巴吉度/腊肠）
        d.line((x0 + 1, y0 + 8, x0 - 5, y0 + 2, x0 - 6, y0 - 4), fill=dark, width=3)
        d.line((x0 + 1, y0 + 7, x0 - 4, y0 + 2, x0 - 5, y0 - 3), fill=c, width=1)


def draw_ears(d: ImageDraw.ImageDraw, kind: str, cfg, head) -> None:
    c, light, dark = cfg["base"], cfg["light"], cfg["dark"]
    hx0, hy0, hx1, hy1 = head
    hw = hx1 - hx0
    if kind == "point":  # 立耳（柯基大耳/阿拉斯加、德牧）
        d.polygon(((hx0 + 1, hy0 + 4), (hx0 + 2, hy0 - 6), (hx0 + 7, hy0 + 2)), fill=dark)
        d.polygon(((hx0 + 2, hy0 + 3), (hx0 + 3, hy0 - 4), (hx0 + 6, hy0 + 2)), fill=c)
        d.polygon(((hx0 + hw - 7, hy0 + 2), (hx0 + hw - 2, hy0 - 7), (hx0 + hw, hy0 + 4)), fill=dark)
        d.polygon(((hx0 + hw - 6, hy0 + 2), (hx0 + hw - 3, hy0 - 5), (hx0 + hw - 1, hy0 + 3)), fill=c)
        d.polygon(((hx0 + 3, hy0 + 1), (hx0 + 4, hy0 - 3), (hx0 + 5, hy0 + 1)), fill=light)
    elif kind == "long":  # 巴吉度垂地长耳
        d.rounded_rectangle((hx0 - 2, hy0 + 3, hx0 + 4, hy1 + 8), radius=3, fill=dark)
        d.rounded_rectangle((hx1 - 3, hy0 + 3, hx1 + 3, hy1 + 7), radius=3, fill=dark)
        d.line((hx0 + 1, hy0 + 6, hx0 + 1, hy1 + 5), fill=c, width=1)
    elif kind == "cat":  # 猫大三角耳 + 耳簇 + 内耳
        d.polygon(((hx0, hy0 + 4), (hx0 + 3, hy0 - 7), (hx0 + 8, hy0 + 2)), fill=dark)
        d.polygon(((hx0 + 1, hy0 + 3), (hx0 + 3, hy0 - 4), (hx0 + 6, hy0 + 2)), fill=c)
        d.polygon(((hx0 + 2, hy0 + 1), (hx0 + 3, hy0 - 2), (hx0 + 5, hy0 + 1)), fill=light)
        d.line((hx0 + 3, hy0 - 7, hx0 + 2, hy0 - 10), fill=dark)  # 耳簇
        d.polygon(((hx0 + hw - 8, hy0 + 2), (hx0 + hw - 2, hy0 - 8), (hx0 + hw + 1, hy0 + 4)), fill=dark)
        d.polygon(((hx0 + hw - 7, hy0 + 2), (hx0 + hw - 3, hy0 - 5), (hx0 + hw - 1, hy0 + 3)), fill=c)
        d.polygon(((hx0 + hw - 6, hy0 + 1), (hx0 + hw - 3, hy0 - 3), (hx0 + hw - 2, hy0 + 1)), fill=light)
        d.line((hx0 + hw - 2, hy0 - 8, hx0 + hw - 1, hy0 - 11), fill=dark)
    elif kind == "button":  # 圣伯纳小折耳贴头
        d.polygon(((hx0, hy0 + 2), (hx0 - 2, hy0 + 6), (hx0 + 2, hy0 + 9), (hx0 + 4, hy0 + 4)), fill=dark)
        d.polygon(((hx1 - 2, hy0 + 2), (hx1 + 2, hy0 + 6), (hx1, hy0 + 10), (hx1 - 4, hy0 + 5)), fill=dark)
    else:  # flop 垂耳（金毛/腊肠/伯恩山）
        d.polygon(((hx0 + 1, hy0 + 3), (hx0 - 3, hy0 + 6), (hx0, hy1 + 3), (hx0 + 4, hy1 - 1)), fill=dark)
        d.polygon(((hx0 + 2, hy0 + 4), (hx0 - 1, hy0 + 6), (hx0 + 1, hy1 + 1), (hx0 + 3, hy1 - 1)), fill=c)
        d.polygon(((hx1 - 3, hy0 + 2), (hx1 + 2, hy0 + 6), (hx1, hy1 + 2), (hx1 - 4, hy1 - 1)), fill=dark)


def draw_face(d: ImageDraw.ImageDraw, cfg, head, muzzle, sad=False, cat=False) -> None:
    """口鼻重构：吻部前突 + 鼻尖深色鼻镜 + 鼻下中线 + 嘴线；眼睛带高光。"""
    light, dark = cfg["light"], cfg["dark"]
    hx0, hy0, hx1, hy1 = head
    mlen, mh = muzzle
    my = hy0 + (hy1 - hy0) // 2 - 1
    # 吻部（浅色块前突）
    if mlen > 0:
        d.rounded_rectangle((hx1 - 3, my, hx1 + mlen, my + mh), radius=2, fill=light)
        # 鼻镜：鼻尖 2×2 深色 + 高光点，不再是一团糊
        d.rectangle((hx1 + mlen - 1, my, hx1 + mlen + 1, my + 2), fill=NOSE)
        d.point((hx1 + mlen, my), fill=(90, 80, 92, 255))
        # 鼻下中线 + 嘴角
        d.line((hx1 + mlen, my + 3, hx1 + mlen, my + mh), fill=dark)
        d.line((hx1 + mlen, my + mh, hx1 + mlen - 2, my + mh + 1), fill=dark)
    # 眼睛：猫眼更大更圆，巴吉度下垂眼
    ex, ey = hx1 - 5, hy0 + (4 if not sad else 6)
    if cat:
        d.rectangle((ex - 1, ey - 1, ex + 1, ey + 1), fill=EYE)
        d.point((ex, ey - 1), fill=HIGHLIGHT)
    elif sad:
        d.rectangle((ex - 1, ey, ex, ey + 1), fill=EYE)
        d.point((ex - 1, ey), fill=HIGHLIGHT)
        d.line((ex - 2, ey - 2, ex + 1, ey - 1), fill=dark)  # 下垂眉
    else:
        d.rectangle((ex - 1, ey - 1, ex, ey), fill=EYE)
        d.point((ex, ey - 1), fill=HIGHLIGHT)


def draw_legs(d: ImageDraw.ImageDraw, cfg, body) -> None:
    c, light, dark = cfg["base"], cfg["light"], cfg["dark"]
    leglen, legw = cfg["legs"]
    bx0, by0, bx1, by1 = body
    foot_y = by1 + leglen
    xs = [bx0 + 2, bx0 + (bx1 - bx0) // 2 - 1, bx1 - legw - 1]
    for i, x in enumerate(xs):
        d.rectangle((x, by1 - 2, x + legw - 1, foot_y - 2), fill=dark)
        paw = light if i != 1 else c
        d.rectangle((x, foot_y - 2, x + legw, foot_y), fill=paw)


def draw_markings(d: ImageDraw.ImageDraw, mark: str, cfg, body, head) -> None:
    c, light, dark = cfg["base"], cfg["light"], cfg["dark"]
    bx0, by0, bx1, by1 = body
    hx0, hy0, hx1, hy1 = head
    if mark == "golden":
        # 浅胸毛 + 前腿羽毛
        d.polygon(((hx0 - 1, by0 + 6), (hx0 + 4, by0 + 5), (hx0 + 5, by1), (hx0 - 2, by1)), fill=light)
        d.line((bx0 + 3, by1 + 2, bx0 + 2, by1 + 5), fill=light, width=1)
    elif mark == "corgi":
        # 白胸 + 白脸中线
        d.rectangle((hx0 - 1, by0 + 4, hx0 + 4, by1), fill=light)
        d.rectangle((hx1 - 5, hy0 + 1, hx1 - 3, hy0 + 5), fill=light)
    elif mark == "malamute":
        # 白色面具
        d.polygon(((hx0 + 2, hy0 + 2), (hx0 + 6, hy0 + 6), (hx1 - 4, hy0 + 2), (hx1 - 1, hy0 + 8),
                   (hx1 - 3, hy1 - 2), (hx0 + 3, hy1 - 1)), fill=light)
        d.rectangle((bx0 + 2, by0 + 2, bx1 - 2, by0 + 4), fill=dark)  # 背线
    elif mark == "basset":
        # 白胸白吻 + 背部大斑块
        d.rectangle((hx0 - 1, by0 + 5, hx0 + 4, by1), fill=light)
        d.rectangle((bx0 + 8, by0 + 1, bx0 + 16, by0 + 5), fill=dark)
    elif mark == "shepherd":
        # 黑背鞍纹 + 黑吻
        d.polygon(((bx0 + 2, by0), (bx1 - 4, by0), (bx1 - 1, by0 + 8), (bx0 + 6, by0 + 9)), fill=dark)
        d.polygon(((hx0 + 3, hy0 + 1), (hx1 - 2, hy0 + 1), (hx1, hy0 + 7), (hx0 + 6, hy0 + 8)), fill=dark)
    elif mark == "dachshund":
        d.rectangle((hx0 - 1, by0 + 5, hx0 + 3, by1), fill=light)  # 浅胸
    elif mark == "dachshund_tri":
        # 三色：褐眉点 / 褐颊 / 褐腿
        d.rectangle((hx1 - 6, hy0 + 2, hx1 - 4, hy0 + 3), fill=light)
        d.rectangle((hx0 - 1, by0 + 5, hx0 + 3, by1), fill=light)
    elif mark == "bernese":
        accent = cfg["accent"]
        # 白面纹 + 白胸 + 棕眉点与棕腿
        d.rectangle((hx1 - 6, hy0, hx1 - 4, hy1 - 4), fill=light)
        d.rectangle((hx0 - 1, by0 + 4, hx0 + 4, by1), fill=light)
        d.rectangle((hx1 - 7, hy0 + 2, hx1 - 6, hy0 + 3), fill=accent)
        d.rectangle((bx0 + 2, by1 - 3, bx0 + 6, by1), fill=accent)
        d.rectangle((bx1 - 7, by1 - 3, bx1 - 3, by1), fill=accent)
    elif mark == "mainecoon":
        # 虎斑条纹：背部 + 尾根；白胸
        for x in (bx0 + 5, bx0 + 10, bx0 + 15):
            d.line((x, by0 + 1, x - 2, by0 + 7), fill=dark, width=2)
        d.rectangle((hx0 - 1, by0 + 5, hx0 + 3, by1), fill=light)
        d.rectangle((hx0 + 2, hy0 + 1, hx0 + 6, hy0 + 3), fill=dark)  # 额头 M 纹底
    elif mark == "saintbernard":
        # 白胸大片 + 白颈
        d.polygon(((hx0 - 2, by0 + 3), (hx0 + 5, by0 + 3), (hx0 + 6, by1), (hx0 - 3, by1)), fill=light)
        d.rectangle((hx0, hy1 - 2, hx0 + 5, hy1 + 1), fill=light)


def companion(companion_id: str) -> Image.Image:
    cfg = CONFIGS[companion_id]
    c = cfg["base"]
    body, head, muzzle = cfg["body"], cfg["head"], cfg["muzzle"]
    sprite = Image.new("RGBA", (64, 48), (0, 0, 0, 0))
    d = ImageDraw.Draw(sprite)

    draw_tail(d, cfg["tail"], cfg, body)
    # 躯干
    d.rounded_rectangle(body, radius=4, fill=c)
    d.line((body[0] + 3, body[1] + 1, body[2] - 4, body[1] + 1), fill=cfg["light"], width=1)  # 背部高光
    # 头
    d.rounded_rectangle(head, radius=4, fill=c)
    draw_ears(d, cfg["ears"], cfg, head)
    draw_markings(d, cfg["mark"], cfg, body, head)
    draw_face(d, cfg, head, muzzle, sad=(cfg["mark"] == "basset"), cat=(cfg["ears"] == "cat"))
    draw_legs(d, cfg, body)
    if cfg["ears"] == "cat":
        # 胡须是猫的底线
        hx1 = head[2]
        my = head[1] + (head[3] - head[1]) // 2 + 2
        d.line((hx1 - 1, my, hx1 + 7, my - 2), fill=cfg["dark"])
        d.line((hx1 - 1, my + 2, hx1 + 7, my + 3), fill=cfg["dark"])
    return outlined(sprite)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for companion_id in CONFIGS:
        out = args.out_dir / f"dog_{companion_id}.png"
        if out.exists() and not args.force:
            raise FileExistsError(f"{out} exists (use --force)")
        image = companion(companion_id).resize((256, 192), Image.Resampling.NEAREST)
        image.save(out)
        print(f"Wrote {out}")


if __name__ == "__main__":
    main()
