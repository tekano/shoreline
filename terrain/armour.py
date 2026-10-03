"""Rock armour along the sea defences, found in the LiDAR.

    python terrain/armour.py

Reads  walney/data/near.u16, meta.json, landcover_near.png
Writes walney/data/armour.bin      float32 x, z, size, yaw, shape per boulder
       walney/data/armour_near.png  distance to the armour (R) and the promenade behind it (G), 4 m

OpenStreetMap does not map the armour here, but the 4 m LiDAR shows it plainly: a steep,
rough band at the top of the beach. Boulders are scattered over every cell of that band
(steep, at upper-beach height, close to the high-water line, not a road or a building) at
about the packing of real armour: 1-3 m stones, several per cell.
"""
import json, os
import numpy as np
from scipy import ndimage
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), 'walney', 'data')
MHW = 4.2   # mean high water, m ODN (Barrow, roughly)


def main():
    meta = json.load(open(os.path.join(WEB, 'meta.json')))
    n = meta['near']
    W, H = n['size']
    lo, hi = meta['heightRange']
    z = lo + np.fromfile(os.path.join(WEB, 'near.u16'), '<u2').reshape(H, W).astype(np.float32) / 65535 * (hi - lo)
    res = n['res']
    gy, gx = np.gradient(z, res)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    rough = np.abs(z - ndimage.gaussian_filter(z, 2))
    lc = np.asarray(Image.open(os.path.join(WEB, 'landcover_near.png')))
    if lc.ndim == 3:
        lc = lc[..., 0]
    cls = meta['landcover']['classes']
    built = np.isin(lc, [cls['road'], cls['building'], cls['built']])
    # close to the high-water line: within 60 m of ground that crosses MHW
    shore = ndimage.binary_dilation((z > MHW - .6) & (z < MHW + .6), iterations=int(60 / res))
    band = (slope > 14) & (z > 1.5) & (z < 9.5) & shore & ~built & (rough > .05)
    band = ndimage.binary_opening(band, iterations=1) | (band & ndimage.binary_dilation(band, iterations=1))
    ys, xs = np.nonzero(band)
    rng = np.random.default_rng(7)
    per = 4                                   # stones per 4 m cell (16 m2): 1-3 m stones, packed
    k = len(xs) * per
    x = n['west'] + (np.repeat(xs, per) + rng.random(k)) * res
    zz = n['north'] + (np.repeat(ys, per) + rng.random(k)) * res
    size = np.clip(rng.lognormal(np.log(1.5), .35, k), .7, 3.2)
    yaw = rng.random(k) * 2 * np.pi
    shape = rng.integers(0, 8, k).astype(np.float32)
    # a texture for the ground shader (4 m, the near grid): R = distance to the armour band (m, to 255),
    # G = the promenade: flat ground just landward of (above) the armour, where the coast path runs
    dist = ndimage.distance_transform_edt(~band) * res
    prom = (~band) & (dist <= 10) & (slope < 12) & (z > MHW + 2) & ~np.isin(lc, [cls['building']])
    prom = ndimage.binary_closing(prom, iterations=2) & (~band)          # a continuous strip, not patches
    tex = np.zeros((H, W, 3), np.uint8)
    tex[..., 0] = np.clip(dist, 0, 255).astype(np.uint8)
    tex[..., 1] = (prom * 255).astype(np.uint8)
    Image.fromarray(tex).save(os.path.join(WEB, 'armour_near.png'), optimize=True)
    print(f'promenade {prom.sum() * res * res / 1e4:.1f} ha')
    out = np.stack([x, zz, size, yaw, shape], 1).astype(np.float32)
    out.tofile(os.path.join(WEB, 'armour.bin'))
    print(f'{band.sum()} armour cells ({band.sum() * res * res / 1e4:.1f} ha), {k} boulders, {out.nbytes / 1e6:.2f} MB')
    # a check image of the band around Earnse Bay
    cx, cz, r = int((61 - n['west']) / res), int((7 - n['north']) / res), 250
    crop = np.stack([band[cz - r:cz + r, cx - r:cx + r] * 255, np.clip(slope[cz - r:cz + r, cx - r:cx + r] * 6, 0, 255), np.clip((z[cz - r:cz + r, cx - r:cx + r] + 2) * 20, 0, 255)], -1).astype(np.uint8)
    Image.fromarray(crop).save(os.path.join(HERE, 'out', 'armour_check.png'))


if __name__ == '__main__':
    main()
