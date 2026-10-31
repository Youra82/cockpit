#!/usr/bin/env python3
"""Erzeugt static/icon-180.png und icon-512.png (dunkler Grund, steigende Linie) ohne Zusatzpakete."""
import os
import struct
import zlib

BG = (13, 16, 21)
LINE = (91, 155, 255)
DOT = (63, 191, 128)
POINTS = [(0.18, 0.70), (0.38, 0.52), (0.55, 0.62), (0.80, 0.30)]


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def make(size, path):
    width = 0.055 * size
    pts = [(x * size, y * size) for x, y in POINTS]
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            d = min(seg_dist(px, py, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
            a = max(0.0, min(1.0, width / 2 - d + 0.5))
            col = [round(BG[i] + (LINE[i] - BG[i]) * a) for i in range(3)]
            ex, ey = pts[-1]
            dd = ((px - ex) ** 2 + (py - ey) ** 2) ** 0.5
            b = max(0.0, min(1.0, 0.075 * size - dd + 0.5))
            col = [round(col[i] + (DOT[i] - col[i]) * b) for i in range(3)]
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
