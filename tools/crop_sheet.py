# -*- coding: utf-8 -*-
"""从像素鱼图鉴精灵表裁剪单鱼贴图：裁格 -> 去白底 -> 透明 -> 修剪 -> 输出到 frontend/assets/fish/"""
import argparse, os
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = ROOT / "frontend" / "assets" / "fish"

# 行优先对应精灵表 6x3 格子（最后一格是标牌，忽略）
IDS = [
    "crucian", "carp", "grass", "white", "tilapia", "minnow",
    "sardine", "croaker", "yellowcat", "silvercarp", "bighead", "riverperch",
    "tuna", "culter", "blackcarp", "bass", "seabass",
]

def is_grid(px):
    r, g, b = px[:3]
    return abs(r - g) < 12 and abs(g - b) < 12 and 170 < r < 240

def find_lines(img):
    w, h = img.size
    px = img.load()
    vcols, hrows = [], []
    for x in range(w):
        n = sum(1 for y in range(0, h, 4) if is_grid(px[x, y]))
        if n > (h // 4) * 0.9:
            vcols.append(x)
    for y in range(h):
        n = sum(1 for x in range(0, w, 4) if is_grid(px[x, y]))
        if n > (w // 4) * 0.9:
            hrows.append(y)
    # 合并连续线
    def merge(vals):
        groups, cur = [], [vals[0]]
        for v in vals[1:]:
            if v - cur[-1] <= 2:
                cur.append(v)
            else:
                groups.append(sum(cur) // len(cur))
                cur = [v]
        groups.append(sum(cur) // len(cur))
        return groups
    return merge(vcols), merge(hrows)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sheet", type=Path, required=True, help="Source 6x3 sprite sheet")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    img = Image.open(args.sheet).convert("RGBA")
    vlines, hlines = find_lines(img)
    print("vlines:", vlines)
    print("hlines:", hlines)
    assert len(vlines) == 7 and len(hlines) == 4, "网格线检测失败"

    for idx, fid in enumerate(IDS):
        row, col = idx // 6, idx % 6
        x0, x1 = vlines[col] + 2, vlines[col + 1] - 2
        y0, y1 = hlines[row] + 2, hlines[row + 1] - 2
        cell = img.crop((x0, y0, x1, y1))
        # 去掉文字：只保留上半部分（贴图在格子上半，文字在下半）
        cell = cell.crop((0, 0, cell.width, int(cell.height * 0.62)))
        # 白底 -> 透明
        data = cell.getdata()
        new = []
        cell.putdata(data)
        # 泛洪去底：只把与边缘连通的近白/浅灰像素变透明（保留鱼腹白色）
        w, h = cell.size
        px = cell.load()
        from collections import deque
        dq = deque()
        seen = bytearray(w * h)
        def bgish(p):
            r, g, b = p[:3]
            return min(r, g, b) > 195 and max(r, g, b) - min(r, g, b) < 30
        for x in range(w):
            for y in (0, h - 1):
                if bgish(px[x, y]):
                    dq.append((x, y)); seen[y * w + x] = 1
        for y in range(h):
            for x in (0, w - 1):
                if bgish(px[x, y]):
                    dq.append((x, y)); seen[y * w + x] = 1
        while dq:
            x, y = dq.popleft()
            px[x, y] = (0, 0, 0, 0)
            for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
                if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and bgish(px[nx, ny]):
                    seen[ny * w + nx] = 1
                    dq.append((nx, ny))
        # 修剪透明边
        bbox = cell.getbbox()
        if bbox:
            cell = cell.crop(bbox)
        cell.save(os.path.join(args.out_dir, fid + ".png"))
        print(fid, cell.size)

if __name__ == "__main__":
    main()
