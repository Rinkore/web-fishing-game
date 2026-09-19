#!/usr/bin/env python3
"""Convert generated chroma-key art into deterministic game-ready pixel PNGs.

Inputs must already have a real alpha channel (run the imagegen skill's
remove_chroma_key.py first). Character sheets use a fixed 2x2 layout:
idle A, idle B, rod hold, seated fishing.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import tempfile

from PIL import Image, ImageDraw


def die(message: str) -> None:
    raise SystemExit("Error: " + message)


def alpha_bbox(image: Image.Image, threshold: int = 24):
    alpha = image.getchannel("A").point(lambda value: 255 if value >= threshold else 0)
    return alpha.getbbox()


def hard_alpha(image: Image.Image, threshold: int = 96) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, alpha = pixels[x, y]
            pixels[x, y] = (red, green, blue, 255) if alpha >= threshold else (0, 0, 0, 0)
    return rgba


def quantize_visible(image: Image.Image, colors: int) -> Image.Image:
    rgba = hard_alpha(image)
    alpha = rgba.getchannel("A")
    # FASTOCTREE accepts RGBA and preserves a compact palette; restore a hard
    # alpha mask afterwards so transparent RGB is guaranteed to be zero.
    reduced = rgba.quantize(colors=colors, method=Image.Quantize.FASTOCTREE).convert("RGBA")
    reduced.putalpha(alpha)
    return hard_alpha(reduced)


def pixel_asset(
    source: Image.Image,
    output_size: tuple[int, int],
    block: int,
    colors: int,
    margin: int,
    bottom: int | None = None,
) -> Image.Image:
    source = hard_alpha(source)
    bbox = alpha_bbox(source)
    if not bbox:
        die("input region has no visible pixels")
    crop = source.crop(bbox)
    logical_w, logical_h = output_size[0] // block, output_size[1] // block
    max_w, max_h = logical_w - margin * 2, logical_h - margin * 2
    scale = min(max_w / crop.width, max_h / crop.height)
    width = max(1, round(crop.width * scale))
    height = max(1, round(crop.height * scale))
    small = crop.resize((width, height), Image.Resampling.LANCZOS)
    small = quantize_visible(small, colors)
    canvas = Image.new("RGBA", (logical_w, logical_h), (0, 0, 0, 0))
    x = (logical_w - width) // 2
    y = (logical_h - height) // 2 if bottom is None else max(margin, bottom - height)
    canvas.alpha_composite(small, (x, y))
    canvas = quantize_visible(canvas, colors)
    return canvas.resize(output_size, Image.Resampling.NEAREST)


def ensure_output(path: Path, force: bool) -> None:
    if path.exists() and not force:
        die(f"output already exists: {path} (use --force)")
    path.parent.mkdir(parents=True, exist_ok=True)


def process_character(args: argparse.Namespace) -> None:
    source = Image.open(args.input).convert("RGBA")
    mid_x, mid_y = source.width // 2, source.height // 2
    quadrants = [
        ("a", (0, 0, mid_x, mid_y), (180, 150), 5, 28, 2, 29),
        ("b", (mid_x, 0, source.width, mid_y), (180, 150), 5, 28, 2, 29),
        ("hold", (0, mid_y, mid_x, source.height), (180, 150), 5, 30, 2, 29),
        ("sit", (mid_x, mid_y, source.width, source.height), (320, 200), 5, 32, 3, 39),
    ]
    out_dir = Path(args.out_dir)
    for pose, box, size, block, colors, margin, bottom in quadrants:
        out = out_dir / f"{args.prefix}_{pose}.png"
        ensure_output(out, args.force)
        result = pixel_asset(source.crop(box), size, block, colors, margin, bottom)
        result.save(out)
        print(f"Wrote {out} {result.size}")


def process_boat(args: argparse.Namespace) -> None:
    source = Image.open(args.input).convert("RGBA")
    out = Path(args.out)
    ensure_output(out, args.force)
    # 64 logical rows; hull bottom lands near row 55, leaving room for a cabin.
    result = pixel_asset(source, (512, 256), 4, 48, 4, 55)
    result.save(out)
    print(f"Wrote {out} {result.size}")


def assert_pixel_blocks(image: Image.Image, block: int) -> None:
    rgba = image.convert("RGBA")
    for y in range(0, rgba.height, block):
        for x in range(0, rgba.width, block):
            color = rgba.getpixel((x, y))
            for yy in range(y, min(y + block, rgba.height)):
                for xx in range(x, min(x + block, rgba.width)):
                    if rgba.getpixel((xx, yy)) != color:
                        die(f"non-uniform {block}x{block} block at {x},{y}")


def self_test(_args: argparse.Namespace) -> None:
    with tempfile.TemporaryDirectory(prefix="pixel-asset-test-") as tmp:
        root = Path(tmp)
        sheet = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        draw = ImageDraw.Draw(sheet)
        for i, color in enumerate(((30, 170, 160, 255), (210, 120, 40, 255), (45, 70, 120, 255), (160, 55, 65, 255))):
            x = (i % 2) * 512 + 150
            y = (i // 2) * 512 + 100
            draw.rectangle((x, y, x + 210, y + 310), fill=color)
            draw.rectangle((x + 165, y + 220, x + 310, y + 245), fill=color)
        sheet_path = root / "sheet.png"
        sheet.save(sheet_path)
        process_character(argparse.Namespace(input=str(sheet_path), out_dir=str(root), prefix="test", force=False))
        expected = {"a": (180, 150), "b": (180, 150), "hold": (180, 150), "sit": (320, 200)}
        for pose, size in expected.items():
            image = Image.open(root / f"test_{pose}.png")
            if image.size != size or image.mode != "RGBA":
                die(f"bad character output {pose}: {image.mode} {image.size}")
            assert_pixel_blocks(image, 5)
            alpha_band = image.getchannel("A")
            alpha_values = alpha_band.get_flattened_data() if hasattr(alpha_band, "get_flattened_data") else alpha_band.getdata()
            if any(alpha not in (0, 255) for alpha in alpha_values):
                die(f"partial alpha in character output {pose}")
        boat_src = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        ImageDraw.Draw(boat_src).polygon(((120, 620), (850, 570), (760, 760), (180, 760)), fill=(60, 110, 145, 255))
        boat_path = root / "boat-src.png"
        boat_src.save(boat_path)
        boat_out = root / "boat.png"
        process_boat(argparse.Namespace(input=str(boat_path), out=str(boat_out), force=False))
        boat = Image.open(boat_out)
        if boat.size != (512, 256) or boat.mode != "RGBA":
            die(f"bad boat output: {boat.mode} {boat.size}")
        assert_pixel_blocks(boat, 4)
    print("Pixel asset pipeline self-test passed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    character = sub.add_parser("character-sheet", help="split and normalize a 2x2 character sheet")
    character.add_argument("--input", required=True)
    character.add_argument("--out-dir", required=True)
    character.add_argument("--prefix", required=True)
    character.add_argument("--force", action="store_true")
    character.set_defaults(func=process_character)
    boat = sub.add_parser("boat", help="normalize one transparent boat sprite")
    boat.add_argument("--input", required=True)
    boat.add_argument("--out", required=True)
    boat.add_argument("--force", action="store_true")
    boat.set_defaults(func=process_boat)
    test = sub.add_parser("self-test", help="run a synthetic end-to-end validation")
    test.set_defaults(func=self_test)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
