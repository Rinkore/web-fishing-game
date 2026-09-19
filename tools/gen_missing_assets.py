"""Fill missing voyage icons using the existing pixel canvas and palette.

Run from any directory. Existing images are never overwritten.
"""
from pathlib import Path
from gen_fish import Canvas, draw_fish, hex2rgb as rgb, shade

ASSETS = Path(__file__).resolve().parents[1] / 'frontend' / 'assets'


def squid(cv, giant=False):
    c = rgb('#c36576' if giant else '#dcb8a8')
    cv.poly([(18, 11), (30, 4), (37, 10), (30, 17)], shade(c, .8))
    cv.ellipse(27, 11, 10, 5, c)
    cv.line(22, 8, 32, 8, shade(c, 1.2), thick=1)
    cv.ellipse(17, 12, 4, 4, c)
    for i in range(5):
        y = 8 + i * 2
        cv.line(15, 12, 9, y, c, thick=2)
        cv.line(9, y, 3 + i % 2, y + (i - 2), c, thick=1)
    cv.ellipse(16, 11, 2, 2, rgb('#fff0d9'))
    cv.set(15, 11, rgb('#172b3a'))
    if giant:
        cv.line(14, 15, 10, 22, c, thick=2)
        cv.line(10, 22, 2, 22, c, thick=2)
        for x in range(3, 10, 2):
            cv.set(x, 21, rgb('#f3cfb0'))


def octopus(cv):
    c, dark = rgb('#b8738b'), rgb('#794760')
    for i in range(8):
        x = 5 + i * 4
        cv.line(22, 14, x, 22, dark, thick=3)
        cv.line(x, 22, x - 2, 18, c, thick=2)
        cv.set(x, 21, rgb('#edbdc7'))
    cv.ellipse(21, 10, 9, 8, c)
    cv.ellipse(19, 7, 5, 3, shade(c, 1.18))
    for x in (16, 24):
        cv.fill(x, 12, x + 2, 14, rgb('#f7e6d8'))
        cv.set(x, 13, rgb('#233047'))


def halibut(cv):
    dark, c = rgb('#665748'), rgb('#a18c68')
    cv.poly([(5, 12), (21, 2), (34, 12), (21, 23)], dark)
    cv.ellipse(20, 12, 14, 8, c)
    cv.tri(32, 12, 40, 7, 40, 18, dark)
    for x, y in [(12, 9), (18, 6), (22, 15), (26, 9), (17, 17), (29, 13)]:
        cv.fill(x, y, x + 1, y + 1, shade(c, .75))
    for y in (9, 13):
        cv.set(9, y, rgb('#f1d79d'))
        cv.set(8, y, rgb('#1d2632'))
    cv.line(6, 14, 9, 16, dark)


def fish(fid):
    cv = Canvas()
    if fid in ('squid', 'giantquid'):
        squid(cv, fid == 'giantquid')
    elif fid == 'octo':
        octopus(cv)
    elif fid == 'halibut':
        halibut(cv)
    elif fid == 'mullet':
        draw_fish(cv, '#8ca1aa', belly='#d8e2df', len_=27, height=9, lateral='#566d76', rand=101)
    elif fid == 'jackmack':
        draw_fish(cv, '#5b9ba2', belly='#d5e1d2', fin='#c4ae5b', len_=26, height=9, lateral='#cfb65f', rand=102)
        cv.fill(12, 10, 13, 11, rgb('#344e60'))
    elif fid == 'mahimahi':
        draw_fish(cv, '#67b867', belly='#e7d168', fin='#458c9c', len_=28, height=11, spots=9, spot_c='#398caa', rand=103)
        cv.fill(9, 6, 14, 12, rgb('#6eb97c'))
        cv.line(12, 5, 30, 8, rgb('#32838e'), thick=2)
    elif fid == 'amberjack':
        draw_fish(cv, '#7899a1', belly='#dfe3c7', fin='#c8aa4e', len_=28, height=10, lateral='#d2b858', rand=104)
    elif fid == 'coelacanth':
        draw_fish(cv, '#527a99', belly='#9eb3ba', len_=27, height=13, tail='fan', spots=12, spot_c='#9cb7c5', rand=105)
        for x in (19, 27):
            cv.poly([(x, 16), (x+6, 21), (x+2, 23), (x-1, 18)], rgb('#466480'))
        cv.line(38, 13, 42, 13, rgb('#7a9bac'), thick=2)
    elif fid == 'megamouth':
        draw_fish(cv, '#536b83', belly='#bcc9cb', len_=29, height=13, tail='fork', dorsal=False, rand=106)
        cv.tri(20, 8, 23, 2, 27, 10, rgb('#465d79'))
        cv.ellipse(8, 15, 5, 4, rgb('#203145'))
        cv.line(5, 17, 11, 18, rgb('#b3c7cc'), thick=1)
        for x in (17, 19, 21):
            cv.line(x, 10, x-1, 15, rgb('#314c68'))
    elif fid == 'leviathan':
        draw_fish(cv, '#386d83', belly='#8cb9bb', fin='#b69a52', len_=30, height=12, tail='fork', glow='#477bb0', rand=107)
        for x in range(16, 32, 5):
            cv.tri(x, 8, x+2, 2, x+4, 9, rgb('#d9bd71'))
        cv.line(8, 9, 3, 4, rgb('#d9bd71'), thick=2)
        cv.line(9, 8, 7, 2, rgb('#f0d996'), thick=1)
        cv.set(10, 12, rgb('#ffdf78'))
        cv.line(7, 16, 2, 20, rgb('#71ced0'), thick=1)
    return cv


def material(fid):
    cv = Canvas(28, 28)
    if fid == 'chartfrag':
        cv.poly([(5, 4), (13, 5), (16, 3), (23, 6), (22, 13), (24, 17), (20, 24), (12, 22), (5, 24), (3, 16)], rgb('#a87942'))
        cv.poly([(6, 6), (13, 7), (17, 5), (21, 7), (20, 14), (22, 17), (19, 22), (12, 20), (6, 22), (5, 15)], rgb('#dfc58a'))
        cv.line(8, 7, 8, 20, rgb('#b49760'))
        cv.poly([(10, 9), (14, 8), (16, 12), (13, 14), (16, 18)], rgb('#688d83'))
        cv.line(18, 16, 21, 19, rgb('#ae5947'))
        cv.line(21, 16, 18, 19, rgb('#ae5947'))
        for y in (11, 14, 17):
            cv.set(18, y, rgb('#83613e'))
    else:
        cv.poly([(14, 3), (23, 10), (22, 18), (14, 25), (6, 18), (5, 10)], rgb('#334f78'))
        cv.poly([(14, 5), (21, 11), (20, 17), (14, 22), (8, 17), (7, 11)], rgb('#567fad'))
        cv.poly([(14, 6), (18, 10), (14, 18), (9, 11)], rgb('#77c3cb'))
        cv.line(8, 16, 14, 21, rgb('#a3d5d8'))
        cv.line(14, 21, 20, 16, rgb('#859bc4'))
        cv.fill(12, 8, 14, 9, rgb('#d4e8ec'))
    return cv


if __name__ == '__main__':
    for folder, ids, draw in [
        ('fish', 'mullet jackmack squid octo mahimahi amberjack halibut giantquid coelacanth megamouth leviathan'.split(), fish),
        ('item', ['chartfrag', 'deepscale'], material),
    ]:
        for fid in ids:
            target = ASSETS / folder / (fid + '.png')
            if not target.exists():
                draw(fid).render(str(target))
                print(target.relative_to(ASSETS))
