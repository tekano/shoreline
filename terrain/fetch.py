"""Download Environment Agency LiDAR Composite DTM tiles for the Walney scene.

    python terrain/fetch.py [--res 2] [--tiles SD1575,SD1570]

Tiles are 5 km squares on the British National Grid, saved as GeoTIFF under
terrain/raw/ (git-ignored; they are large). Without --tiles, every tile that
touches the scene's area of interest is fetched.

Data: Environment Agency LIDAR Composite DTM 2022, Open Government Licence v3.
Attribution: © Environment Agency copyright and/or database right 2022.
"""
import argparse, io, json, os, sys, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
SEARCH = 'https://environment.data.gov.uk/backend/catalog/api/tiles/collections/survey/search'
# North Walney, the Sandscale dunes, the Duddon estuary and Black Combe (lon, lat)
AOI = {'type': 'Polygon', 'coordinates': [[[-3.36, 54.09], [-3.17, 54.09], [-3.17, 54.28], [-3.36, 54.28], [-3.36, 54.09]]]}


def tiles_for(res):
    req = urllib.request.Request(SEARCH, json.dumps(AOI).encode(), {'Content-Type': 'application/geo+json'})
    results = json.load(urllib.request.urlopen(req, timeout=90))['results']
    return sorted({r['tile']['id'] for r in results
                   if r['product']['id'] == 'lidar_composite_dtm' and r['resolution']['id'] == str(res)})


def fetch(tile, res):
    out = os.path.join(RAW, f'{res}m')
    os.makedirs(out, exist_ok=True)
    if any(n.startswith(tile) for n in os.listdir(out)):
        return f'{tile} already here'
    url = f'https://environment.data.gov.uk/tiles/collections/survey/lidar_composite_dtm/2022/{res}/{tile}'
    data = urllib.request.urlopen(url, timeout=600).read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        tif = next(n for n in z.namelist() if n.lower().endswith('.tif'))
        with open(os.path.join(out, f'{tile}.tif'), 'wb') as f:
            f.write(z.read(tif))
    return f'{tile} {len(data) / 1e6:.0f} MB'


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--res', type=int, default=2, choices=(1, 2))
    ap.add_argument('--tiles', help='comma-separated tile ids, e.g. SD1575,SD1570')
    args = ap.parse_args()
    tiles = args.tiles.split(',') if args.tiles else tiles_for(args.res)
    print(f'{len(tiles)} tiles at {args.res} m: {" ".join(tiles)}', flush=True)
    with ThreadPoolExecutor(4) as pool:
        for line in pool.map(lambda t: fetch(t, args.res), tiles):
            print(line, flush=True)
    sys.exit(0)
