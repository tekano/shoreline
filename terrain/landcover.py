"""Rasterise OpenStreetMap land cover onto the LiDAR grids.

    python terrain/landcover.py

Reads  terrain/raw/cumbria-latest.osm.pbf   (Geofabrik extract, git-ignored)
Writes walney/data/landcover_near.png       4 m class map over the detail zone
       walney/data/landcover_far.png        16 m class map over the whole scene
       walney/data/features.json            buildings, wind turbines, fence lines

Map data © OpenStreetMap contributors, Open Database Licence (ODbL) 1.0.
The class rasters are derived from it and are shared under the same licence.
"""
import json, os
import numpy as np
import osmium
from PIL import Image, ImageDraw
from osgb import wgs84_to_osgb

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), 'walney', 'data')
PBF = os.path.join(HERE, 'raw', 'cumbria-latest.osm.pbf')
BBOX = (-3.37, 54.085, -3.16, 54.285)   # lon0, lat0, lon1, lat1 (a little beyond the LiDAR)

# class ids (keep in sync with walney/look.js)
CLASSES = {
    'unknown': 0, 'sand': 1, 'shingle': 2, 'dune': 3, 'saltmarsh': 4, 'mud': 5, 'scrub': 6,
    'heath': 7, 'grass': 8, 'wood': 9, 'water': 10, 'built': 11, 'rock': 12, 'wetland': 13, 'flat': 14,
    'road': 20, 'track': 21, 'path': 22, 'building': 24,
}
PAINT_ORDER = ['grass', 'heath', 'scrub', 'wood', 'dune', 'wetland', 'flat', 'saltmarsh', 'mud', 'sand',
               'shingle', 'rock', 'water', 'built', 'building']
ROAD_WIDTH = {'road': 7.0, 'track': 6.0, 'path': 3.0}   # drawn a little wide so they survive 4 m cells


def area_class(t):
    g = t.get
    if g('building'):
        return 'building'
    if g('wetland') == 'saltmarsh' or (g('natural') == 'wetland' and g('wetland') in (None, 'tidalflat') and g('tidal') == 'yes'):
        return 'saltmarsh'
    if g('natural') == 'wetland' and g('wetland') == 'tidalflat':
        return 'flat'
    if g('natural') == 'wetland':
        return 'wetland'
    if g('natural') in ('beach',):
        return 'shingle' if g('surface') in ('shingle', 'pebbles', 'gravel', 'stone') else 'sand'
    if g('natural') == 'sand':
        return 'sand'
    if g('natural') == 'shingle':
        return 'shingle'
    if g('natural') in ('dune',) or (g('natural') == 'grassland'):
        return 'dune'
    if g('natural') == 'mud':
        return 'mud'
    if g('natural') == 'scrub':
        return 'scrub'
    if g('natural') in ('heath', 'moor', 'fell'):
        return 'heath'
    if g('natural') == 'wood' or g('landuse') == 'forest':
        return 'wood'
    if g('natural') in ('bare_rock', 'scree', 'rock'):
        return 'rock'
    if g('natural') == 'water' or g('landuse') in ('reservoir', 'basin') or g('waterway') == 'riverbank':
        return 'water'
    if g('landuse') in ('residential', 'industrial', 'commercial', 'retail', 'railway', 'garages', 'construction', 'brownfield', 'military', 'port'):
        return 'built'
    if g('landuse') in ('farmland', 'meadow', 'grass', 'farmyard', 'village_green', 'recreation_ground') or g('leisure') in ('golf_course', 'park', 'pitch'):
        return 'grass'
    return None


def line_class(t):
    h = t.get('highway')
    if not h:
        return None
    if h in ('track', 'unclassified') and t.get('surface') not in ('asphalt', 'paved', 'concrete'):
        return 'track'
    if h in ('path', 'footway', 'bridleway', 'cycleway', 'steps'):
        return 'path'
    if h in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'unclassified', 'living_street', 'road'):
        return 'road'
    return None


def inside(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


class Collect(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.areas, self.lines, self.fences, self.turbines = [], [], [], []

    def area(self, a):
        cls = area_class({t.k: t.v for t in a.tags})
        if not cls:
            return
        try:
            for outer in a.outer_rings():
                ring = [(n.lon, n.lat) for n in outer]
                if not any(inside(*p) for p in ring[::max(1, len(ring) // 16)]):
                    continue
                holes = [[(n.lon, n.lat) for n in inner] for inner in a.inner_rings(outer)]
                self.areas.append((cls, ring, holes))
        except osmium.InvalidLocationError:
            pass

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        cls = line_class(tags)
        fence = tags.get('barrier') in ('fence', 'wall', 'hedge')
        if not cls and not fence:
            return
        try:
            pts = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not any(inside(*p) for p in pts):
            return
        if cls:
            self.lines.append((cls, pts))
        if fence:
            self.fences.append((tags.get('barrier'), pts))

    def node(self, n):
        t = n.tags
        if t.get('generator:source') == 'wind' or t.get('power') == 'generator' and t.get('generator:source') == 'wind':
            if inside(n.location.lon, n.location.lat):
                self.turbines.append((n.location.lon, n.location.lat))


def project(pts):
    a = np.asarray(pts, dtype=np.float64)
    e, n = wgs84_to_osgb(a[:, 1], a[:, 0])
    return np.stack([e, n], 1)


def raster(meta_layer, origin, res, data):
    W, H = meta_layer['size']
    west = origin[0] + meta_layer['west']                 # easting of the left edge
    north = origin[1] - meta_layer['north']               # northing of the top edge
    img = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(img)
    to_px = lambda en: [((e - west) / res, (north - n) / res) for e, n in en]
    by_class = {}
    for cls, ring, holes in data.areas:
        by_class.setdefault(cls, []).append((ring, holes))
    for cls in PAINT_ORDER:
        for ring, holes in by_class.get(cls, []):
            outer = to_px(ring)
            if len(outer) < 3:
                continue
            if not holes:
                draw.polygon(outer, fill=CLASSES[cls])
                continue
            mask = Image.new('1', (W, H), 0); md = ImageDraw.Draw(mask)
            md.polygon(outer, fill=1)
            for h in holes:
                if len(h) >= 3:
                    md.polygon(to_px(h), fill=0)
            img.paste(CLASSES[cls], mask=mask)
    for cls in ('path', 'track', 'road'):
        width = max(1, round(ROAD_WIDTH[cls] / res))
        for c, line in data.lines:
            if c == cls and len(line) >= 2:
                draw.line(to_px(line), fill=CLASSES[cls], width=width, joint='curve')
    return img


def main():
    meta = json.load(open(os.path.join(WEB, 'meta.json')))
    h = Collect()
    h.apply_file(PBF, locations=True)
    print(f'{len(h.areas)} areas, {len(h.lines)} roads/tracks/paths, {len(h.fences)} fences, {len(h.turbines)} turbines')
    # project everything once
    h.areas = [(c, project(r), [project(x) for x in holes if len(x) >= 3]) for c, r, holes in h.areas]
    h.lines = [(c, project(p)) for c, p in h.lines]
    origin = meta['origin_osgb']
    for name, layer, res in (('near', meta['near'], meta['near']['res']), ('far', meta['far'], meta['far']['res'])):
        img = raster(layer, origin, res, h)
        img.save(os.path.join(WEB, f'landcover_{name}.png'), optimize=True)
        counts = np.bincount(np.asarray(img).ravel(), minlength=32)
        names = {v: k for k, v in CLASSES.items()}
        print(name, img.size, ', '.join(f'{names.get(i, i)} {c / counts.sum():.1%}' for i, c in enumerate(counts) if c and i))

    def local(en):
        return [[round(e - origin[0], 1), round(-(n - origin[1]), 1)] for e, n in en]
    feats = {
        'buildings': [], 'turbines': local(project(h.turbines)) if h.turbines else [],
        'fences': [{'type': t, 'line': local(project(p))} for t, p in h.fences],
        'attribution': '© OpenStreetMap contributors (ODbL)'
    }
    for c, ring, _ in h.areas:
        if c == 'building':
            mn, mx = ring.min(0), ring.max(0)
            cx, cy = (mn + mx) / 2
            feats['buildings'].append({'pos': local([(cx, cy)])[0], 'size': [round(float(mx[0] - mn[0]), 1), round(float(mx[1] - mn[1]), 1)]})
    json.dump(feats, open(os.path.join(WEB, 'features.json'), 'w'))
    meta['landcover'] = {'classes': CLASSES, 'attribution': feats['attribution']}
    json.dump(meta, open(os.path.join(WEB, 'meta.json'), 'w'), indent=1)
    print(f"features: {len(feats['buildings'])} buildings, {len(feats['fences'])} fences, {len(feats['turbines'])} turbines")


if __name__ == '__main__':
    main()
