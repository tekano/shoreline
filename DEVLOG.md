# Devlog

## 007: Atmosphere, volumetric cumulus, sun on the sea (2026-10-02)

**Sky.** It's an approximate single-scattering atmosphere, not a full simulation:
- sunlight is reddened by the air it crosses (Kasten–Young air mass), then scattered toward the eye by molecules (blue, even) and haze (white, bunched round the sun);
- looking up, you see light that crossed less air, so a sunset stays blue-teal overhead and turns peach and orange toward the sun.

All values are HDR, rolled off by the tone mapper. A CPU twin of the same maths colours the scene's sun and skylight at any sun height, so the ground and grass go golden at sunset too.

**Aerial perspective.** The fog is a node now:
- haze thickens toward sea level (1.2 km scale height);
- each distant pixel takes the sky's colour in its own direction, warm toward a low sun and blue away from it;
- the haze slider has a much longer range.

**Volumetric cumulus.** A 16-step ray-march through a 1.4–2.7 km slab:
- **Shape:** smooth noise gives the large shapes, and Worley (cellular) noise eats the edges into cauliflower billows.
- **Light:** a light sample toward the sun gives self-shadowing; forward scattering gives silver edges toward the sun; a powder term darkens the cores; skylight is cooler at the base.
- **Domes:** tops need ever more coverage, so the clouds are domed rather than flat-lidded.
- **Sampling:** interleaved gradient noise jitters the march without streaks.
- **Cheap twin:** reflections, cloud shadows and skylight use a flat version of the same field, so shadows and reflections match the clouds you see.

**Sun on the sea:**
- **Glitter:** a Beckmann distribution of tiny facets makes a glitter path that widens as wind and open water roughen the surface.
- **Body colour:** lit by the real sun colour, the skylight and cloud shadow.

New sliders: Exposure, Cumulus and Swell; the sun can now drop below the horizon.

**Next:** golden light on the tops of evening cloud (it's a bit muddy at the moment), and the cloud shapes against more references.


## 006: The beach edge, cumulus, and no more flashing (2026-10-02)

- **Flashing waterline fixed:**
  - the renderer uses a reversed 32-bit depth buffer;
  - water depth comes from the real 4 m terrain heights instead of being read back from the depth buffer.

  Where the sea barely covers the sand, the two surfaces fought over the same depth and flickered.
- **Smooth land cover:** each pixel blends the four nearest 4 m land-cover cells and wanders by a metre or two of noise, so roads and marsh edges are smooth instead of stair-stepped.
- **Swash:** each wave that reaches the beach runs up and drains back. The water plane sits a little above the tide, and wherever the swash isn't really there it is fully transparent. The leading edge has a lacy foam line with bubbles left behind it. The thin sheet is glassy and mostly see-through, except where it mirrors the sky.
- **Sand:**
  - freshly uncovered sand just above the water is mirror-wet;
  - reflections now use a proper Fresnel term: sand colour when you look down, sky at glancing angles;
  - sinuous, forking ripple marks in patches, in both relief and colour, fading out before they could shimmer.
- **Beach versus estuary:** OpenStreetMap tags the West Shore beach and the Duddon mud both as tidal flat. An *exposure* field (the share of deep water within ~2.5 km) tells open coast from sheltered estuary: exposed is sand, sheltered is silver mud.
- **Cumulus:** one cloud field 1.6 km up, drifting with the wind. The sky draws it; the ground, grass and sea darken in its shadow; the wet sand and sea reflect it. New **Cumulus** and **Swell** sliders.

**Still to do:** the cumulus are flat 2D shapes and need volume and proper shading against the West Shore photo.


## 005: What the ground actually is (2026-10-02)

LiDAR gives the *shape* of the ground: the gravel road is a flat ribbon, the saltmarsh a flat shelf. It can't say what any of it *is*. OpenStreetMap can.

The public query servers were overloaded all day, so `terrain/landcover.py` reads Geofabrik's Cumbria extract (45 MB, one file) with pyosmium. It projects every polygon and line onto the LiDAR grids and rasterises 4 m and 16 m class maps:
- **Coast:** sand, shingle, dune, saltmarsh, tidal flat.
- **Land:** fields, scrub, heath, woods, water, built-up areas.
- **On top:** roads, gravel tracks, paths and buildings.

It also writes building footprints, about 10,000 fence lines and the 20 Haverigg/Walney wind turbines for cards and props.

The ground shader paints each class with colours **sampled from my pano**, not picked by eye: grey-olive marsh (median `#545b44`), straw-olive marram (`#807a46`), wet silver-grey estuary flats (`#969da4`). Class edges are jittered by a few metres of noise so they don't read as 4 m pixels. Grass now grows by class: marram on the dunes, shorter fresher grass on fields, dark marsh grass on the saltmarsh, and nothing on sand, tracks or roofs.

**Also fixed:**
- **Horizon boxes:** the "things in the distance" were the low cloud layer breaking up where its projection blows up near the horizon. It now fades out before it gets there.
- **Background tabs:** the page wouldn't start in a background tab, because `Image.decode()` waits for visibility. It uses `createImageBitmap` now.


## 004: Wind and marram (2026-10-02)

**One wind for everything.** `gust()` in `walney/look.js` is a field of ~80 m gusts rolling downwind a little slower than the wind, over finer flurries.
- The grass bends with it.
- The dunes beyond the grass take a silver sheen as gusts sweep across them.
- Whitecaps and the wind sound will read the same field, so everything agrees.

**Marram** (`walney/grass.js`): about 270,000 instanced blades around the camera, each a tapered strip bent in the vertex shader.
- **Bending:** each leaf's own arch, the gust field, and a fast per-leaf flutter.
- **Placement:** clumps near the camera, thinning with distance (blades grow so coverage holds). Hero tussocks in the foreground are fountains of ~260 long arching leaves from one root, so they read as individual leaves, not cards.
- **Shading:**
  - lit by the same sun and sky as the terrain, so blades and ground agree;
  - colour runs from dark olive at the root to straw at the tip, with a silver flash where a gust lays the rolled leaves over;
  - sun shines through backlit leaves;
  - normals are bent skyward so thin leaves take the ground's light at distance.

**Bug worth remembering:** in TSL, once `positionNode` is set, `positionLocal` returns the *displaced* position. Shading that wanted the blade's own 0–1 coordinates got world heights instead, and every pixel lit up like a sunlit tip. Read `attribute('position')` for the raw geometry.

**Camera motion:** locked off, a slow eased sway, or a continuous drift. Only the aim changes, so nothing rebuilds mid-shot. It shows that this is real time and 3D.

**Next:** real land cover from OpenStreetMap (saltmarsh, roads and tracks, buildings, fences), then photo cards from the pano for distant structures.


## 003: Matching photos of the place (2026-10-02)

First look pass on the Walney blockout, matched against my own photos: a summer West Shore shot toward Black Combe, and a 360° pano from a dune top at Sandscale Haws. The pano's GPS puts the camera on the LiDAR, and Black Combe and the dune skyline line up to within a few degrees.

- **Sky:** deep zenith blue, a pale cyan horizon, high cirrus combed out along the wind, and a broken low cloud bank on the horizon.
- **Haze:** light and blue. It turns Black Combe slate at 15 km, as in the photos.
- **Ground** (the zones come from the real distance inland of the high-water line):
  - beach: wet brown-pink flats with sky-mirror runnels, then dry sand and shingle;
  - dunes: olive-straw marram, greener slacks, the odd blowout;
  - inland: pasture, then fell, then heather.
- **Sea:**
  - colour: sandy-green over the flats, teal, then deep blue-grey offshore;
  - breakers: lines run in along the distance from the real waterline, recomputed whenever the tide moves. They steepen and break in the shallows, only in stretches, with lumpy foam fronts and patchy trailing foam;
  - open water: wind chop and whitecaps only where there is fetch, so the estuary stays sheltered;
  - shoreline: water thickness is read per pixel from the depth buffer, so the waterline follows the 4 m terrain with a foam fringe.
- **Terrain build:** the sea fill now uses push-pull inpainting. Unsurveyed flats are interpolated smoothly instead of copied blockwise.

**Learned:** a raised three-quarter view (60–100 m up) shows every stage of the water at once: open chop, breaker lines, swash, wet flats, the shingle and dunes. It never needs a close-up hero wave, which matches what makes the Point Lookout scene work.

**Next:** real detail where the camera is close. Cobbles and the boulder armour along the sea defences, marram grass that moves in one shared wind, and photo cards for distant buildings and turbines.


## 002: A real place (2026-10-02)

Leon Lin's (@LexnLin) Point Lookout scene showed what actually sells a coastline. It isn't the water alone:
- a **real location** to match;
- **depth layers**: foreground grass and trees, midground surf and headland, background beach and hills in haze;
- **one wind** moving everything, the trees, grass, water and sound together;
- **sound**.

The high camera also means the water never has to hold up close.

So Shoreline is getting a real place: **north Walney and the Duddon estuary**, looking from the Sandscale Haws dunes over the sands to Black Combe. It's home ground.
- **Character:** marram grass streaming in the wind, low-tide flats with pools that mirror the sky, a big cumulus sky, and hazy fells.
- **Water:** gentle Irish Sea spilling breakers. These suit a shallow-water solver better than curling surf would.
- **Tide:** the tidal range is huge, so the tide becomes the scene's clock.

The terrain is the real thing: Environment Agency LiDAR at 2 m (1 m is available) across 15 × 25 km, Black Combe's 600 m included.
- `terrain/fetch.py` pulls the tiles from the EA survey API.
- `terrain/build.py` stitches them, fills the sea below the survey edge, and writes a light build for the browser and a full float heightfield for Houdini.
- The `walney/` blockout builds a camera-centred terrain mesh (about 1.5 m apart at the camera, about 100 m at Black Combe) and has a top-down map for placing and saving camera views.

**Next:** pick the hero views on the map. Then shade one layer at a time: sky and haze first (they set the mood), then flats and pools, grass and wind, and the water last.


## 001: Starting from the best of what's out there (2026-10-02)

A realtime beach-waves video was trending on X, and plenty of good work was already public. Rather than spend 40 hours getting back to that point, I started from it.

**What was out there**

- **Saltreach** ([iamtechartist/coastal-simulation](https://github.com/iamtechartist/coastal-simulation)): a real shallow-water simulation. Waves bend over the seabed, wrap around rocks and run up the sand, and you can walk around. It looked gamey: the water was too clear and pool-blue, the foam was a flat noise threshold, and 30 cm cells lose the small detail.
- **reality-js** ([aiimpl/reality-js](https://github.com/aiimpl/reality-js)): no simulation at all. Every wave follows a fixed formula in time, and the camera is locked to a recorded handheld path. The look is excellent, though:
  - foam that breaks up into lace as it thins rather than fading out;
  - absorption that kills red first;
  - murky sand-coloured water in the surf zone;
  - green light through the crests;
  - glints from tiny facets.

**What v0.1 does**

reality-js's foam pattern only needs one number per point: how much foam is there. Saltreach's solver produces exactly that number, already carried by the flow. So:

- the simulated foam amount feeds reality-js's `lace()`, drawn at Saltreach's flow-carried coordinates. The pattern breaks up and drains with the water;
- reality-js's absorption, surf-zone colour, crest light and glints replace Saltreach's water colour;
- a look panel exposes everything, with layer-by-layer debug views and JSON presets, including the original Saltreach look for A/B comparison.

**Porting notes**

- **Noise:** reality-js builds its noise in maths per pixel. Here it reads from a tiling noise texture instead, which is much cheaper. Each lookup is rotated by a different angle so the tiling doesn't show.
- **Glints:** reality-js renders at 2× resolution and averages 3 frames per output frame, which softens its glints. This renders once per frame, so the glints run much weaker by default.
- **Distant foam:** threads smaller than a pixel shimmer, so far away the lace hands over to Saltreach's broad foam patches.

**Next**

- Move the solver to the GPU with WebGPU compute, to get finer cells (around 10 cm) and sharper fronts.
- Bring in Houdini-baked wave shapes (3D displacement or vertex-animation textures) for the curl before the break. Shallow-water physics can't overturn a wave.
- Day/night: drive the sky, sun, foam colour and water from one sun direction.
- Lumpier whitewater with real volume, and spray.
