#!/usr/bin/env python3
"""HubTerm 应用图标：矢量绘制的终端提示符（> _），双色 + 柔和辉光。"""
import subprocess, os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 1024

def base_tile(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    grad = Image.new('RGBA', (size, size))
    gd = ImageDraw.Draw(grad)
    c1, c2 = (30, 30, 46), (17, 17, 27)  # #1e1e2e -> #11111b
    for y in range(size):
        t = y / size
        c = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (size, y)], fill=c)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.225), fill=255)
    img.paste(grad, (0, 0), mask)
    stroke = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(stroke).rounded_rectangle(
        [int(size*0.012)]*2 + [size - int(size*0.024)]*2,
        radius=int(size * 0.213), outline=(69, 71, 90, 110), width=max(2, size // 128))
    img.alpha_composite(stroke)
    return img

def draw_glyph(size):
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    s = size
    span = s * 0.44
    cx, cy = s / 2, s / 2
    w = span * 0.105
    x0 = cx - span * 0.34
    x1 = cx + span * 0.06
    ytop, ybot, ymid = cy - span * 0.26, cy + span * 0.26, cy
    d.line([(x0, ytop), (x1, ymid)], fill=(137, 180, 250, 255), width=int(w))
    d.line([(x0, ybot), (x1, ymid)], fill=(137, 180, 250, 255), width=int(w))
    r = w / 2
    for (px, py) in [(x0, ytop), (x1, ymid), (x0, ybot)]:
        d.ellipse([px - r, py - r, px + r, py + r], fill=(137, 180, 250, 255))
    bx0 = cx + span * 0.16
    bx1 = cx + span * 0.40
    by = cy + span * 0.20
    d.rounded_rectangle([bx0, by, bx1, by + w], radius=w/2, fill=(166, 227, 161, 255))
    return layer

def main():
    img = base_tile(SIZE)
    glyph = draw_glyph(SIZE)
    glow = glyph.filter(ImageFilter.GaussianBlur(SIZE * 0.028))
    glow = glow.point(lambda p: int(p * 0.55))
    img.alpha_composite(glow)
    img.alpha_composite(glyph)
    iconset = os.path.join(HERE, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    for s in [16, 32, 64, 128, 256, 512]:
        img.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, f'icon_{s}x{s}.png'))
        img.resize((s * 2, s * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{s}x{s}@2x.png'))
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(HERE, 'icon.icns')], check=True)
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, 'icon-512.png'))
    print('icon.icns + icon-512.png done')

if __name__ == '__main__':
    main()
