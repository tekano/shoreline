# Walney blockout

Real terrain for the Shoreline scene: north Walney, the Sandscale Haws dunes, the Duddon estuary and Black Combe. It's built from Environment Agency 1–2 m LiDAR. Use it to choose camera views on real ground before any shading.

Open `walney/` on the dev server (`python tools/serve.py`, then http://localhost:8792/walney/) or on the live site.

- **Placing the camera:** click the map to put the camera down, and drag away from it to aim. The mouse wheel zooms the map and right-drag pans it. Drag the 3D view to look around.
- **Sliders:** eye height, heading, pitch, lens (full-frame mm), tide (m above Ordnance Datum Newlyn), haze, and sun direction.
- **Saving views:** **Save view** keeps a named camera in your browser. **Copy camera JSON** and **Download cameras** export them for Houdini and the engine. Exported cameras include their National Grid easting and northing.

## Data and rebuild

```sh
python terrain/fetch.py --res 2     # 15 tiles, ~270 MB, into terrain/raw/ (git-ignored)
python terrain/build.py             # writes walney/data/ and terrain/out/walney_dtm_2m.tif
```

| File | What |
|---|---|
| `walney/data/far.u16` | 16 m heights over the whole 15 × 25 km area (uint16, scaled by `heightRange`) |
| `walney/data/near.u16` | 4 m heights over the 12 × 12 km dunes and flats |
| `walney/data/map.jpg` | 8 m hillshade for the camera map |
| `walney/data/meta.json` | Grid bounds, height scale, preset cameras, attribution |
| `terrain/out/walney_dtm_2m.tif` | Full 2 m float32 heightfield for Houdini (7500 × 12500). Row 0 is the north edge at N 490000 and column 0 is the west edge at E 310000 |

**Scene frame:** metres; x east, y up (above Ordnance Datum Newlyn), z south; origin at National Grid E 317000, N 470000.

**Sea:** below the low-water edge there is no LiDAR. `build.py` extends the nearest surveyed height and slopes it down offshore. It's a stand-in until real bathymetry replaces it.

## Land cover (OpenStreetMap)

```sh
curl -L -o terrain/raw/cumbria-latest.osm.pbf https://download.geofabrik.de/europe/united-kingdom/england/cumbria-latest.osm.pbf
pip install osmium
python terrain/landcover.py         # walney/data/landcover_near.png, landcover_far.png, features.json
```

Classes (sand, shingle, dune, saltmarsh, tidal flat, fields, woods, roads, tracks, buildings…) paint the ground and decide what grass grows where. `features.json` holds building footprints (with heights and a house / hut / industry kind), fence lines and wind turbines; `structures.js` extrudes the buildings and builds the turbines.

## Attribution

© Environment Agency copyright and/or database right 2022. All rights reserved. Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

Land cover and features: map data © OpenStreetMap contributors, [Open Database Licence](https://opendatacommons.org/licenses/odbl/). `walney/data/landcover_*.png` and `features.json` are derived from it and shared under the same licence.
