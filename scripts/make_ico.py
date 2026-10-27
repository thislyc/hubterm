#!/usr/bin/env python3
"""从 icon-512.png 生成 Windows icon.ico（PIL；多尺寸 PNG 内嵌条目，Vista+ 原生支持）"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'assets', 'icon-512.png')
out = os.path.join(HERE, 'assets', 'icon.ico')

img = Image.open(src).convert('RGBA')
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon.ico done:', out)
