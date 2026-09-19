#!/usr/bin/env python3
"""Generate original pixel-art anglers and boats used by the character page.

The artwork is drawn from geometric pixel primitives at the game's logical
resolution, then enlarged with nearest-neighbour sampling. It is deterministic,
transparent, and does not depend on external game assets or online services.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CHAR_DIR = ROOT / "frontend" / "assets" / "ui" / "chars"
DEFAULT_BOAT_DIR = ROOT / "frontend" / "assets" / "ui" / "char"
OUTLINE = (13, 25, 42, 255)
ROD = (91, 61, 39, 255)
LINE = (196, 224, 226, 255)
BOB = (237, 79, 55, 255)

PALETTES = {
    "lan": {
        "skin": (192, 132, 82, 255), "skin_hi": (225, 167, 105, 255),
        "hat": (215, 105, 35, 255), "hat_hi": (243, 145, 48, 255),
        "coat": (40, 171, 161, 255), "coat_hi": (83, 211, 192, 255),
        "pants": (34, 58, 91, 255), "boots": (20, 38, 62, 255),
        "accent": (202, 132, 45, 255), "hair": (50, 37, 34, 255),
    },
    "mo": {
        "skin": (139, 91, 65, 255), "skin_hi": (178, 121, 82, 255),
        "hat": (188, 157, 101, 255), "hat_hi": (224, 193, 126, 255),
        "coat": (43, 63, 94, 255), "coat_hi": (67, 91, 128, 255),
        "pants": (38, 43, 55, 255), "boots": (19, 29, 42, 255),
        "accent": (164, 55, 58, 255), "hair": (29, 29, 33, 255),
    },
    "li": {
        "skin": (152, 106, 76, 255), "skin_hi": (190, 136, 96, 255),
        "hat": (96, 110, 88, 255), "hat_hi": (128, 144, 116, 255),
        "coat": (70, 86, 70, 255), "coat_hi": (100, 118, 96, 255),
        "pants": (52, 50, 48, 255), "boots": (30, 32, 30, 255),
        "accent": (186, 142, 60, 255), "hair": (40, 36, 34, 255),
    },
}


def outline_sprite(sprite: Image.Image) -> Image.Image:
    alpha = sprite.getchannel("A")
    expanded = alpha.filter(ImageFilter.MaxFilter(3))
    border = Image.new("RGBA", sprite.size, OUTLINE)
    border.putalpha(expanded)
    border.alpha_composite(sprite)
    return border


def draw_rod(draw: ImageDraw.ImageDraw, hand: tuple[int, int], tip: tuple[int, int], line_end=None) -> None:
    # 竿：深色粗描边 + 木色竿身 + 握把与线轮细节
    draw.line((hand, tip), fill=OUTLINE, width=3)
    draw.line((hand, tip), fill=ROD, width=1)
    hx, hy = hand
    draw.rectangle((hx - 2, hy - 1, hx, hy + 1), fill=(52, 34, 24, 255))  # 握把
    draw.point((hx + 1, hy + 2), fill=(60, 68, 78, 255))                 # 线轮
    if line_end:
        draw.line((tip, line_end), fill=LINE, width=1)
        x, y = line_end
        draw.rectangle((x - 1, y - 1, x + 1, y + 1), fill=BOB)
        draw.point((x, y - 1), fill=(255, 214, 170, 255))


def draw_hat(draw: ImageDraw.ImageDraw, p, ox: int, oy: int, kind: str) -> None:
    if kind == "broad":  # 墨的宽檐斗笠
        draw.polygon(((ox - 7, oy + 3), (ox, oy - 3), (ox + 7, oy + 3)), fill=p["hat"])
        draw.rectangle((ox - 9, oy + 3, ox + 9, oy + 4), fill=p["hat_hi"])
        draw.rectangle((ox - 1, oy - 4, ox + 1, oy - 3), fill=p["accent"])
        draw.line((ox - 6, oy + 4, ox + 6, oy + 4), fill=p["hat"], width=1)
    elif kind == "hood":  # 砾的兜帽
        draw.polygon(((ox - 6, oy + 5), (ox - 5, oy - 3), (ox, oy - 6), (ox + 5, oy - 3), (ox + 6, oy + 5)), fill=p["hat"])
        draw.polygon(((ox - 4, oy + 4), (ox - 3, oy - 2), (ox, oy - 4), (ox + 3, oy - 2), (ox + 4, oy + 4)), fill=p["hat_hi"])
        draw.rectangle((ox - 6, oy + 4, ox + 6, oy + 5), fill=p["hat"])
    else:  # 澜的鸭舌帽
        draw.rectangle((ox - 5, oy - 1, ox + 5, oy + 3), fill=p["hat"])
        draw.rectangle((ox - 4, oy - 3, ox + 3, oy - 1), fill=p["hat_hi"])
        draw.rectangle((ox + 4, oy + 2, ox + 8, oy + 4), fill=p["hat"])   # 帽檐
        draw.point((ox, oy - 3), fill=p["accent"])                        # 帽扣


def draw_head(draw: ImageDraw.ImageDraw, p, ox: int, oy: int, char_id: str) -> None:
    """头部：脸型 + 后发 + 耳 + 眉 + 眼（带高光）+ 腮红；ox,oy 为头中心偏上。"""
    # 后发（帽子下露出的头发）
    draw.rectangle((ox - 6, oy - 2, ox - 4, oy + 5), fill=p["hair"])
    draw.rectangle((ox - 5, oy + 5, ox - 3, oy + 7), fill=p["hair"])
    # 脸
    draw.polygon(((ox - 5, oy - 2), (ox - 2, oy - 5), (ox + 3, oy - 4), (ox + 5, oy - 1),
                  (ox + 5, oy + 4), (ox + 2, oy + 7), (ox - 3, oy + 6), (ox - 5, oy + 3)), fill=p["skin"])
    draw.rectangle((ox + 1, oy - 3, ox + 5, oy + 3), fill=p["skin_hi"])   # 面部受光
    draw.point((ox + 5, oy + 1), fill=p["skin"])                          # 鼻尖轮廓
    draw.rectangle((ox + 2, oy - 1, ox + 3, oy), fill=(15, 23, 31, 255))   # 眼
    draw.point((ox + 3, oy - 1), fill=(245, 231, 200, 255))                # 高光
    draw.line((ox + 1, oy - 3, ox + 4, oy - 3), fill=p["hair"])            # 眉
    draw.point((ox + 4, oy + 3), fill=(226, 138, 110, 255))                # 腮红
    draw.point((ox - 4, oy + 1), fill=p["skin_hi"])                        # 耳
    if char_id == "mo":  # 围巾绕颈垂下
        draw.rectangle((ox - 4, oy + 5, ox + 4, oy + 7), fill=p["accent"])
        draw.rectangle((ox + 2, oy + 7, ox + 4, oy + 12), fill=p["accent"])
    if char_id == "li":  # 矿石挂坠
        draw.line((ox - 2, oy + 6, ox + 2, oy + 8), fill=(52, 44, 40, 255))
        draw.rectangle((ox + 1, oy + 8, ox + 3, oy + 10), fill=p["accent"])
        draw.point((ox + 2, oy + 8), fill=(255, 230, 160, 255))


def character_sprite(char_id: str, pose: str) -> Image.Image:
    p = PALETTES[char_id]
    hat_kind = {"lan": "cap", "mo": "broad", "li": "hood"}[char_id]
    if pose == "sit":
        canvas = Image.new("RGBA", (96, 60), (0, 0, 0, 0))
        body = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(body)
        # 折叠凳（垫在臀下）
        d.line((37, 42, 33, 55), fill=OUTLINE, width=2)
        d.line((47, 42, 51, 55), fill=OUTLINE, width=2)
        d.rectangle((33, 40, 51, 43), fill=(91, 61, 39, 255))
        d.rectangle((35, 40, 49, 41), fill=(207, 137, 69, 255))
        # 小腿 + 靴（凳右前方，靴底与凳脚同踩一条地线）
        d.rectangle((55, 41, 61, 51), fill=p["pants"])          # 小腿
        d.rectangle((53, 50, 65, 55), fill=p["boots"])          # 靴朝右
        d.rectangle((53, 53, 65, 55), fill=OUTLINE)             # 鞋底
        d.point((63, 51), fill=(60, 68, 78, 255))               # 靴面高光
        # 臀 + 大腿并拢前伸（盖住凳面前缘，中间一道腿缝）
        d.rectangle((34, 33, 58, 41), fill=p["pants"])
        d.line((35, 38, 57, 38), fill=OUTLINE, width=1)
        # 躯干大衣
        d.polygon(((32, 18), (46, 18), (50, 26), (48, 36), (32, 36), (30, 26)), fill=p["coat"])
        d.polygon(((40, 18), (46, 18), (50, 26), (48, 36), (42, 36)), fill=p["coat_hi"])
        d.rectangle((32, 33, 48, 35), fill=p["accent"])         # 腰带
        d.rectangle((29, 22, 33, 34), fill=p["accent"])         # 挎包带
        d.rectangle((28, 30, 33, 38), fill=(52, 34, 24, 255))   # 挎包
        # 手臂前伸握竿
        d.line((44, 24, 54, 30), fill=p["coat_hi"], width=4)
        d.line((44, 24, 54, 30), fill=p["coat"], width=2)
        d.rectangle((53, 28, 57, 32), fill=p["skin_hi"])        # 手
        draw_head(d, p, 38, 12, char_id)
        draw_hat(d, p, 38, 5, hat_kind)
        body = outline_sprite(body)
        canvas.alpha_composite(body)
        dr = ImageDraw.Draw(canvas)
        draw_rod(dr, (56, 30), (80, 10), (86, 44))
        return canvas

    canvas = Image.new("RGBA", (48, 40), (0, 0, 0, 0))
    body = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(body)
    bob = 0 if pose == "hold" else (-1 if pose == "a" else 1)
    # 腿并拢：前后两条紧贴（后侧暗一档），靴子并排
    d.rectangle((19, 26, 23, 35), fill=p["pants"])
    d.rectangle((23, 26, 27, 35), fill=p["pants"])
    d.line((23, 27, 23, 34), fill=OUTLINE)                      # 腿缝
    d.rectangle((18, 34, 23, 37), fill=p["boots"])
    d.rectangle((23, 34, 28, 37), fill=p["boots"])
    d.rectangle((18, 36, 28, 37), fill=OUTLINE)                 # 鞋底
    d.point((26, 34), fill=(60, 68, 78, 255))
    # 躯干大衣：左暗右亮，腰带收口，下摆微张
    d.polygon(((16, 15), (30, 15), (33, 21), (31, 28), (15, 28), (13, 21)), fill=p["coat"])
    d.polygon(((24, 15), (30, 15), (33, 21), (31, 28), (25, 28)), fill=p["coat_hi"])
    d.line((15, 27, 31, 27), fill=OUTLINE, width=1)
    d.rectangle((15, 24, 31, 26), fill=p["accent"])             # 腰带
    d.rectangle((12, 17, 16, 26), fill=p["accent"])             # 挎包带
    d.rectangle((10, 22, 15, 29), fill=(52, 34, 24, 255))       # 挎包
    d.point((11, 23), fill=(207, 137, 69, 255))
    # 头 + 帽
    draw_head(d, p, 23, 7, char_id)
    draw_hat(d, p, 23, 2, hat_kind)
    # 手臂与竿（按姿势变化）
    if pose == "a":  # 后摆
        d.line((28, 18, 34, 14), fill=p["coat_hi"], width=4)
        d.line((28, 18, 34, 14), fill=p["coat"], width=2)
        d.rectangle((33, 12, 36, 15), fill=p["skin_hi"])
        hand, tip, end = (35, 13), (44, 1), None
    elif pose == "b":  # 前挥
        d.line((28, 18, 36, 18), fill=p["coat_hi"], width=4)
        d.line((28, 18, 36, 18), fill=p["coat"], width=2)
        d.rectangle((35, 16, 38, 19), fill=p["skin_hi"])
        hand, tip, end = (37, 17), (46, 7), None
    else:  # 持杆
        d.line((28, 18, 36, 21), fill=p["coat_hi"], width=4)
        d.line((28, 18, 36, 21), fill=p["coat"], width=2)
        d.rectangle((35, 19, 38, 22), fill=p["skin_hi"])
        hand, tip, end = (37, 20), (46, 11), (45, 34)
    body = outline_sprite(body)
    canvas.alpha_composite(body)
    draw_rod(ImageDraw.Draw(canvas), hand, tip, end)
    return canvas


def boat_sprite(boat_id: str) -> Image.Image:
    canvas = Image.new("RGBA", (128, 64), (0, 0, 0, 0))
    hull = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(hull)
    if boat_id == "marsh_skiff":
        cedar = (139, 82, 48, 255); cedar_hi = (207, 137, 69, 255); cedar_dark = (73, 43, 38, 255)
        teal = (37, 173, 158, 255); teal_hi = (81, 211, 188, 255); reed = (222, 174, 69, 255)
        # Chunky shallow-draft silhouette with a raised bow and broad open cockpit.
        d.polygon(((10, 31), (99, 30), (118, 22), (115, 45), (105, 53), (23, 53), (12, 44)), fill=cedar)
        d.polygon(((15, 32), (105, 30), (111, 27), (105, 38), (21, 41)), fill=cedar_hi)
        d.rectangle((24, 42, 105, 50), fill=cedar_dark)
        d.line((22, 50, 106, 46), fill=teal, width=3)
        d.line((24, 47, 105, 43), fill=teal_hi, width=1)
        for x in (34, 54, 76, 96):
            d.line((x, 40, x - 2, 49), fill=cedar, width=1)
        # Open cockpit, padded seat and compact tackle box.
        d.rectangle((50, 27, 86, 37), fill=cedar_dark)
        d.rectangle((57, 25, 69, 31), fill=reed)
        d.rectangle((74, 24, 87, 32), fill=(219, 205, 153, 255))
        d.rectangle((77, 22, 84, 24), fill=teal)
        # Reed fenders and a single oversized oar keep the silhouette playful.
        for x in (28, 45, 98):
            d.rectangle((x, 47, x + 4, 54), fill=reed)
        d.line((33, 17, 88, 46), fill=OUTLINE, width=4)
        d.line((34, 17, 89, 46), fill=cedar_hi, width=2)
        d.polygon(((29, 13), (38, 16), (35, 22), (27, 18)), fill=reed)
    elif boat_id == "leaky_bucket":
        plank = (146, 100, 58, 255); plank_hi = (196, 146, 92, 255); plank_dark = (84, 56, 40, 255)
        patch = (110, 118, 124, 255); rope = (206, 178, 122, 255)
        # Low squat hull cobbled from barrel staves, with a visible metal patch.
        d.polygon(((14, 34), (96, 33), (112, 27), (108, 48), (98, 55), (26, 55), (16, 47)), fill=plank)
        d.polygon(((18, 35), (100, 33), (105, 30), (99, 41), (24, 44)), fill=plank_hi)
        d.rectangle((26, 45, 100, 52), fill=plank_dark)
        for x in (34, 50, 66, 82):
            d.line((x, 34, x - 1, 53), fill=plank_dark, width=1)
        # Metal patch plating over the leak, plus rope lashing on the bow.
        d.rectangle((78, 40, 92, 50), fill=patch)
        d.rectangle((80, 42, 90, 48), fill=(138, 146, 152, 255))
        d.line((18, 36, 26, 52), fill=rope, width=2)
        # Simple bench seat and a bucket (bailing, of course).
        d.rectangle((46, 30, 70, 36), fill=plank_dark)
        d.rectangle((88, 28, 98, 36), fill=patch)
        d.rectangle((88, 28, 98, 30), fill=(84, 92, 98, 255))
    elif boat_id == "snow_wolf":
        white = (214, 222, 228, 255); white_hi = (244, 248, 250, 255); grey_dark = (88, 100, 112, 255)
        ice = (126, 190, 214, 255); amber = (246, 164, 49, 255); steel = (141, 166, 171, 255)
        # Angular icebreaker bow with a reinforced grey belt.
        d.polygon(((8, 30), (98, 29), (122, 20), (116, 46), (104, 55), (24, 55), (10, 46)), fill=white)
        d.polygon(((13, 31), (104, 29), (112, 25), (106, 37), (20, 42)), fill=white_hi)
        d.rectangle((22, 44, 108, 53), fill=grey_dark)
        d.line((24, 50, 106, 47), fill=ice, width=2)
        # Wolf-ear fin on the compact cabin and a warm porthole.
        d.rectangle((52, 20, 88, 34), fill=white_hi)
        d.polygon(((54, 20), (58, 12), (64, 20)), fill=grey_dark)
        d.polygon(((76, 20), (82, 12), (88, 20)), fill=grey_dark)
        d.rectangle((62, 24, 70, 30), fill=(24, 57, 82, 255))
        d.rectangle((76, 24, 80, 28), fill=amber)
        d.rectangle((46, 33, 94, 37), fill=grey_dark)
        # Ice ridge along the waterline and a small mast.
        for x in (30, 46, 62):
            d.polygon(((x, 54), (x + 5, 54), (x + 2, 58)), fill=ice)
        d.line((100, 26, 106, 10), fill=OUTLINE, width=3)
        d.polygon(((106, 10), (114, 12), (106, 15)), fill=amber)
    elif boat_id == "tide_cutter":
        blue = (40, 88, 126, 255); blue_hi = (78, 151, 176, 255); blue_dark = (22, 46, 76, 255)
        deck = (171, 103, 52, 255); steel = (141, 166, 171, 255); cream = (222, 221, 196, 255); amber = (246, 164, 49, 255)
        # Deep rounded hull with a tall wave-cutting bow.
        d.polygon(((7, 30), (101, 29), (121, 18), (118, 45), (105, 56), (24, 56), (11, 47)), fill=blue)
        d.polygon(((12, 31), (108, 28), (114, 24), (108, 38), (18, 43)), fill=blue_hi)
        d.rectangle((23, 45, 109, 53), fill=blue_dark)
        d.line((24, 51, 106, 48), fill=(91, 181, 194, 255), width=2)
        # Oversized chibi cabin: broad roof, two bright windows and a warm deck.
        d.rectangle((49, 19, 91, 35), fill=cream)
        d.polygon(((56, 11), (82, 11), (93, 20), (48, 20)), fill=blue)
        d.rectangle((59, 14, 69, 21), fill=(24, 57, 82, 255))
        d.rectangle((73, 14, 83, 21), fill=(24, 57, 82, 255))
        d.rectangle((45, 33, 98, 38), fill=deck)
        d.rectangle((52, 24, 55, 28), fill=amber)
        d.rectangle((91, 24, 94, 28), fill=amber)
        # Rails and two empty rod holders.
        d.line((22, 26, 22, 45), fill=steel, width=2)
        d.line((99, 21, 99, 43), fill=steel, width=2)
        d.line((99, 22, 113, 22), fill=steel, width=2)
        d.line((28, 28, 23, 10), fill=OUTLINE, width=3)
        d.line((104, 28, 110, 8), fill=OUTLINE, width=3)
    else:
        # coast_rambler
        blue = (36, 96, 150, 255); blue_hi = (84, 156, 200, 255); blue_dark = (20, 52, 92, 255)
        cream = (238, 236, 220, 255); deck = (186, 132, 74, 255); amber = (246, 164, 49, 255); steel = (141, 166, 171, 255)
        # Long cruising hull with a sweeping sheer line.
        d.polygon(((6, 29), (100, 28), (123, 17), (119, 46), (106, 56), (22, 56), (9, 46)), fill=blue)
        d.polygon(((11, 30), (106, 28), (115, 23), (108, 37), (18, 42)), fill=blue_hi)
        d.rectangle((22, 45, 110, 54), fill=blue_dark)
        d.line((24, 52, 108, 49), fill=cream, width=2)
        # Wide cabin with three windows, flybridge roof and railing.
        d.rectangle((44, 18, 94, 34), fill=cream)
        d.polygon(((50, 10), (88, 10), (98, 19), (42, 19)), fill=blue_dark)
        for x in (50, 62, 74):
            d.rectangle((x, 22, x + 8, 29), fill=(24, 57, 82, 255))
        d.rectangle((40, 33, 100, 38), fill=deck)
        d.rectangle((100, 22, 103, 26), fill=amber)
        d.line((20, 24, 20, 44), fill=steel, width=2)
        d.line((104, 20, 104, 42), fill=steel, width=2)
        d.line((20, 25, 104, 21), fill=steel, width=1)
        d.line((30, 27, 24, 9), fill=OUTLINE, width=3)
    hull = outline_sprite(hull)
    canvas.alpha_composite(hull)
    return canvas


def save_scaled(image: Image.Image, path: Path, scale: int, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"{path} already exists (use --force)")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.resize((image.width * scale, image.height * scale), Image.Resampling.NEAREST).save(path)
    print(f"Wrote {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--char-dir", type=Path, default=DEFAULT_CHAR_DIR)
    parser.add_argument("--boat-dir", type=Path, default=DEFAULT_BOAT_DIR)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    for char_id in ("lan", "mo", "li"):
        for pose in ("a", "b", "hold", "sit"):
            scale = 5
            save_scaled(character_sprite(char_id, pose), args.char_dir / f"{char_id}_{pose}.png", scale, args.force)
    for boat_id in ("marsh_skiff", "leaky_bucket", "tide_cutter", "snow_wolf", "coast_rambler"):
        save_scaled(boat_sprite(boat_id), args.boat_dir / f"boat_{boat_id}.png", 4, args.force)


if __name__ == "__main__":
    main()
