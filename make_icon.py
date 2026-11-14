#!/usr/bin/env python3
"""Erzeugt static/icon-180.png und icon-512.png ohne Zusatzpakete.
Motiv "Kurve": dunkelblauer Grund, feine Gitterlinien, steigende gruene Kapitalkurve, weisser Punkt am Ende.
iOS rundet die Ecken selbst ab, deshalb ein volles Quadrat."""
import os
import struct
import zlib

BG = (20, 34, 58)          # #14223A
GRID = (36, 58, 94)
LINE = (63, 191, 128)      # #3FBF80
WHITE = (233, 236, 241)
POINTS = [(0.16, 0.72), (0.31, 0.64), (0.41, 0.68), (0.55, 0.49), (0.65, 0.55), (0.83, 0.28)]
GRID_Y = [0.33, 0.53, 0.73]


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def mix(a, b, t):
    return [round(a[i] + (b[i] - a[i]) * t) for i in range(3)]


def make(size, path):
    width = 0.062 * size
    pts = [(x * size, y * size) for x, y in POINTS]
    ex, ey = pts[-1]
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            col = list(BG)
            for gy in GRID_Y:      # feine Gitterlinien zwischen 12 % und 88 % Breite
                if 0.12 * size < px < 0.88 * size:
                    a = max(0.0, min(1.0, 0.007 * size - abs(py - gy * size) + 0.5))
                    col = mix(col, GRID, a)
            d = min(seg_dist(px, py, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
            col = mix(col, LINE, max(0.0, min(1.0, width / 2 - d + 0.5)))
            dd = ((px - ex) ** 2 + (py - ey) ** 2) ** 0.5
            col = mix(col, WHITE, max(0.0, min(1.0, 0.07 * size - dd + 0.5)))
            col = mix(col, LINE, max(0.0, min(1.0, 0.034 * size - dd + 0.5)))
            row += bytes(col)
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) \
        + chunk(b'IDAT', raw) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
    make(180, os.path.join(out, 'icon-180.png'))
    make(512, os.path.join(out, 'icon-512.png'))
