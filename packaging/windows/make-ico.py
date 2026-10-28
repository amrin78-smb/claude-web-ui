# Regenerate claude-web-ui.ico:  python3 make-ico.py claude-web-ui.ico preview.png
import sys
from PIL import Image, ImageDraw
# Hand-rendered copy of web/public/favicon.svg (32x32 viewBox): PIL can't read SVG.
def render(px):
    ss = 4; S = px * ss; k = S / 32
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=7 * k, fill='#1a1816')
    w = 2.6 * k; c = '#d97757'
    def stroke(pts):
        P = [(x * k, y * k) for x, y in pts]
        d.line(P, fill=c, width=round(w), joint='curve')
        for x, y in P: d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=c)
    stroke([(9, 11.5), (15.5, 16), (9, 20.5)])
    stroke([(17.5, 20.5), (23.5, 20.5)])
    return im.resize((px, px), Image.LANCZOS)
big = render(256)
big.save(sys.argv[1], sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
big.save(sys.argv[2])
