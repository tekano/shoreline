# Possible usage

Ideas for tools and libraries that could feed Shoreline. None of these are wired in yet; each entry says where it would fit, what it would take, and what it would not help with.

## USD BRep (NVIDIA Omniverse)

**What it is:** [usd-brep](https://github.com/NVIDIA-Omniverse/usd-brep) is a NURBS boundary-representation (BRep) solid-modelling kernel (SMLib) with Python bindings (the `usd_brep` package, over a compiled `_omni_solid` module) and OpenUSD import/export. Solids are exact (analytic and NURBS surfaces, not meshes), and it can do booleans, sweeps, fillets, shells and offsets, then tessellate to a mesh at a chosen tolerance. Overview: [`.agents/docs/OVERVIEW.md`](https://github.com/NVIDIA-Omniverse/usd-brep/blob/main/.agents/docs/OVERVIEW.md). Licence: Apache-2.0.

**Where it would fit:** as an offline step in the Python pipeline (`terrain/`), baking a few hand-modelled solids into meshes, in the same way `terrain/armour.py` and `terrain/nightlights.py` bake data for the browser. It is a CAD kernel, so it suits the man-made objects, not the land, sea or sky.

### Candidate uses

| Idea | Today | With a BRep kernel |
|---|---|---|
| **Hero buildings** (the BAE Devonshire Dock Hall and the big sheds, plus the nearest houses in the Sandscale view) | [`walney/structures.js`](../walney/structures.js) extrudes each OSM footprint and builds a pitched roof by hand (ridge, gables, overhang) | `linear_sweep` the footprint, `cut` or `boolean_difference` with planes for hips and gables, `shell_brep` for wall thickness, then tessellate. Good for a handful of landmarks, not for all 13,000 footprints |
| **Wind turbines** (343 offshore, drawn instanced) | Built in `structures.js` | `rotational_sweep` a tower profile, skin or loft a few blade sections into a NURBS blade, tessellate at two or three LODs and instance them |
| **Sea defences and the coast path** | Rock armour is scattered boulders ([`terrain/armour.py`](../terrain/armour.py)); the grid-block path is painted | A small set of exact concrete armour units and grid blocks (box, chamfer, fillet, boolean), tessellated into variants for the existing instancing |
| **Houdini and Unreal hand-off** | Cameras and the 2 m heightfield go to Houdini ([`walney/README.md`](../walney/README.md)) | Write the baked objects as mesh-only USD (`UsdGeom.Mesh`), so they load in Solaris or an Unreal USD Stage beside the terrain |
| **Photo matching** (speculative) | Photos are aligned by hand; phone compass headings are often wrong ([DEVLOG 016](../DEVLOG.md)) | Exact edges of the modelled landmarks could be projected into a camera and compared with OpenCV edge or contour detection on the photo, as a check on heading and lens. Untried |

### A bake step, as a sketch

usd-brep's own asset pipeline ([`generate_asset.md`](https://github.com/NVIDIA-Omniverse/usd-brep/blob/main/.agents/docs/generate_asset.md)) goes SMLib solid, then `sm.tessellate`, then `PolyBrep.to_mesh_arrays()` (which returns `points`, `normals`, `faces`, `face_normals`), then `UsdGeom.Mesh` prims. A `terrain/brep_assets.py` would follow the same path:

```python
import usd_brep as sm                               # import before opening any stage with pxr

solid = sm.create_box((0, 0, 0), 10, 10, 10)        # stand-in for a swept footprint plus roof cuts
mesh = sm.tessellate(solid,
                     chord_height_tolerance=0.0,
                     curve_angle_tolerance_deg=25.0,
                     surface_angle_tolerance_deg=15.0)   # 15 deg avoids a known fillet bug, see below
arrays = mesh.to_mesh_arrays()                      # points, normals, faces, face_normals
# then write to walney/data/ as a binary mesh for three.js, and/or mesh-only USD for Houdini and Unreal
```

Only the calls shown in the usd-brep docs are used here; check signatures against the repo before relying on this.

### Things to know first

- **Frames and units differ.** Shoreline's scene frame is metres, x east, y up, z south, origin at National Grid E 317000, N 470000. usd-brep's asset pipeline writes a z-up, centimetre-scale stage. Bakes need a fixed conversion, and the same one for every asset.
- **Offline only.** There is no WebAssembly build or browser use in the repo, so the browser would only ever see baked meshes. Shoreline stays a static site.
- **Install.** Its Python docs give `pip install usd-brep`: a wheel for CPython 3.12 on Windows or Linux (x86_64, aarch64) that bundles its own OpenUSD runtime. There is no macOS wheel. On macOS it must be built from source, and the Python extension also needs a local OpenUSD ([README](https://github.com/NVIDIA-Omniverse/usd-brep#macos-local-development)). I have not installed or run it here, so the wheel's availability and the sketch below are unchecked.
- **Known issues** ([`KNOWN_ISSUES.md`](https://github.com/NVIDIA-Omniverse/usd-brep/blob/main/KNOWN_ISSUES.md)): `tessellate()` can wind triangles inside out next to `circular_fillet` edges (a `surface_angle_tolerance_deg` of 15 avoided every case found), and `heal_brep` can report success when a repair failed, so check `is_manifold_solid()` after healing.
- **Scale.** NURBS adds nothing for heightfield terrain, sea, sky or grass, and per-building solids for the whole island would cost more than the current extrusion. Use it for the handful of objects the camera gets close to.
- **Licence.** Apache-2.0 against Shoreline's MIT. As a build-time tool this is fine. If any usd-brep code or build files were ever vendored into this repo, add its notices to `third_party/`.
- **Contributions.** The usd-brep project is not taking contributions, but does accept issues.
