# drone-mesh-tag

Web app for crowdsourcing surface labels (roof/wall/road/…) on drone-photogrammetry 3D meshes of informal settlements. Client: Humanitarian OpenStreetMap. **North star (revised Jul 2026): a PLATEAU-style digital city twin** — this app is the "JOSM/Tasking Manager for 3D data": a classifier turning raw photogrammetry into semantically-labeled city surfaces (taxonomy maps toward CityGML semantics: RoofSurface/WallSurface/GroundSurface/Road/PlantCover/WaterBody). Training AI on the labels is a future use case, not the driver.

## Commands

- `yarn dev` — Vite dev server
- `yarn build` — production build (expect a >500 kB chunk warning; that's three.js, ignore)
- No test framework. Headless checks are node scripts that import `src/*.js` directly and stub `localStorage`/`alert` (see pattern in past session scratchpads: build tiny BufferGeometry fixtures, call SurfaceSelector/LabelManager APIs, assert).

## Architecture (5 source files, no backend)

- `src/main.js` — `MeshExplorer` app class: scene, progressive load, selection/labeling glue + label UI (DOM ids `label-panel`, `labels-card` in index.html), and the explore↔review mode switch (`this.mode`; FirstPersonControls and OrbitControls swap via their `enabled` flags — `syncFromCamera()` keeps re-entry from snapping the view).
- `src/ReviewMode.js` — one-item-at-a-time verification queue (mobile-first): greedy nearest-neighbour ordering (consecutive items share tiles), orbit camera framed per item with a 450 ms tween, verbs Correct / Wrong-class / Flag / Skip (desktop keys: Enter/F/S, Esc exits). LOD strategy: the entire base mesh stays visible (see gotcha below — base geometry is full-res) and only the item's tiles get high-res textures, with the next item's prefetched. Do NOT re-introduce visibility scoping of far tiles — tried it, it looked broken (scattered fragments) and the base layer is cheap anyway. Queue source is LabelManager today; auto-proposals plug into the same UI later.
- `src/SurfaceSelector.js` — flood-fill surface selection. Real edge-adjacency per tile + a global boundary-vertex graph (world positions quantized to 5 mm scene units) that bridges BOTH tile borders AND intra-tile UV-seam vertex splits (ODM texturing splits verts along texture chart borders — without seam stitching a single roof is many islands). Flood constrained by exact class match + 25° cone from the seed normal, capped at 80k faces. **Colour-assisted ridge crossing exists but is OFF by default** (`ENABLE_RIDGE_CROSSING = false`, instance flag `selector.enableRidgeCrossing`): when on, class match relaxes to family (flat+pitched merge), and a face failing every plane cluster's cone joins if its colour is within `COLOR_TOLERANCE` (42 RGB) of the selection's running mean, spawning a new cluster (cap 8). Disabled Jul 2026 because the dual-carriageway road bled across its verges — tarmac vs dusty ground gives colour nothing to refuse. Before re-enabling: compare against *local neighbourhood* colour rather than the selection-wide mean, or restrict crossing to pitched-roof seeds. Colour sampling: low-res tile textures at face-centroid UV via a 96² canvas per tile (GLB-embedded images → no CORS taint).
- `src/Labels.js` — `LABEL_CLASSES` taxonomy (OSM-tag-aligned, single editable list — client buy-in pending), `CONFIDENCE_LEVELS` traffic-light (confirmed/unsure/flagged → ML data tiers), `LabelManager` (suggestion heuristic, painted overlays, localStorage persistence, JSON export). Face indices stored delta-encoded per tile; tiles identified by root-traversal order.
- `src/HighResStreamer.js` — fetches the high-res GLB once, strips all texture refs from the glTF JSON before parse (avoids ~2.5 GB decode spike), then streams per-tile webp textures by camera proximity (max 16 resident, downscaled to 1024²). Review mode overrides via `setFocus(itemTiles, prefetchTiles)` (wanted-set strategy) and `setScope(tileSet)` (render visibility); `applyTileVisibility()` is the single source of truth for low/high pair visibility — prefetched out-of-scope tiles stay decoded but hidden.
- `src/FirstPersonControls.js` — WASD + drag look, touch gestures.
- `src/MeshLoader.js` — GLB/OBJ/PLY/STL loaders (Draco decoder from gstatic CDN).

## Key decisions / gotchas

- **The low-res mesh is the canonical label substrate.** Raycasting/selection/labels target `currentMesh` (low-res) only; high-res streaming swaps textures + visibility, never geometry, so face indices in saved labels stay valid. three's raycaster ignores `visible`, which selection relies on (promoted tiles hide their low-res twin).
- Mesh is hardcoded: coconut-farm GLBs on uploadthing CDN in `main.js` constructor (low-res + high-res URLs). Multi-map is future work. Labels are keyed to the low-res URL in localStorage (`dmt:labels:<url>`).
- Meshes come from ODM-style photogrammetry: janky topology, noisy normals, per-tile 2048² textures, 130 tiles in the high-res GLB.
- **"Low-res" is a misnomer** (verified by GLB inspection Jul 2026): both GLBs carry ~288k vertices in 130 identically-ordered, same-index-co-located tiles. The 10 MB vs 62 MB difference is texture resolution only. Consequences: geometry LOD doesn't exist (texture LOD is the whole game), same-index tile pairing low↔high is sound, and buildings can be crude (a hut roof ≈ 4 triangles) — selection/labeling granularity is texture-rich but geometry-poor.
- Mesh gets normalized to a 50-unit box + rotated (`setupMesh`); label areas are scene-units² until maps carry georeferencing.
- A canvas `click` fires after every look-drag (mouseup precedes click), so selection handlers must gate on pointer travel (done in `setupSurfaceSelection`) — don't "simplify" that away.
- `package.json` has no `"type": "module"` — node prints a harmless reparse warning when running headless test scripts.
- Git: branch `guesswork` = `performance` + a junk commit of linux-arm64 `node_modules` binaries from a cloud agent (`node_modules` is partially tracked — needs a `.gitignore` cleanup someday).
- Repo style: double quotes, semicolons, prettier-ish.

## Roadmap (post-demo Jul 6 2026 — client priorities, in order)

1. **Perf/LOD done right.** Discipline: profile FIRST with a clean GPU (the pre-demo "regression" was likely confounded by Blender + a `?tiles=130` tab holding VRAM). Then: tiered gaze-bubble streaming — native-res tiles within a small radius of the gaze focus (pitch-derived, ~8-12 tiles), 1024 ring beyond, base elsewhere; per-tile target size with upgrade-in-place + texture disposal; hysteresis (~1.35× radius) so ring boundaries don't flap; keep 1-upload/frame drain + priority-ordered decode. Real long-term fix (incl. native quality on mobile, which the client wants): KTX2/Basis transcode in the server-side preprocessing pipeline — GPU-native format, ~6× less VRAM, near-zero upload cost.
2. **Selection refinement tools:** subtract-click (remove flood region from pending), grow/shrink one adjacency ring, undo last click, and click-to-edit existing labels (reopen panel, adjust boundary, reclass).
3. **View switcher:** untagged-only mode (dim labeled faces), per-class isolation, proposals/confirmed filters, tagged-coverage % indicator.
4. **Map subdivision into work zones** (tile clusters, Tasking-Manager-style): assign/lock zones per user, per-zone progress + export. Maps may be subdivided for distribution across multiple users.
5. Later (still valid, demoted): auto-proposal upgrades from the ODM rasters server-side (proposals.json), SAM-assisted selection, multi-map + verdict backend/consensus, per-tile GLB loading, CityGML/3D Tiles export.

Shipped: cross-tile/seam selection, labeling UI + traffic-light confidence + export, review queue (verbs, focus streaming, prefetch), geometric auto-tagger, `?local`/`?debug`/`?tex`/`?tiles` dev modes.
