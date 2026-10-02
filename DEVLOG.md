# Devlog

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
