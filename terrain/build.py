"""Stitch the downloaded LiDAR tiles into the Walney scene's terrain.

    python terrain/build.py

Reads  terrain/raw/2m/*.tif  (from fetch.py)
Writes walney/data/        small files for the browser blockout (committed)
       terrain/out/        full-resolution heightfields for Houdini (git-ignored)

Scene frame: metres, x = east, y = up (metres above Ordnance Datum Newlyn),
z = south, origin at ORIGIN below on the British National Grid.
"""
import json, os, glob
import numpy as np
from PIL import Image
from scipy import ndimage
from osgb import wgs84_to_osgb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, 'walney', 'data')
OUT = os.path.join(HERE, 'out')
RES = 2.0
ORIGIN = (317000.0, 470000.0)          # north Walney, by the Street View spot
NEAR = (311000, 323000, 466000, 478000)  # E0, E1, N0, N1 of the 4 m detail zone
NEAR_RES, FAR_RES = 4, 16


def mosaic():
    tiles = sorted(glob.glob(os.path.join(HERE, 'raw', '2m', '*.tif')))
    info = []
    for path in tiles:
        im = Image.open(path)
        sx, sy = im.tag_v2[33550][:2]
        e0, n1 = im.tag_v2[33922][3:5]  # top-left corner
        assert sx == sy == RES
        info.append((path, e0, n1, im.size))
    E0 = min(e for _, e, _, _ in info); N1 = max(n for _, _, n, _ in info)
    E1 = max(e + w * RES for _, e, _, (w, h) in info); N0 = min(n - h * RES for _, _, n, (w, h) in info)
    W, H = int((E1 - E0) / RES), int((N1 - N0) / RES)
    z = np.full((H, W), np.nan, np.float32)
    for path, e0, n1, (w, h) in info:
        a = np.array(Image.open(path), np.float32)
        a[a < -1e30] = np.nan
        r, c = int((N1 - n1) / RES), int((e0 - E0) / RES)
        z[r:r + h, c:c + w] = a
    print(f'mosaic {W}x{H} @ {RES} m, E {E0:.0f}-{E1:.0f}, N {N0:.0f}-{N1:.0f}, missing {np.isnan(z).mean():.1%}')
    return z, E0, N1


def fill_sea(z):
    """LiDAR stops at the low-water edge. Below it, extend the nearest surveyed
    height and slope it down offshore, then soften the join."""
    missing = np.isnan(z)
    if not missing.any():
        return z
    small = z[::4, ::4]
    dist, (ri, ci) = ndimage.distance_transform_edt(np.isnan(small), return_indices=True)
    near = small[ri, ci]
    coastal = near < 4.0
    seabed = near - np.where(coastal, np.minimum(dist * 4 * RES * 0.008, 25.0), 0.0)
    seabed = ndimage.gaussian_filter(seabed, 6)
    full = np.kron(seabed, np.ones((4, 4), np.float32))[:z.shape[0], :z.shape[1]]
    out = np.where(missing, full, z).astype(np.float32)
    # blend a few cells across the seam so the survey edge is not a cliff
    edge = ndimage.distance_transform_edt(missing) if missing.mean() < 0.9 else None
    if edge is not None:
        w = np.clip(edge / 20.0, 0, 1)
        out = np.where(missing, w * full + (1 - w) * ndimage.uniform_filter(np.nan_to_num(out), 9), out)
    return out


def block_mean(a, k):
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))


def save_u16(path, a, lo, hi):
    q = np.clip((a - lo) / (hi - lo), 0, 1) * 65535
    np.round(q).astype('<u2').tofile(path)


def hillshade(a, res, sun=(315, 40)):
    gy, gx = np.gradient(a, res)
    az, alt = np.radians(sun[0]), np.radians(sun[1])
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    return np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)


def main():
    os.makedirs(WEB, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    z, E0, N1 = mosaic()
    z = fill_sea(z)
    lo, hi = float(np.floor(z.min())), float(np.ceil(z.max()))
    print(f'heights {lo:.1f} .. {hi:.1f} m')

    # Houdini: full 2 m float heightfield (row 0 = north edge, column 0 = west edge)
    Image.fromarray(z).save(os.path.join(OUT, 'walney_dtm_2m.tif'), compression='tiff_deflate')

    # Browser: far layer over everything, near layer for the dunes and flats
    far = block_mean(z, int(FAR_RES / RES))
    r0, r1 = int((N1 - NEAR[3]) / RES), int((N1 - NEAR[2]) / RES)
    c0, c1 = int((NEAR[0] - E0) / RES), int((NEAR[1] - E0) / RES)
    near = block_mean(z[r0:r1, c0:c1], int(NEAR_RES / RES))
    save_u16(os.path.join(WEB, 'far.u16'), far, lo, hi)
    save_u16(os.path.join(WEB, 'near.u16'), near, lo, hi)

    # Top-down map for placing the camera: hillshade, sea tinted below mean sea level
    m = block_mean(z, 4)  # 8 m
    shade = hillshade(m, 8.0)
    land = np.stack([0.80 * shade + 0.12, 0.76 * shade + 0.12, 0.66 * shade + 0.12], -1)
    sea = np.stack([0.30 + 0.20 * shade, 0.42 + 0.22 * shade, 0.52 + 0.20 * shade], -1)
    wet = np.clip((m - 0.0) / 1.5, 0, 1)[..., None]
    rgb = (sea * (1 - wet) + land * wet) * 255
    Image.fromarray(rgb.astype(np.uint8)).save(os.path.join(WEB, 'map.jpg'), quality=86)

    def local(e, n):
        return [round(e - ORIGIN[0], 1), round(-(n - ORIGIN[1]), 1)]

    sv = wgs84_to_osgb(54.118929, -3.270733)
    meta = {
        'units': 'metres; x east, y up (m above Ordnance Datum Newlyn), z south',
        'origin_osgb': ORIGIN,
        'heightRange': [lo, hi],
        'far': {'res': FAR_RES, 'size': [far.shape[1], far.shape[0]], 'west': E0 - ORIGIN[0], 'north': -(N1 - ORIGIN[1])},
        'near': {'res': NEAR_RES, 'size': [near.shape[1], near.shape[0]], 'west': NEAR[0] - ORIGIN[0], 'north': -(NEAR[3] - ORIGIN[1])},
        'map': {'res': 8, 'size': [m.shape[1], m.shape[0]], 'west': E0 - ORIGIN[0], 'north': -(N1 - ORIGIN[1])},
        'cameras': {
            'streetview': {'label': 'North Walney (Street View)', 'pos': local(*sv), 'heading': 314.4, 'pitch': 1.0, 'eye': 1.7, 'fov': 60},
            'sandscale': {'label': 'Sandscale Haws dune ridge, toward Black Combe', 'pos': [2235.0, -5459.0], 'heading': 330.5, 'pitch': 0.5, 'eye': 1.7, 'mm': 35},
        },
        'attribution': '© Environment Agency copyright and/or database right 2022. All rights reserved. Contains public sector information licensed under the Open Government Licence v3.0.'
    }
    json.dump(meta, open(os.path.join(WEB, 'meta.json'), 'w'), indent=1)
    print('wrote', ', '.join(sorted(os.listdir(WEB))), '|', ', '.join(sorted(os.listdir(OUT))))


if __name__ == '__main__':
    main()
