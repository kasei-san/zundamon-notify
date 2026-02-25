#!/usr/bin/env python3
"""
ずんだもん色違い画像生成スクリプト

元画像の緑系ピクセル（髪・耳・服）だけ色相を回転させ、
肌色や目の色はそのまま保持する。
"""

import colorsys
import os
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(SCRIPT_DIR, '..', 'assets')
SOURCE_IMAGE = os.path.join(ASSETS_DIR, 'zundamon.png')

# 緑系の色相範囲 (0.0-1.0 スケール, 0°-360°換算で約60°-170°)
GREEN_HUE_MIN = 60 / 360   # ~0.167
GREEN_HUE_MAX = 170 / 360  # ~0.472

# 彩度の閾値（低彩度のグレー系は変換しない）
SATURATION_MIN = 0.10

# 色違いバリエーション（name, 色相シフト量 in degrees）
# 元の緑が約120°なので、目標色相 - 120° でシフト量を計算
VARIANTS = [
    ('blue',      90),  # → 210°
    ('purple',   160),  # → 280°
    ('orange',   270),  # → 30°
    ('pink',     210),  # → 330°
    ('red',      240),  # → 0°
    ('cyan',      60),  # → 180°
    ('yellow',   295),  # → 55°
    ('lavender', 140),  # → 260°
    ('teal',      50),  # → 170°
]


def shift_green_hue(image: Image.Image, hue_shift_deg: float) -> Image.Image:
    """緑系ピクセルだけ色相をシフトする"""
    img = image.convert('RGBA')
    pixels = img.load()
    width, height = img.size
    hue_shift = hue_shift_deg / 360.0

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue

            # RGB(0-255) -> RGB(0-1) -> HLS
            rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
            h, l, s = colorsys.rgb_to_hls(rf, gf, bf)

            # 緑系の色相範囲かつ十分な彩度がある場合のみシフト
            if GREEN_HUE_MIN <= h <= GREEN_HUE_MAX and s >= SATURATION_MIN:
                h = (h + hue_shift) % 1.0
                rf, gf, bf = colorsys.hls_to_rgb(h, l, s)
                pixels[x, y] = (int(rf * 255), int(gf * 255), int(bf * 255), a)

    return img


def main():
    source = Image.open(SOURCE_IMAGE)
    print(f"元画像: {SOURCE_IMAGE} ({source.size[0]}x{source.size[1]})")

    for name, hue_shift in VARIANTS:
        output_path = os.path.join(ASSETS_DIR, f'zundamon-{name}.png')
        result = shift_green_hue(source, hue_shift)
        result.save(output_path)
        print(f"  生成: zundamon-{name}.png (色相シフト: {hue_shift}°)")

    print(f"\n{len(VARIANTS)}種類の色違い画像を生成したのだ！")


if __name__ == '__main__':
    main()
