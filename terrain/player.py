"""The playback edition's data: a small slice of everything around the Sandscale pano spot.

    python terrain/player.py

Reads  walney/data/*        (the full editing data)
Writes walney/play/data/*   (~4 MB instead of ~28 MB)

The tour never leaves the dune top, so: the 4 m detail only within ~2.4 km of it, the wide area
at 32 m instead of 16, buildings, hedges and armour only within ~7 km, a small minimap image.
"""
import json, os, shutil
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), 'walney', 'data')
DST = os.path.join(os.path.dirname(HERE), 'walney', 'play', 'data')
SPOT = (1809.4, -4414.2)      # the pano spot (walney/pano-ref.js)
NEAR_R, KEEP_R = 2400, 7000


def main():
    os.makedirs(DST, exist_ok=True)
    meta = json.load(open(os.path.join(SRC, 'meta.json')))
    n, f = meta['near'], meta['far']
    # ---- near: crop to a square round the spot, on the same 4 m grid ----
    W, H = n['size']
    i0 = int((SPOT[0] - NEAR_R - n['west']) // n['res']); j0 = int((SPOT[1] - NEAR_R - n['north']) // n['res'])
    k = int(2 * NEAR_R / n['res'])
    i0, j0 = max(0, i0), max(0, j0); i1, j1 = min(W, i0 + k), min(H, j0 + k)
    near = np.fromfile(os.path.join(SRC, 'near.u16'), '<u2').reshape(H, W)[j0:j1, i0:i1]
    near.astype('<u2').tofile(os.path.join(DST, 'near.u16'))
    nn = {'res': n['res'], 'size': [i1 - i0, j1 - j0], 'west': n['west'] + i0 * n['res'], 'north': n['north'] + j0 * n['res']}
    for name in ('landcover_near.png', 'armour_near.png', 'surface.png'):
        p = os.path.join(SRC, name)
        if os.path.exists(p):
            Image.open(p).crop((i0, j0, i1, j1)).save(os.path.join(DST, name), optimize=True)
    # ---- far: every second cell (32 m) ----
    FW, FH = f['size']
    far = np.fromfile(os.path.join(SRC, 'far.u16'), '<u2').reshape(FH, FW)
    far2 = far[:FH // 2 * 2, :FW // 2 * 2].reshape(FH // 2, 2, FW // 2, 2).mean(axis=(1, 3)).round().astype('<u2')
    far2.tofile(os.path.join(DST, 'far.u16'))
    ff = {'res': f['res'] * 2, 'size': [FW // 2, FH // 2], 'west': f['west'], 'north': f['north']}
    lc = Image.open(os.path.join(SRC, 'landcover_far.png'))
    lc.crop((0, 0, FW // 2 * 2, FH // 2 * 2)).resize((FW // 2, FH // 2), Image.NEAREST).save(os.path.join(DST, 'landcover_far.png'), optimize=True)
    # ---- small minimap (hidden in playback, but loaded) ----
    mp = meta['map']
    Image.open(os.path.join(SRC, 'map.jpg')).resize((mp['size'][0] // 4, mp['size'][1] // 4), Image.LANCZOS).save(os.path.join(DST, 'map.jpg'), quality=70)
    mm = {**mp, 'res': mp['res'] * 4, 'size': [mp['size'][0] // 4, mp['size'][1] // 4]}
    # ---- features, lights, armour: only what is near enough to see ----
    near_spot = lambda x, z: (x - SPOT[0]) ** 2 + (z - SPOT[1]) ** 2 < KEEP_R ** 2
    feats = json.load(open(os.path.join(SRC, 'features.json')))
    feats['buildings'] = [b for b in feats['buildings'] if near_spot(*b['p'][0])]
    feats['fences'] = [x for x in feats['fences'] if x['type'] == 'hedge' and near_spot(*x['line'][0])]
    json.dump(feats, open(os.path.join(DST, 'features.json'), 'w'), separators=(',', ':'))
    lights = json.load(open(os.path.join(SRC, 'lights.json')))
    lights['street'] = [s for s in lights['street'] if near_spot(s[0], s[1])]
    lights['floods'] = [s for s in lights['floods'] if near_spot(s[0], s[1])]
    json.dump(lights, open(os.path.join(DST, 'lights.json'), 'w'), separators=(',', ':'))
    arm = np.fromfile(os.path.join(SRC, 'armour.bin'), '<f4').reshape(-1, 5)
    arm[np.array([(x - SPOT[0]) ** 2 + (z - SPOT[1]) ** 2 < 3000 ** 2 for x, z in arm[:, :2]], bool)].tofile(os.path.join(DST, 'armour.bin'))
    meta.update(near=nn, far=ff, map=mm)
    json.dump(meta, open(os.path.join(DST, 'meta.json'), 'w'))
    total = sum(os.path.getsize(os.path.join(DST, x)) for x in os.listdir(DST))
    for x in sorted(os.listdir(DST)):
        print(f'{x:22s} {os.path.getsize(os.path.join(DST, x)) / 1e6:6.2f} MB')
    print(f'total {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
