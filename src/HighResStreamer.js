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

export class HighResStreamer {
  constructor({ scene, camera, gltfLoader, maxTextureSize, maxHighResTiles }) {
    this.scene = scene;
    this.camera = camera;
    this.gltfLoader = gltfLoader;
    this.maxTextureSize = maxTextureSize;
    this.maxHighResTiles = maxHighResTiles;

    this.tiles = [];
    this.group = null;
    this.active = false;

    this.decoding = 0;
    this.maxConcurrentDecodes = 3;
    this.decodeCount = 0; // diagnostic: total tiles ever decoded
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

    const localCenter = new THREE.Vector3();
    this.tiles = meshes.map((mesh, i) => {
      const matIndex = this.materialIndexOf(mesh, i);
      const img = imageByMaterial[matIndex];
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      mesh.geometry.boundingBox.getCenter(localCenter);
      return {
        mesh,
        low: lowTiles[i] || null,
        center: localCenter.clone().applyMatrix4(mesh.matrixWorld),
        bytes: img ? img.bytes : null,
        mime: img ? img.mime : null,
        state: "low", // low | loading | high
        texture: null,
        wanted: false,
      };
    });

    this.active = true;
    this.update();
    return this.tiles.length;
  }

  // Re-evaluate which tiles deserve a high-res texture (nearest N to the camera).
  update() {
    if (!this.active || !this.tiles.length) return;

    const cam = this.camera.position;
    for (const t of this.tiles) t._distSq = t.center.distanceToSquared(cam);
    const nearSet = new Set(
      this.tiles
        .slice()
        .sort((a, b) => a._distSq - b._distSq)
        .slice(0, this.maxHighResTiles)
    );

    for (const t of this.tiles) {
      const want = nearSet.has(t) && !!t.bytes;
      t.wanted = want;
      if (want && t.state === "low") this.promote(t);
      else if (!want && t.state === "high") this.demote(t);
    }
  }

  promote(t) {
    if (this.decoding >= this.maxConcurrentDecodes) return; // retry next tick
    t.state = "loading";
    this.decoding++;
    this.decodeToCanvas(t.bytes, t.mime)
      .then((canvas) => {
        this.decoding--;
        if (!t.wanted) {
          t.state = "low"; // camera moved away mid-decode
          return;
        }
        const tex = new THREE.Texture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false; // glTF UV convention
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        t.mesh.material.map = tex;
        t.mesh.material.needsUpdate = true;
        t.texture = tex;
        t.mesh.visible = true;
        if (t.low) t.low.visible = false;
        t.state = "high";
      })
      .catch((err) => {
        this.decoding--;
        t.state = "low";
        console.warn("high-res tile decode failed", err);
      });
  }

  demote(t) {
    t.mesh.visible = false;
    if (t.low) t.low.visible = true;
    if (t.texture) {
      const img = t.texture.image;
      t.texture.dispose();
      if (img && typeof img.close === "function") {
        try {
          img.close();
        } catch (e) {
          /* ignore */
        }
      }
      t.texture = null;
    }
    if (t.mesh.material) t.mesh.material.map = null;
    t.state = "low";
  }

  async decodeToCanvas(bytes, mime) {
    const blob = new Blob([bytes], { type: mime || "image/webp" });
    const bitmap = await createImageBitmap(blob);
    this.decodeCount++;
    const longest = Math.max(bitmap.width, bitmap.height);
    const s = longest > this.maxTextureSize ? this.maxTextureSize / longest : 1;
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
