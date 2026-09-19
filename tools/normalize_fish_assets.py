#!/usr/bin/env python3
"""Normalize legacy fish art to the game's 44x26 logical pixel canvas."""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

from process_generated_pixel_art import pixel_asset


ROOT = Path(__file__).resolve().parents[1]
LEGACY_IDS = (
    "bass", "bighead", "blackcarp", "carp", "croaker", "crucian", "culter",
    "grass", "minnow", "riverperch", "sardine", "seabass", "silvercarp",
    "tilapia", "tuna", "white", "yellowcat",
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=ROOT / "frontend" / "assets" / "fish")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "frontend" / "assets" / "fish")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for fish_id in LEGACY_IDS:
        src = args.input_dir / f"{fish_id}.png"
        out = args.out_dir / f"{fish_id}.png"
        if not src.exists():
            raise FileNotFoundError(src)
        if out.exists() and src.resolve() != out.resolve() and not args.force:
            raise FileExistsError(f"{out} already exists (use --force)")
        if src.resolve() == out.resolve() and not args.force:
            raise FileExistsError(f"refusing to overwrite {out} without --force")
        image = Image.open(src).convert("RGBA")
        normalized = pixel_asset(image, (220, 130), 5, 16, 2)
        normalized.save(out)
        print(f"Wrote {out}")


if __name__ == "__main__":
    main()
