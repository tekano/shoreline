"""Night lights from OpenStreetMap: street lamps, floodlit sheds and the offshore wind farms.

    python terrain/nightlights.py

Reads  terrain/raw/cumbria-latest.osm.pbf     roads (Geofabrik extract, git-ignored)
       terrain/raw/offshore_turbines.json     wind turbines west of Walney (Overpass, git-ignored):
         node["generator:source"="wind"](53.85,-3.95,54.3,-3.3)
       walney/data/features.json              building footprints (from landcover.py)
Writes walney/data/lights.json

Street lamps go along roads every ~35 m, but only where there are buildings close by:
towns and villages are lit, country lanes are dark. Big industrial sheds (the BAE yard
in Barrow) get floodlights round their walls. The offshore turbines carry their sizes
from the turbine model, read from the rated output.

Map data © OpenStreetMap contributors, Open Database Licence (ODbL) 1.0.
"""
import json, math, os, random
import numpy as np
import osmium
from landcover import PBF, WEB, HERE, inside, project

LIT = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'road'}
SPACING = {'service': 45}
# turbine model by rated output: (hub height m, rotor diameter m)
MODELS = {'3 MW': (75, 90), '3.6 MW': (84, 107), '5 MW': (90, 126), '7 MW': (111, 154), '8.25 MW': (111, 164)}


class Roads(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads, self.lamps = [], []

    def way(self, w):
        h = w.tags.get('highway')
        if h not in LIT or w.tags.get('access') == 'private' and h == 'service':
            return
        try:
            pts = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if any(inside(*p) for p in pts):
            self.roads.append((h, pts))

    def node(self, n):
        if n.tags.get('highway') == 'street_lamp' and inside(n.location.lon, n.location.lat):
            self.lamps.append((n.location.lon, n.location.lat))


def mark_periphery(off):
    """Aviation lights go on the turbines round each farm's edge, no more than ~900 m apart
    (UK CAA CAP 764), not on every machine. Adds a 5th field: 1 if lit."""
    p = np.asarray([[t[0], t[1]] for t in off])
    # farms: turbines linked within 1.5 km
    label = -np.ones(len(p), int)
    for i in range(len(p)):
        if label[i] >= 0:
            continue
        label[i], todo = i, [i]
        while todo:
            j = todo.pop()
            for k in np.nonzero((label < 0) & (np.hypot(*(p - p[j]).T) < 1500))[0]:
                label[k] = i
                todo.append(k)
    lit = np.zeros(len(p), int)
    for f in set(label):
        idx = np.nonzero(label == f)[0]
        q = p[idx]
        if len(q) < 3:
            lit[idx] = 1
            continue
        # convex hull (monotone chain), then turbines within 250 m of it
        o = sorted(range(len(q)), key=lambda i: (q[i][0], q[i][1]))
        cross = lambda a, b, c: (q[b][0]-q[a][0])*(q[c][1]-q[a][1])-(q[b][1]-q[a][1])*(q[c][0]-q[a][0])
        hull = []
        for seq in (o, o[::-1]):
            part = []
            for i in seq:
                while len(part) >= 2 and cross(part[-2], part[-1], i) <= 0:
                    part.pop()
                part.append(i)
            hull += part[:-1]
        edge = []
        for a, b in zip(hull, hull[1:] + hull[:1]):
            A, B = q[a], q[b]
            d = B - A
            L = max(np.hypot(*d), 1)
            t = np.clip(((q - A) @ d) / (L * L), 0, 1)
            dist = np.hypot(*(q - (A + t[:, None] * d)).T)
            edge += [i for i in np.nonzero(dist < 250)[0]]
        chosen = []
        for i in sorted(set(edge), key=lambda i: np.arctan2(*(q[i] - q.mean(0)))):
            if all(np.hypot(*(q[i] - q[j])) > 900 for j in chosen) or i in hull:
                chosen.append(i)
        lit[idx[chosen]] = 1
    return [t + [int(l)] for t, l in zip(off, lit)]


def main():
    meta = json.load(open(os.path.join(WEB, 'meta.json')))
    origin = meta['origin_osgb']
    local = lambda en: np.stack([en[:, 0] - origin[0], -(en[:, 1] - origin[1])], 1)
    feats = json.load(open(os.path.join(WEB, 'features.json')))

    # buildings on a 50 m grid, to ask "is this road in a town?"
    near = set()
    for b in feats['buildings']:
        p = np.asarray(b['p'])
        cx, cz = p.mean(0)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                near.add((int(cx // 50) + dx, int(cz // 50) + dz))

    h = Roads()
    h.apply_file(PBF, locations=True)
    rnd = random.Random(7)
    street = []
    for kind, pts in h.roads:
        xz = local(project(pts))
        step, carry = SPACING.get(kind, 35), 0.0
        for a, b in zip(xz[:-1], xz[1:]):
            seg = float(np.hypot(*(b - a)))
            t = step - carry
            while t <= seg:
                x, z = a + (b - a) * (t / seg)
                if (int(x // 50), int(z // 50)) in near:
                    # most of the town is LED now; older orange sodium survives on some streets
                    street.append([round(float(x), 1), round(float(z), 1), 1 if rnd.random() < .15 else 0])
                t += step
            carry = (carry + seg) % step
    for lon, lat in h.lamps:
        x, z = local(project([(lon, lat)]))[0]
        street.append([round(float(x), 1), round(float(z), 1), 0])

    # floodlights round the big sheds: one every 80 m along the walls, just under the eaves
    floods = []
    for b in feats['buildings']:
        p = np.asarray(b['p'])
        area = abs(np.sum(p[:, 0] * np.roll(p[:, 1], 1) - np.roll(p[:, 0], 1) * p[:, 1])) / 2
        if b['k'] != 'industry' or area < 8000:
            continue
        for a, c in zip(p, np.roll(p, -1, 0)):
            seg = float(np.hypot(*(c - a)))
            for i in range(max(1, int(seg // 80))):
                x, z = a + (c - a) * ((i + .5) / max(1, int(seg // 80)))
                floods.append([round(float(x), 1), round(float(z), 1), round(b['h'] * .85, 1)])

    # offshore turbines (the onshore ones are already in features.json)
    have = np.asarray(feats['turbines_xz'] if 'turbines_xz' in feats else [t['pos'] for t in feats['turbines']])
    off = []
    for e in json.load(open(os.path.join(HERE, 'raw', 'offshore_turbines.json')))['elements']:
        x, z = local(project([(e['lon'], e['lat'])]))[0]
        if len(have) and np.min(np.hypot(have[:, 0] - x, have[:, 1] - z)) < 60:
            continue
        hub, rotor = MODELS.get(e['tags'].get('generator:output:electricity'), (90, 120))
        off.append([round(float(x), 1), round(float(z), 1), hub, rotor])
    off = mark_periphery(off)

    out = {'street': street, 'floods': floods, 'offshore': off,
           'attribution': '© OpenStreetMap contributors (ODbL)'}
    json.dump(out, open(os.path.join(WEB, 'lights.json'), 'w'), separators=(',', ':'))
    print(f'{len(street)} street lamps ({len(h.lamps)} mapped), {len(floods)} floodlights, {len(off)} offshore turbines')


if __name__ == '__main__':
    main()
