import * as THREE from "three";

// The high-res model is one Draco-compressed mesh with 130 primitives, each
// with its own ~2048x2048 webp texture (EXT_texture_webp). If GLTFLoader parses
// it normally it decodes ALL 130 webps up front - a ~2.5 GB memory spike that
// crashes tablets/phones, independent of how many textures we later upload.
//
// This streamer avoids that entirely:
//   1. Fetch the GLB once (the browser disk-caches it).
//   2. Rewrite the glTF JSON to remove every texture/image reference, so
//      GLTFLoader decodes ZERO images and only inflates the (small) geometry.
//   3. Keep each tile's compressed webp bytes; decode + upload a tile's texture
//      only while the camera is near it, and dispose it (texture + bitmap) when
//      it moves away.
// Net effect: at most `maxHighResTiles` textures are ever decoded or resident.
const WEBP_EXT = "EXT_texture_webp";
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// Tiered gaze-bubble streaming: tiles inside a small radius of the gaze
// point (view ray ∩ ground plane) or the camera get NATIVE resolution, a
// wider ring gets RING resolution, everything else stays on the resident
// base textures. Radii scale with the map's tile pitch; resident tiles use
// enlarged radii (hysteresis) so ring boundaries don't flap while flying.
// Native uploads are therefore few and land exactly where the user looks —
// high quality AND smooth navigation, not one or the other.
// Margins are measured from the gaze point / camera to each tile's SAMPLED
// GEOMETRY (a few dozen face centroids per tile). ODM "tiles" are
// texture-atlas charts whose faces can be scattered across the whole map,
// so both center-distance and bounding-sphere metrics degenerate (every
// bounding sphere covers everything → all scores tie → the same tiles stay
// resident forever). Sampled centroids measure where the tile actually IS.
const SAMPLES_PER_TILE = 24;
const NATIVE_MARGIN_PITCH = 0.9; // native tier within this distance of tile geometry
const RING_MARGIN_PITCH = 2.8; // ring tier margin, in tile pitches
const HYSTERESIS = 1.35; // resident tiles cling to their tier this much longer

export class HighResStreamer {
  constructor({ scene, camera, gltfLoader, nativeSize, ringSize, nativeCap, totalCap }) {
    this.scene = scene;
    this.camera = camera;
    this.gltfLoader = gltfLoader;
    this.nativeSize = nativeSize; // texture size inside the gaze bubble
    this.ringSize = ringSize; // texture size in the surrounding ring
    this.nativeCap = nativeCap; // max tiles at native size
    this.totalCap = totalCap; // max resident high-res tiles overall
    this.tilePitch = 5; // measured in load(); fallback for injected tiles

    // Whether tiles are spatially localized. ODM atlas pages are usually NOT
    // — each "tile" scatters faces across the entire map (measured: every
    // tile bbox spans the whole site), which makes any spatial tile
    // selection meaningless. In that case the only correct strategy is
    // uniform residency at a budgeted size; the gaze bubble applies only to
    // genuinely spatial tilings (e.g. future re-tiled/3D-Tiles pipelines).
    this.spatialTiling = true; // measured in load(); tests may override

    this.tiles = [];
    this.group = null;
    this.active = false;

    this.decoding = 0;
    this.maxConcurrentDecodes = 3;
    this.decodeCount = 0; // diagnostic: total tiles ever decoded

    // Decoded images wait here and upload at most ONE per rendered frame
    // (drainUploads, called from the main loop). Uploading several 2048²
    // textures + mipmap generation in a single frame is what caused visible
    // hitches during the initial sharpen-up.
    this.uploadQueue = [];

    // Review-mode overrides. focusTiles/prefetchTiles (arrays of tile indices)
    // replace camera proximity as the "wanted" strategy: focus = the item
    // under review, prefetch = the next item (decoded early so advancing is
    // instant, but kept hidden by scope). scope (Set of tile indices) limits
    // which tiles render at all — null means everything, explore behavior.
    this.focusTiles = null;
    this.prefetchTiles = null;
    this.scope = null;
  }

  // Fetch + strip + load geometry, overlay it on the low-res base. Resolves once
  // the (untextured) high-res geometry is in the scene; textures stream in after.
  async load(url, lowResObject) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`high-res fetch failed: ${res.status}`);
    const buffer = await res.arrayBuffer();

    const { json, bin } = this.parseGLB(buffer);
    const imageByMaterial = this.extractTileImages(json, bin);
    const strippedGLB = this.rebuildGLB(this.stripTextures(json), bin);

    const gltf = await this.parseGLTF(strippedGLB);
    const obj = gltf.scene;

    // Match the transform the low-res base received so the tiles overlay it.
    const group = new THREE.Group();
    group.rotation.order = "YXZ";
    group.rotation.y = Math.PI;
    group.rotation.x = -Math.PI / 2;
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const scale = 50 / Math.max(size.x, size.y, size.z);
    group.scale.multiplyScalar(scale);
    group.position.sub(center.multiplyScalar(scale));
    group.position.y = 0;

    const meshes = [];
    obj.traverse((c) => {
      if (c.isMesh) meshes.push(c);
    });
    meshes.forEach((m) => {
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = true;
      m.visible = false; // hidden until its texture is decoded
      group.add(m);
    });
    this.scene.add(group);
    group.updateWorldMatrix(true, true);
    this.group = group;

    const lowTiles = [];
    if (lowResObject) {
      lowResObject.traverse((c) => {
        if (c.isMesh) lowTiles.push(c);
      });
    }

    // World-space face centroids sampled evenly across a tile's index — the
    // tile's true spatial footprint, robust to scattered atlas charts.
    const sampleFaceCentroids = (mesh, count) => {
      const pos = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.index;
      const faceCount = index ? index.count / 3 : pos.count / 3;
      const stride = Math.max(1, Math.floor(faceCount / count));
      const pts = [];
      const v = new THREE.Vector3();
      for (let f = 0; f < faceCount && pts.length < count; f += stride) {
        const p = new THREE.Vector3();
        for (let c = 0; c < 3; c++) {
          const vi = index ? index.getX(f * 3 + c) : f * 3 + c;
          p.add(v.fromBufferAttribute(pos, vi));
        }
        pts.push(p.multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld));
      }
      return pts;
    };

    const localCenter = new THREE.Vector3();
    this.tiles = meshes.map((mesh, i) => {
      const matIndex = this.materialIndexOf(mesh, i);
      const img = imageByMaterial[matIndex];
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      mesh.geometry.boundingBox.getCenter(localCenter);
      return {
        index: i,
        mesh,
        low: lowTiles[i] || null,
        center: localCenter.clone().applyMatrix4(mesh.matrixWorld),
        samples: sampleFaceCentroids(mesh, SAMPLES_PER_TILE),
        bytes: img ? img.bytes : null,
        mime: img ? img.mime : null,
        state: "low", // low | loading | high (display state)
        size: 0, // resident texture size (0 = base only)
        targetSize: 0, // what computeTargets wants resident
        decoding: false, // a decode for this tile is in flight
        texture: null,
        wanted: false,
      };
    });

    // Median nearest-neighbour spacing of tile centers — the gaze-bubble
    // radii scale with this, so behavior is consistent across map tilings.
    const sample = Math.min(this.tiles.length, 30);
    const dists = [];
    for (let i = 0; i < sample; i++) {
      let best = Infinity;
      for (const o of this.tiles) {
        if (o !== this.tiles[i]) {
          best = Math.min(best, o.center.distanceToSquared(this.tiles[i].center));
        }
      }
      if (best < Infinity) dists.push(Math.sqrt(best));
    }
    dists.sort((a, b) => a - b);
    if (dists.length) this.tilePitch = dists[Math.floor(dists.length / 2)];

    // Spatial-tiling detection: compare median tile extent to the map extent.
    // Atlas-page "tiles" span the whole map → uniform residency mode.
    const mapBox = new THREE.Box3();
    const tileDiags = [];
    const tb = new THREE.Box3();
    for (const t of this.tiles) {
      tb.setFromObject(t.mesh);
      mapBox.union(tb);
      tileDiags.push(tb.min.distanceTo(tb.max));
    }
    tileDiags.sort((a, b) => a - b);
    const medianDiag = tileDiags[Math.floor(tileDiags.length / 2)] || 0;
    const mapDiag = mapBox.min.distanceTo(mapBox.max) || 1;
    this.spatialTiling = medianDiag < mapDiag * 0.5;
    console.log(
      `[streamer] tile extent ${(medianDiag / mapDiag * 100).toFixed(0)}% of map → ` +
        (this.spatialTiling
          ? "spatial tiling: gaze-bubble streaming"
          : "atlas-page tiling: uniform residency (spatial selection is meaningless for this data)")
    );

    this.active = true;
    this.update();
    return this.tiles.length;
  }

  // Decide every tile's target resolution. Gaze-bubble by default;
  // setFocus() (review mode) pins native quality to an explicit tile list.
  computeTargets() {
    if (this.focusTiles) {
      for (const t of this.tiles) t.targetSize = 0;
      let budget = this.totalCap;
      const take = (indices) => {
        if (!indices) return;
        for (const i of indices) {
          if (budget <= 0) return;
          const t = this.tiles[i];
          if (t && t.bytes && t.targetSize === 0) {
            t.targetSize = this.nativeSize; // the item under review deserves max
            budget--;
          }
        }
      };
      take(this.focusTiles); // current item first — prefetch fills leftover budget
      take(this.prefetchTiles);
      return;
    }

    // Atlas-page tilings: every tile contributes faces to every view, so the
    // only strategy that visibly sharpens anything is all tiles resident at
    // the budgeted ring size. (Native upgrades still happen via review-mode
    // focus above, where we know exactly which pages an item's faces use.)
    if (!this.spatialTiling) {
      for (const t of this.tiles) {
        t.targetSize = t.bytes ? Math.max(t.size, this.ringSize) : 0;
      }
      return;
    }

    // Gaze focus = view ray ∩ ground plane (clamped). Pure camera distance
    // fails oblique aerial views: the nearest tiles sit below/behind the
    // camera off-screen while everything actually in frame stays base-res.
    const cam = this.camera.position;
    this._dir = this._dir || new THREE.Vector3();
    this._focus = this._focus || new THREE.Vector3();
    this.camera.getWorldDirection(this._dir);
    const LOOKAHEAD_MAX = 160; // scene units — near-horizon gazes don't chase infinity
    let ahead = this._dir.y < -0.02 ? cam.y / -this._dir.y : LOOKAHEAD_MAX;
    ahead = Math.min(Math.max(ahead, 0), LOOKAHEAD_MAX);
    this._focus.copy(this._dir).multiplyScalar(ahead).add(cam);

    for (const tile of this.tiles) {
      const pts = tile.samples && tile.samples.length ? tile.samples : [tile.center];
      let best = Infinity;
      for (const p of pts) {
        const d = Math.min(p.distanceTo(cam), p.distanceTo(this._focus));
        if (d < best) best = d;
      }
      tile._score = best; // distance to the tile's nearest sampled geometry
    }

    const r1 = this.tilePitch * NATIVE_MARGIN_PITCH;
    const r2 = this.tilePitch * RING_MARGIN_PITCH;
    const sorted = this.tiles.slice().sort((a, b) => a._score - b._score);
    let nativeLeft = this.nativeCap;
    let totalLeft = this.totalCap;

    for (const t of sorted) {
      t.targetSize = 0;
      if (!t.bytes || totalLeft <= 0) continue;
      const m = t.size > 0 ? HYSTERESIS : 1; // resident tiles cling to their tier
      if (nativeLeft > 0 && t._score <= r1 * m) {
        t.targetSize = this.nativeSize;
        nativeLeft--;
        totalLeft--;
      } else if (t._score <= r2 * m) {
        t.targetSize = this.ringSize;
        totalLeft--;
      }
    }
  }

  update() {
    if (!this.active || !this.tiles.length) return;
    this.computeTargets();

    // Upgrades wanted, most-visible first — the 3-wide decode queue fills
    // with what the user is looking at. Resident tiles above their target
    // (native drifting into the ring) are left alone: no downgrade churn;
    // they demote fully when they leave the ring.
    const wantUp = this.tiles.filter(
      (t) => t.bytes && !t.decoding && t.targetSize > t.size
    );
    wantUp.sort((a, b) => (a._score || 0) - (b._score || 0));
    for (const t of wantUp) this.promote(t);

    for (const t of this.tiles) {
      t.wanted = t.targetSize > 0;
      if (t.targetSize === 0 && t.state === "high") this.demote(t);
    }
    this.applyVisibility();
  }

  // Wanted-strategy override. Pass null to return to camera proximity.
  setFocus(focusIndices, prefetchIndices = null) {
    this.focusTiles = focusIndices ? Array.from(focusIndices) : null;
    this.prefetchTiles = prefetchIndices ? Array.from(prefetchIndices) : null;
    this.update();
  }

  // Rendering scope. Pass a Set of tile indices to show only those tiles
  // (low- or high-res, whichever is resident); null shows everything.
  setScope(scopeIndices) {
    this.scope = scopeIndices ? new Set(scopeIndices) : null;
    this.applyVisibility();
  }

  applyVisibility() {
    for (const t of this.tiles) this.applyTileVisibility(t);
  }

  // Single source of truth for the low/high pair: high-res mesh shows only
  // when resident AND in scope; the low-res twin covers every other case
  // (including prefetched-but-out-of-scope tiles, which stay decoded but
  // hidden until the queue advances into them).
  applyTileVisibility(t) {
    const inScope = !this.scope || this.scope.has(t.index);
    const showHigh = inScope && t.state === "high";
    t.mesh.visible = showHigh;
    if (t.low) t.low.visible = inScope && !showHigh;
  }

  promote(t) {
    if (this.decoding >= this.maxConcurrentDecodes) return; // retry next tick
    const size = t.targetSize;
    t.decoding = true;
    // Base→resident shows "loading" (low tile stays visible); an in-place
    // UPGRADE keeps state "high" so the current texture never flickers out.
    if (t.state === "low") t.state = "loading";
    this.decoding++;
    this.decodeToImage(t.bytes, t.mime, size)
      .then((image) => {
        this.decoding--;
        this.uploadQueue.push({ t, image, size });
      })
      .catch((err) => {
        this.decoding--;
        t.decoding = false;
        if (t.state === "loading") t.state = "low";
        console.warn("high-res tile decode failed", err);
      });
  }

  // Called once per rendered frame from the main loop: upload at most one
  // decoded texture per frame so sharpening never stalls the camera.
  drainUploads() {
    while (this.uploadQueue.length) {
      const { t, image, size } = this.uploadQueue.shift();
      t.decoding = false;
      if (t.targetSize === 0) {
        // demoted while decoding/queued
        if (t.state === "loading") t.state = "low";
        this.closeImage(image);
        continue; // didn't upload anything — keep looking
      }
      if (t.texture) {
        // in-place upgrade: free the old texture + its backing image
        const old = t.texture.image;
        t.texture.dispose();
        this.closeImage(old);
      }
      const tex = new THREE.Texture(image);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false; // glTF UV convention
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      t.mesh.material.map = tex;
      t.mesh.material.needsUpdate = true;
      t.texture = tex;
      t.size = size;
      t.state = "high";
      this.applyTileVisibility(t);
      return; // one real upload per frame
    }
  }

  closeImage(image) {
    if (image && typeof image.close === "function") {
      try {
        image.close();
      } catch (e) {
        /* ignore */
      }
    }
  }

  demote(t) {
    if (t.texture) {
      const img = t.texture.image;
      t.texture.dispose();
      this.closeImage(img);
      t.texture = null;
    }
    if (t.mesh.material) t.mesh.material.map = null;
    t.state = "low";
    t.size = 0;
    this.applyTileVisibility(t);
  }

  async decodeToImage(bytes, mime, maxSize) {
    const blob = new Blob([bytes], { type: mime || "image/webp" });
    const bitmap = await createImageBitmap(blob);
    this.decodeCount++;
    const longest = Math.max(bitmap.width, bitmap.height);
    const s = longest > maxSize ? maxSize / longest : 1;
    if (s === 1) return bitmap; // native size — upload the bitmap directly
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * s));
    canvas.height = Math.max(1, Math.round(bitmap.height * s));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas;
  }

  materialIndexOf(mesh, fallback) {
    const name = (mesh.material && mesh.material.name) || "";
    const m = /__tile_(\d+)/.exec(name);
    return m ? parseInt(m[1], 10) : fallback;
  }

  // --- GLB surgery ---------------------------------------------------------

  parseGLB(buffer) {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB");
    let off = 12;
    let json = null;
    let bin = null;
    while (off < dv.byteLength) {
      const len = dv.getUint32(off, true);
      const type = dv.getUint32(off + 4, true);
      const start = off + 8;
      if (type === CHUNK_JSON) {
        json = JSON.parse(
          new TextDecoder().decode(new Uint8Array(buffer, start, len))
        );
      } else if (type === CHUNK_BIN) {
        bin = new Uint8Array(buffer, start, len);
      }
      off = start + len; // GLB chunk lengths are already 4-byte aligned
    }
    if (!json || !bin) throw new Error("GLB missing JSON or BIN chunk");
    return { json, bin };
  }

  // material index -> { bytes, mime } for its base-colour webp.
  extractTileImages(json, bin) {
    const byMaterial = {};
    (json.materials || []).forEach((mat, i) => {
      const bct = mat.pbrMetallicRoughness?.baseColorTexture;
      if (!bct) return;
      const tex = json.textures?.[bct.index];
      if (!tex) return;
      let source = tex.source;
      if (tex.extensions?.[WEBP_EXT]) source = tex.extensions[WEBP_EXT].source;
      if (source == null) return;
      const image = json.images?.[source];
      if (!image || image.bufferView == null) return;
      const bv = json.bufferViews[image.bufferView];
      const start = bv.byteOffset || 0;
      byMaterial[i] = {
        bytes: bin.subarray(start, start + bv.byteLength),
        mime: image.mimeType || "image/webp",
      };
    });
    return byMaterial;
  }

  // Remove every image/texture reference so GLTFLoader decodes no images. Tag
  // each material with its index so tiles can be matched back to their webp.
  stripTextures(json) {
    const j = JSON.parse(JSON.stringify(json)); // structure only; bin is separate
    (j.materials || []).forEach((mat, i) => {
      mat.name = `__tile_${i}`;
      if (mat.pbrMetallicRoughness) {
        delete mat.pbrMetallicRoughness.baseColorTexture;
        delete mat.pbrMetallicRoughness.metallicRoughnessTexture;
      }
      delete mat.normalTexture;
      delete mat.occlusionTexture;
      delete mat.emissiveTexture;
    });
    delete j.images;
    delete j.textures;
    delete j.samplers;
    const dropWebp = (arr) =>
      Array.isArray(arr) ? arr.filter((e) => e !== WEBP_EXT) : arr;
    j.extensionsUsed = dropWebp(j.extensionsUsed);
    j.extensionsRequired = dropWebp(j.extensionsRequired);
    return j;
  }

  rebuildGLB(json, bin) {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const binPad = (4 - (bin.length % 4)) % 4;
    const total =
      12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;

    const out = new ArrayBuffer(total);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);
    dv.setUint32(0, GLB_MAGIC, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);

    let p = 12;
    dv.setUint32(p, jsonBytes.length + jsonPad, true);
    dv.setUint32(p + 4, CHUNK_JSON, true);
    p += 8;
    u8.set(jsonBytes, p);
    p += jsonBytes.length;
    for (let i = 0; i < jsonPad; i++) u8[p++] = 0x20; // pad JSON with spaces

    dv.setUint32(p, bin.length + binPad, true);
    dv.setUint32(p + 4, CHUNK_BIN, true);
    p += 8;
    u8.set(bin, p);
    p += bin.length;
    for (let i = 0; i < binPad; i++) u8[p++] = 0x00;

    return out;
  }

  parseGLTF(glb) {
    return new Promise((resolve, reject) => {
      this.gltfLoader.parse(glb, "", resolve, reject);
    });
  }
}
