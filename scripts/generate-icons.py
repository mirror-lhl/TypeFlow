#!/usr/bin/env python3
"""
生成应用图标（build/icon.png / icon.icns / icon.ico / icon-store-1024.png）。

为什么要脚本生成而不是直接放一张图：
  - 图标是**二进制资产**，无法通过代码评审看清内容，也没法 diff
  - 三个平台需要三种格式（icns / ico / png）与多档尺寸，
    手工维护极易出现某档尺寸缺失导致打包失败
  - 本项目的图标是简单几何形状，用脚本表达比二进制更可读、可改

设计：斜向靛蓝渐变底 + 波浪横笔的字母 T（TypeFlow 的"流动排版"）
+ 琥珀色句点（落笔/光标焦点）。Mac App Store 的 1024 营销图标
要求无透明通道，因此额外输出满幅的 icon-store-1024.png；
应用本体图标仍按 macOS 习惯裁成圆角方块。
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

BUILD_DIR = Path(__file__).resolve().parent.parent / "build"

GRADIENT_START = (99, 102, 241)
GRADIENT_END = (67, 56, 202)
MARK = (255, 255, 255)
PERIOD = (251, 191, 36)

CANVAS = 1024
# macOS 图标习惯留出圆角，App 变体用圆角掩膜裁出透明外圈
CORNER = 232


def build_art() -> Image.Image:
    """满幅 artwork：渐变底 + 高光 + 波浪 T + 琥珀句点。"""
    pixels = []
    for y in range(CANVAS):
        for x in range(CANVAS):
            t = (x + y) / (2 * CANVAS - 2)
            pixels.append(
                (
                    round(GRADIENT_START[0] + (GRADIENT_END[0] - GRADIENT_START[0]) * t),
                    round(GRADIENT_START[1] + (GRADIENT_END[1] - GRADIENT_START[1]) * t),
                    round(GRADIENT_START[2] + (GRADIENT_END[2] - GRADIENT_START[2]) * t),
                    255,
                )
            )
    image = Image.new("RGBA", (CANVAS, CANVAS))
    image.putdata(pixels)

    # 左上柔光：同心椭圆叠加做出径向高光，避免纯平渐变显得呆板
    glow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    rings = 36
    for index in range(rings, 0, -1):
        radius = index * 14
        alpha = int(26 * (1 - index / rings))
        glow_draw.ellipse(
            (320 - radius, 300 - radius, 320 + radius, 300 + radius),
            fill=(255, 255, 255, alpha),
        )
    image = Image.alpha_composite(image, glow)

    draw = ImageDraw.Draw(image)

    # 波浪横笔：一个完整正弦周期，呼应"Flow"
    left, right = 218, 806
    center_y, amplitude, half_stroke = 326, 40, 52
    top_edge = []
    bottom_edge = []
    steps = 68
    for index in range(steps + 1):
        x = left + (right - left) * index / steps
        y = center_y + amplitude * math.sin((x - left) / (right - left) * 2 * math.pi)
        top_edge.append((x, y - half_stroke))
        bottom_edge.append((x, y + half_stroke))
    draw.polygon(top_edge + bottom_edge[::-1], fill=MARK)
    for cap_x in (left, right):
        draw.ellipse(
            (cap_x - half_stroke, center_y - half_stroke, cap_x + half_stroke, center_y + half_stroke),
            fill=MARK,
        )

    # 竖笔：与波浪中心相接，底部与句点对齐
    draw.rounded_rectangle((460, 318, 564, 775), radius=52, fill=MARK)

    # 琥珀句点：视觉焦点，也暗示"落笔成文"
    draw.ellipse((627, 659, 743, 775), fill=PERIOD)

    return image


def apply_rounded_mask(art: Image.Image) -> Image.Image:
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, CANVAS, CANVAS), radius=CORNER, fill=255)
    masked = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    masked.paste(art, (0, 0), mask)
    return masked


def main() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    art = build_art()
    icon = apply_rounded_mask(art)

    # Mac App Store 营销图标：满幅、无透明通道
    store_path = BUILD_DIR / "icon-store-1024.png"
    art.convert("RGB").save(store_path, format="PNG")
    print(f"✓ {store_path} ({store_path.stat().st_size // 1024} KB)")

    png_path = BUILD_DIR / "icon.png"
    icon.save(png_path, format="PNG")
    print(f"✓ {png_path} ({png_path.stat().st_size // 1024} KB)")

    # Linux 侧 electron-builder 会用 icon.png，无需额外处理

    # Windows：ico 需要多档尺寸，256 是上限
    ico_path = BUILD_DIR / "icon.ico"
    icon.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"✓ {ico_path} ({ico_path.stat().st_size // 1024} KB)")

    # macOS：icns 由 iconset 目录经 iconutil 生成，这里只准备 iconset
    iconset = BUILD_DIR / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for size in (16, 32, 64, 128, 256, 512):
        resized = icon.resize((size, size), Image.LANCZOS)
        resized.save(iconset / f"icon_{size}x{size}.png", format="PNG")
        # @2x 变体是 icns 的必需项，缺失会导致 iconutil 报错
        if size <= 512:
            doubled = icon.resize((size * 2, size * 2), Image.LANCZOS)
            doubled.save(iconset / f"icon_{size}x{size}@2x.png", format="PNG")

    print(f"✓ {iconset}/（{len(list(iconset.glob('*.png')))} 档尺寸）")
    print("  下一步：iconutil -c icns build/icon.iconset -o build/icon.icns")


if __name__ == "__main__":
    main()
