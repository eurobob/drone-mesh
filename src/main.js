import * as THREE from "three";
import { FirstPersonControls } from "./FirstPersonControls.js";
import { MeshLoader } from "./MeshLoader.js";
import { HighResStreamer } from "./HighResStreamer.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SurfaceSelector } from "./SurfaceSelector.js";
import { LabelManager, LABEL_CLASSES, CONFIDENCE_LEVELS } from "./Labels.js";
import { ReviewMode } from "./ReviewMode.js";
import { autoTag } from "./AutoTagger.js";

// Configuration toggle
const ENABLE_SURFACE_SELECTION = true; // Set to true to enable surface selection

// The high-res model is 130 tiles, each with its own ~2048x2048 texture. Decoded
// to GPU memory that is ~2.5 GB of VRAM all at once - far beyond what any tablet
// or most laptops can hold, so uploading them all loses the WebGL context (black
// tiles / blank screen / reload loop).
//
// Instead of a wholesale swap we stream textures by proximity (LOD): the low-res
// preview stays as the always-resident base, and only the nearest tiles are
// promoted to a high-res texture, capped so resident high-res VRAM stays bounded.
// Promoted tiles are downscaled to MAX_TEXTURE_SIZE; far tiles have their high-res
// texture disposed (VRAM freed, source image kept for cheap re-upload).
// Tiered gaze-bubble profiles (see HighResStreamer): a few NATIVE-res tiles
// where the user looks, a 1024 ring around them, base elsewhere. Native
// uploads are rare + throttled to one per frame, so quality no longer trades
// against smooth navigation. Touch keeps everything at 1024 (memory), which
// collapses the tiers into a single gaze-targeted bubble.
// NOTE (Jul 2026, measured): this map's "tiles" are ODM atlas pages that each
// span the ENTIRE site — no spatial tiling exists, so the streamer detects
// that and switches to uniform residency: ALL pages resident at ringSize
// (native reserved for review-mode focus). ringSize is therefore the whole
// VRAM story on such maps: 130 × 1024² ≈ 730 MB desktop, 130 × 512² ≈ 180 MB
// touch. The gaze bubble engages only on genuinely spatial tilings.
const TOUCH_PROFILE = { nativeSize: 1024, ringSize: 512, nativeCap: 16, totalCap: 16 };
const DESKTOP_PROFILE = { nativeSize: 2048, ringSize: 1024, nativeCap: 10, totalCap: 32 };
const LOD_UPDATE_INTERVAL = 12; // frames between LOD re-evaluations

// Bump on every meaningful change. Shown in the info panel and logged at startup
// so it's possible to confirm the live preview is actually running current code
// (vs a stale cached bundle).
const BUILD_VERSION = "full-1";

class MeshExplorer {
  constructor() {
    console.log(`[drone-mesh] build ${BUILD_VERSION}`);
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.meshLoader = null;
    this.currentMesh = null;
    this.lowResMesh = null;
    this.isLoadingHighRes = false;
    this.currentFiles = null;

    // High-res texture streaming (see HighResStreamer).
    this.streamer = null;
    this.frameCount = 0;

    // Surface selection & labeling. `pending` is the not-yet-saved selection
    // (possibly merged from several shift-clicks); saved labels live in
    // LabelManager. Both are created once the mesh is ready.
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.selector = null;
    this.labels = null;
    this.pending = null;
    this.addMode = false;

    // "explore" = free-roam + click-to-label; "review" = one queue item at a
    // time under an orbit camera with scoped tile rendering.
    this.mode = "explore";
    this.orbit = null;
    this.review = null;

    this.init();
    this.setupEventListeners();
    this.animate();

    // Auto-load the coconut farm mesh. `?local` swaps the CDN for the copies
    // in resources/models (gitignored; dev-server only) — disk-speed loads
    // and offline testing. `?debug` overlays live LOD streaming stats.
    const params = new URLSearchParams(location.search);
    this.debugLOD = params.has("debug");

    // Device-tiered streaming quality (?tex= and ?tiles= override for tuning).
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    const base = isTouch ? TOUCH_PROFILE : DESKTOP_PROFILE;
    // Uniform (atlas) maps hold ALL pages at ringSize, so ringSize IS the
    // close-up quality. Desktop = native 2048 unconditionally (~2.9 GB
    // textures, Blender parity; measured source: 107×2048 + 23×1024).
    // Weaker machines can pass ?ring=1024 — no silent downgrades.
    this.streamProfile = {
      ...base,
      nativeSize: parseInt(params.get("tex"), 10) || base.nativeSize,
      ringSize:
        parseInt(params.get("ring"), 10) || (isTouch ? base.ringSize : 2048),
      totalCap: parseInt(params.get("tiles"), 10) || base.totalCap,
    };
    console.log(
      `[drone-mesh] stream profile: ${this.streamProfile.nativeCap} native @ ${this.streamProfile.nativeSize}px + ring @ ${this.streamProfile.ringSize}px, total ${this.streamProfile.totalCap} (${isTouch ? "touch" : "desktop"})`
    );
    const lowUrl = params.has("local")
      ? "/resources/models/coconut-low.glb"
      : "https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNx0lqYJJ2zb6Xow4apUyGg09cPEkSDjMLBJKHq";
    const highUrl = params.has("local")
      ? "/resources/models/coconut-high.glb"
      : "https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNxioLwD1Ldeg4T8dxVEobRa6BzCGisrcLNPtOl";

    // NOTE: flag is "full", not "raw" — ?raw is a reserved Vite dev-server
    // query (raw file transform) and 403s the page.
    if (params.has("full")) {
      // GROUND-TRUTH MODE: no streamer, no texture stripping, no decode
      // pipeline. GLTFLoader ingests the full high-res GLB with textures —
      // the identical path Blender uses. This is, by definition, the maximum
      // quality this file contains. Desktop-class memory required (~2.9 GB).
      this.loadRawHighRes(highUrl);
    } else {
      this.loadProgressiveMesh(lowUrl, highUrl);
    }
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 10, 1000);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      2000
    );
    this.camera.position.set(0, 5, 10);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Cap pixel ratio so high-DPI mobile screens don't allocate huge
    // framebuffers (a common cause of WebGL context loss on phones).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const container = document.getElementById("canvas-container");
    container.appendChild(this.renderer.domElement);

    // Handle WebGL context loss gracefully instead of leaving a blank screen.
    this.contextLost = false;
    const canvas = this.renderer.domElement;
    canvas.addEventListener(
      "webglcontextlost",
      (event) => {
        // preventDefault lets the browser attempt to restore the context.
        event.preventDefault();
        this.contextLost = true;
        console.error("WebGL context lost");
      },
      false
    );
    canvas.addEventListener(
      "webglcontextrestored",
      () => {
        this.contextLost = false;
        console.warn("WebGL context restored");
      },
      false
    );

    this.controls = new FirstPersonControls(
      this.camera,
      this.renderer.domElement
    );

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(50, 100, 50);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.left = -100;
    directionalLight.shadow.camera.right = 100;
    directionalLight.shadow.camera.top = 100;
    directionalLight.shadow.camera.bottom = -100;
    directionalLight.shadow.camera.near = 0.1;
    directionalLight.shadow.camera.far = 200;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    this.scene.add(directionalLight);

    const gridHelper = new THREE.GridHelper(200, 50, 0x444444, 0x888888);
    this.scene.add(gridHelper);

    // Create thick custom axes with cylinders
    const axesGroup = new THREE.Group();

    // X-axis (red)
    const xGeometry = new THREE.CylinderGeometry(0.1, 0.1, 5, 8);
    const xMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const xAxis = new THREE.Mesh(xGeometry, xMaterial);
    xAxis.rotation.z = -Math.PI / 2;
    xAxis.position.x = 2.5;
    axesGroup.add(xAxis);

    // Y-axis (green)
    const yGeometry = new THREE.CylinderGeometry(0.1, 0.1, 5, 8);
    const yMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    const yAxis = new THREE.Mesh(yGeometry, yMaterial);
    yAxis.position.y = 2.5;
    axesGroup.add(yAxis);

    // Z-axis (blue)
    const zGeometry = new THREE.CylinderGeometry(0.1, 0.1, 5, 8);
    const zMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
    const zAxis = new THREE.Mesh(zGeometry, zMaterial);
    zAxis.rotation.x = Math.PI / 2;
    zAxis.position.z = 2.5;
    axesGroup.add(zAxis);

    // this.scene.add(axesGroup); // Hidden for now

    this.meshLoader = new MeshLoader(this.scene);
  }

  setupEventListeners() {
    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.updateControlsInfo();
    this.setupSurfaceSelection();
  }

  setupSurfaceSelection() {
    // Skip if surface selection is disabled
    if (!ENABLE_SURFACE_SELECTION) return;

    const canvas = this.renderer.domElement;

    // A look-drag still fires a "click" on mouseup (and isMouseDown is already
    // false by then), which used to select a surface after every camera
    // rotate. Track pointer travel and ignore clicks that moved.
    let downPos = null;
    canvas.addEventListener("mousedown", (event) => {
      downPos = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener("click", (event) => {
      if (downPos) {
        const dx = event.clientX - downPos.x;
        const dy = event.clientY - downPos.y;
        if (dx * dx + dy * dy > 25) return; // moved >5px: that was a look, not a click
      }
      this.handleSurfaceSelection(
        event.clientX,
        event.clientY,
        event.shiftKey || this.addMode
      );
    });

    // Handle touch taps for mobile
    let tapTimeout = null;
    canvas.addEventListener("touchend", (event) => {
      if (event.touches.length === 0 && event.changedTouches.length === 1) {
        const touch = event.changedTouches[0];
        // Use timeout to distinguish tap from drag
        if (tapTimeout) clearTimeout(tapTimeout);
        tapTimeout = setTimeout(() => {
          this.handleSurfaceSelection(touch.clientX, touch.clientY, this.addMode);
        }, 100);
      }
    });

    canvas.addEventListener("touchmove", () => {
      if (tapTimeout) {
        clearTimeout(tapTimeout);
        tapTimeout = null;
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.mode === "review" && this.review) this.review.exit();
        else this.cancelPendingSelection();
        return;
      }
      // Desktop review shortcuts (FirstPersonControls is disabled in review,
      // so no WASD conflicts).
      if (this.mode === "review" && this.review && this.review.active) {
        if (event.key === "Enter") this.review.correct();
        else if (event.key === "s" || event.key === "S") this.review.skip();
        else if (event.key === "f" || event.key === "F") this.review.flag();
      }
    });

    this.initLabelUI();
  }

  handleSurfaceSelection(clientX, clientY, additive = false) {
    if (this.mode !== "explore") return;
    if (!this.currentMesh || !this.selector) return;

    // Convert screen coordinates to normalized device coordinates
    this.mouse.x = (clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Raycast the low-res mesh only. It is the canonical label substrate:
    // its geometry never changes while high-res textures stream in and out,
    // so face indices stay valid. (three's raycaster ignores `visible`, which
    // is exactly what we want for tiles whose low-res twin is hidden.)
    const intersects = this.raycaster.intersectObject(this.currentMesh, true);
    if (!intersects.length) {
      if (!additive) this.cancelPendingSelection();
      return;
    }

    const result = this.selector.select(intersects[0], this.currentMesh);
    if (!result || result.totalSelected === 0) return;

    if (additive && this.pending) {
      for (const [mesh, faces] of result.selected) {
        let set = this.pending.selected.get(mesh);
        if (!set) {
          set = new Set();
          this.pending.selected.set(mesh, set);
        }
        for (const f of faces) set.add(f);
      }
      this.pending.clicks++;
    } else {
      this.pending = {
        selected: result.selected,
        targetClass: result.targetClass,
        clicks: 1,
      };
    }

    this.pending.faceCount = 0;
    for (const set of this.pending.selected.values()) {
      this.pending.faceCount += set.size;
    }
    this.pending.suggested = this.labels
      ? this.labels.suggestFor(this.pending)
      : "other";

    this.selector.showFaces(this.pending.selected);
    this.showLabelPanel();
  }

  cancelPendingSelection() {
    this.pending = null;
    if (this.selector) this.selector.clearHighlight();
    this.setAddMode(false);
    if (this.ui) this.ui.panel.classList.remove("active");
  }

  // Live streamer + frame stats (enabled with ?debug): proves the gaze
  // bubble is targeting correctly and that no frame is eating a stall.
  updateLODDebug() {
    let el = document.getElementById("lod-debug");
    if (!el) {
      el = document.createElement("div");
      el.id = "lod-debug";
      el.style.cssText =
        "position:fixed;bottom:4px;left:4px;z-index:2000;pointer-events:none;" +
        "font:10px/1.4 monospace;color:#0f0;background:rgba(0,0,0,.65);" +
        "padding:3px 6px;border-radius:4px;white-space:pre";
      document.body.appendChild(el);
    }
    const s = this.streamer;
    let native = 0;
    let ring = 0;
    let decoding = 0;
    for (const t of s.tiles) {
      if (t.state === "high") {
        if (t.size >= s.nativeSize && s.nativeSize > s.ringSize) native++;
        else ring++;
      }
      if (t.decoding) decoding++;
    }
    const mode = s.focusTiles
      ? "FOCUS(review)"
      : s.spatialTiling
        ? "gaze"
        : "uniform(atlas)";
    const ema = this._frameEMA == null ? 0 : this._frameEMA;
    const worst = this._frameWorst || 0;
    el.textContent =
      `LOD ${mode} · ${native} native + ${ring} ring / ${s.totalCap} · ` +
      `${decoding} decoding · ${s.uploadQueue.length} queued · ${s.decodeCount} total\n` +
      `sizes ring=${s.ringSize} native=${s.nativeSize} · deviceMemory=${navigator.deviceMemory ?? "n/a"}\n` +
      `frame ${ema.toFixed(1)}ms avg · worst ${worst.toFixed(0)}ms since last update`;
    this._frameWorst = 0;
  }

  // --- auto-tagging ------------------------------------------------------------

  // Segment + classify the whole map; results become red "flagged" proposals
  // feeding the review queue. Stored labels are the cache — reloads restore
  // them instantly; re-running clears previous auto labels first.
  async runAutoTag() {
    if (!this.labels || !this.selector || this.mode !== "explore" || this.autoTagging) return;
    this.autoTagging = true;
    this.cancelPendingSelection();
    this.showLoading("Auto-tagging surfaces...");
    const progressText = document.getElementById("loading-progress");
    try {
      const removed = this.labels.removeAuto();
      if (removed) console.log(`auto-tag: cleared ${removed} previous proposals`);
      const t0 = performance.now();
      const res = await autoTag({
        selector: this.selector,
        labels: this.labels,
        root: this.currentMesh,
        onProgress: (done, total, created) => {
          progressText.textContent = `${Math.round((done / total) * 100)}% · ${created} surfaces`;
        },
      });
      console.log(
        `auto-tag: ${res.created} proposals from ${res.regions} regions in ${(
          (performance.now() - t0) / 1000
        ).toFixed(1)}s`
      );
    } catch (err) {
      console.error("auto-tag failed", err);
      alert(`Auto-tag failed: ${err.message}`);
    } finally {
      this.hideLoading();
      this.autoTagging = false;
      this.renderLabelList();
    }
  }

  // --- review mode -----------------------------------------------------------

  enterReviewMode() {
    if (this.mode === "review") return;
    if (!this.labels || !this.labels.list.length) return;

    this.cancelPendingSelection();

    if (!this.orbit) {
      this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
      this.orbit.enableDamping = true;
      this.orbit.dampingFactor = 0.12;
      this.orbit.maxPolarAngle = Math.PI * 0.49; // stay above the horizon
      this.orbit.enabled = false;
    }
    if (!this.review) {
      this.review = new ReviewMode({
        camera: this.camera,
        orbit: this.orbit,
        labels: this.labels,
        streamer: this.streamer,
        ui: {
          hud: document.getElementById("review-hud"),
          progress: document.getElementById("rh-progress"),
          klass: document.getElementById("rh-class"),
          meta: document.getElementById("rh-meta"),
          exit: document.getElementById("rh-exit"),
          actions: document.getElementById("review-actions"),
          reclass: document.getElementById("ra-reclass"),
          verbs: document.getElementById("ra-verbs"),
          correct: document.getElementById("ra-correct"),
          wrong: document.getElementById("ra-wrong"),
          flag: document.getElementById("ra-flag"),
          skip: document.getElementById("ra-skip"),
        },
        onChange: () => this.renderLabelList(),
        onExit: () => this.handleReviewExit(),
      });
    }
    // Refresh refs — labels is rebuilt per map, streamer arrives after load.
    this.review.labels = this.labels;
    this.review.streamer = this.streamer;

    this.mode = "review";
    this.controls.enabled = false;
    this.orbit.enabled = true;
    // Seed the orbit target with the current view direction so the first
    // frame doesn't snap toward a stale target.
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.orbit.target.copy(this.camera.position).addScaledVector(dir, 10);

    // The HUD owns the screen: labels card and controls-help make way.
    this.ui.card.classList.remove("active");
    document.getElementById("info").style.display = "none";

    if (!this.review.enter()) this.handleReviewExit();
  }

  handleReviewExit() {
    this.mode = "explore";
    if (this.orbit) this.orbit.enabled = false;
    this.controls.enabled = true;
    this.controls.syncFromCamera();
    document.getElementById("info").style.display = "";
    this.renderLabelList();
  }

  setAddMode(on) {
    this.addMode = on;
    if (this.ui) this.ui.addToggle.classList.toggle("active", on);
  }

  // --- labeling UI -----------------------------------------------------------

  initLabelUI() {
    this.ui = {
      panel: document.getElementById("label-panel"),
      summary: document.getElementById("lp-summary"),
      classes: document.getElementById("lp-classes"),
      conf: document.getElementById("lp-conf"),
      addToggle: document.getElementById("lp-add"),
      save: document.getElementById("lp-save"),
      cancel: document.getElementById("lp-cancel"),
      card: document.getElementById("labels-card"),
      count: document.getElementById("labels-count"),
      list: document.getElementById("labels-list"),
      export: document.getElementById("labels-export"),
      clear: document.getElementById("labels-clear"),
      reviewBtn: document.getElementById("labels-review"),
      autoBtn: document.getElementById("labels-auto"),
    };
    this.pickedClass = null;
    this.pickedConfidence = "confirmed";

    for (const cls of LABEL_CLASSES) {
      const b = document.createElement("button");
      b.className = "class-btn";
      b.dataset.cls = cls.id;
      b.style.setProperty("--chip", cls.color);
      b.textContent = cls.name;
      b.addEventListener("click", () => this.pickClass(cls.id));
      this.ui.classes.appendChild(b);
    }

    for (const conf of CONFIDENCE_LEVELS) {
      const b = document.createElement("button");
      b.className = "conf-btn";
      b.dataset.conf = conf.id;
      b.style.setProperty("--chip", conf.color);
      b.textContent = conf.name;
      b.addEventListener("click", () => this.pickConfidence(conf.id));
      this.ui.conf.appendChild(b);
    }

    this.ui.addToggle.addEventListener("click", () => this.setAddMode(!this.addMode));
    this.ui.save.addEventListener("click", () => this.saveLabel());
    this.ui.cancel.addEventListener("click", () => this.cancelPendingSelection());
    this.ui.reviewBtn.addEventListener("click", () => this.enterReviewMode());
    this.ui.autoBtn.addEventListener("click", () => this.runAutoTag());
    this.ui.export.addEventListener("click", () => {
      if (this.labels) this.labels.exportDownload();
    });
    this.ui.clear.addEventListener("click", () => {
      if (this.labels && confirm("Delete all labels for this map?")) {
        this.labels.clearAll();
        this.renderLabelList();
      }
    });
    // Delegated delete buttons — the list is re-rendered wholesale.
    this.ui.list.addEventListener("click", (event) => {
      const id = event.target?.dataset?.del;
      if (id && this.labels) {
        this.labels.remove(id);
        this.renderLabelList();
      }
    });
  }

  pickClass(id) {
    this.pickedClass = id;
    for (const b of this.ui.classes.children) {
      b.classList.toggle("active", b.dataset.cls === id);
    }
  }

  pickConfidence(id) {
    this.pickedConfidence = id;
    for (const b of this.ui.conf.children) {
      b.classList.toggle("active", b.dataset.conf === id);
    }
  }

  showLabelPanel() {
    if (!this.ui || !this.pending) return;
    const p = this.pending;
    const tiles = p.selected.size;
    this.ui.summary.textContent =
      `${p.faceCount.toLocaleString()} faces · ${tiles} tile${tiles === 1 ? "" : "s"}` +
      (p.clicks > 1 ? ` · ${p.clicks} clicks` : "") +
      ` · suggested: ${this.labels ? this.labels.className(p.suggested) : p.suggested}`;
    // Preselect the suggestion on a fresh selection; keep the user's picks
    // while they extend with shift-click / add mode.
    if (p.clicks === 1) {
      this.pickClass(p.suggested);
      this.pickConfidence("confirmed");
    }
    this.ui.panel.classList.add("active");
  }

  saveLabel() {
    if (!this.pending || !this.labels || !this.pickedClass) return;
    this.labels.add({
      selected: this.pending.selected,
      classId: this.pickedClass,
      confidence: this.pickedConfidence,
      suggested: this.pending.suggested,
      targetClass: this.pending.targetClass,
    });
    this.cancelPendingSelection();
    this.renderLabelList();
  }

  renderLabelList() {
    if (!this.ui || !this.labels) return;
    if (this.mode === "review") return; // HUD owns the screen; re-rendered on exit
    this.ui.card.classList.add("active");
    const labels = this.labels.list;
    this.ui.count.textContent = String(labels.length);
    // Keep the Review entry point visible even with nothing to review —
    // hiding it entirely made the mode undiscoverable.
    this.ui.reviewBtn.disabled = !labels.length;
    this.ui.reviewBtn.title = labels.length
      ? "Review saved labels one at a time"
      : "Save at least one label first";
    const MAX_ROWS = 120; // auto-tagging can create hundreds
    this.ui.list.innerHTML =
      labels
        .slice(0, MAX_ROWS)
        .map((l) => {
          const cls = LABEL_CLASSES.find((c) => c.id === l.class);
          const conf = CONFIDENCE_LEVELS.find((c) => c.id === l.confidence);
          return `<div class="label-row">
          <span class="dot" style="background:${cls ? cls.color : "#fff"}"></span>
          <span class="label-name">${cls ? cls.name : l.class}${l.source === "auto" ? " <span class='auto-chip'>auto</span>" : ""}</span>
          <span class="label-meta">${l.faceCount.toLocaleString()} faces</span>
          <span class="dot conf" title="${conf ? conf.name : ""}" style="background:${conf ? conf.color : "#fff"}"></span>
          <button class="row-del" data-del="${l.id}" title="Delete">×</button>
        </div>`;
        })
        .join("") +
      (labels.length > MAX_ROWS
        ? `<div class="label-row" style="opacity:.6">…and ${labels.length - MAX_ROWS} more</div>`
        : "");
  }

  updateControlsInfo() {
    const infoDiv = document.getElementById("info");
    const isTouchDevice =
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0 ||
      navigator.msMaxTouchPoints > 0;

    if (isTouchDevice) {
      infoDiv.innerHTML = `
        <strong>Touch Controls:</strong><br>
        1 finger - Look around<br>
        2 finger pinch - Move forward/back<br>
        3 finger drag - Pan left/right/up/down<br>
        Tap - Select surface ("+ Add" extends)
      `;
    } else {
      infoDiv.innerHTML = `
        <strong>Desktop Controls:</strong><br>
        WASD - Move<br>
        Shift - Fast mode<br>
        Click + Drag - Look around<br>
        Click - Select surface · Shift+Click - Add · Esc - Cancel
      `;
    }
    infoDiv.innerHTML += `<br><span style="opacity:0.6;font-size:11px">build ${BUILD_VERSION}</span>`;
  }

  showLoading(text = "Loading mesh...") {
    const overlay = document.getElementById("loading-overlay");
    const loadingText = document.getElementById("loading-text");
    const progressText = document.getElementById("loading-progress");

    overlay.classList.add("active");
    loadingText.textContent = text;
    progressText.textContent = "";
  }

  hideLoading() {
    const overlay = document.getElementById("loading-overlay");
    overlay.classList.remove("active");
  }

  updateLoadingProgress(progress) {
    const progressText = document.getElementById("loading-progress");
    if (progress && progress.total > 0) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      progressText.textContent = `${percent}%`;
    }
  }

  // Free GPU resources (geometries, materials, textures) held by an object
  // tree. Three.js does NOT do this when you remove an object from the scene,
  // so without it every mesh swap leaks GPU memory until the WebGL context is
  // lost (blank screen / mobile tab reload).
  disposeObject(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (!child.isMesh) return;
      if (child.geometry) child.geometry.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      materials.forEach((material) => {
        if (!material) return;
        for (const key in material) {
          const value = material[key];
          if (value && value.isTexture) value.dispose();
        }
        material.dispose();
      });
    });
  }

  async loadMeshFiles(files) {
    const startTime = performance.now();
    let lastTime = startTime;

    const logTiming = (label) => {
      const now = performance.now();
      const delta = now - lastTime;
      const total = now - startTime;
      console.log(
        `[TIMING] ${label}: ${delta.toFixed(0)}ms (total: ${total.toFixed(
          0
        )}ms)`
      );
      lastTime = now;
    };

    try {
      this.showLoading("Loading mesh file...");

      if (this.currentMesh) {
        this.scene.remove(this.currentMesh);
        this.disposeObject(this.currentMesh);
        this.currentMesh = null;
      }
      logTiming("Scene cleanup");

      // Check if it's a single GLB/GLTF file
      const filesArray = Array.from(files);
      console.log(
        "Loading files:",
        filesArray.map((f) => f.name)
      );

      const glbFile = filesArray.find(
        (f) => f.name.endsWith(".glb") || f.name.endsWith(".gltf")
      );

      // Use setTimeout to allow UI to update before heavy processing
      await new Promise((resolve) => setTimeout(resolve, 10));
      logTiming("UI update delay");

      if (glbFile) {
        console.log("Loading GLB file:", glbFile.name);
        this.currentMesh = await this.meshLoader.loadFile(
          glbFile,
          (progress) => {
            this.updateLoadingProgress(progress);
          }
        );
      } else {
        // Handle multiple files (OBJ + MTL + textures)
        console.log("Loading multiple files");
        this.currentMesh = await this.meshLoader.loadFiles(filesArray);
      }
      logTiming("File loaded and parsed");

      console.log("Mesh loaded successfully:", this.currentMesh);

      this.showLoading("Processing geometry...");

      // Calculate bounds BEFORE adding to scene
      const box = new THREE.Box3().setFromObject(this.currentMesh);
      logTiming("Bounding box calculation");

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      console.log("Mesh size:", size);

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 50 / maxDim;
      this.currentMesh.scale.multiplyScalar(scale);

      this.currentMesh.position.sub(center.multiplyScalar(scale));
      this.currentMesh.position.y = 0;
      logTiming("Scaling and positioning");

      // Optimize materials for large meshes
      let meshCount = 0;
      let materialCount = 0;
      this.currentMesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          meshCount++;
          // Enable frustum culling
          child.frustumCulled = true;

          // Optimize material settings
          if (child.material) {
            materialCount++;
            child.material.precision = "mediump";
          }
        }
      });
      console.log(
        `Processed ${meshCount} meshes with ${materialCount} materials`
      );
      logTiming("Material optimization");

      this.camera.position.set(0, size.y * scale * 0.5, size.z * scale * 1.5);
      this.controls.reset();
      logTiming("Camera setup");

      // Now add to scene after all processing is done
      this.showLoading("Adding to scene...");
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.scene.add(this.currentMesh);
      logTiming("Added to scene");

      // Force a render to upload to GPU
      this.showLoading("Uploading to GPU...");
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.renderer.render(this.scene, this.camera);
      logTiming("First render (GPU upload)");

      this.hideLoading();
      logTiming("Complete");
    } catch (error) {
      this.hideLoading();
      console.error("Detailed error loading mesh:", error);
      console.error("Error stack:", error.stack);
      alert(`Failed to load mesh file: ${error.message}`);
    }
  }

  showProgressiveLoader() {
    const loader = document.getElementById("progressive-loader");
    loader.classList.add("active");
  }

  hideProgressiveLoader() {
    const loader = document.getElementById("progressive-loader");
    loader.classList.remove("active");
  }

  async loadRawHighRes(url) {
    try {
      this.showLoading("Loading FULL model (ground-truth mode)…");
      const mesh = await this.meshLoader.loadFromUrl(url, (p) =>
        this.updateLoadingProgress(p)
      );
      await this.setupMesh(mesh);
      this.hideLoading();
      console.log(
        "[drone-mesh] RAW mode: full GLB with native textures, no streaming pipeline"
      );

      // Selection/labeling still work, but against the raw mesh's own face
      // indexing — keep its labels in a separate storage bucket so they can't
      // corrupt the canonical (progressive-mode) label set.
      this.selector = new SurfaceSelector(this.scene);
      this.labels = new LabelManager({
        scene: this.scene,
        root: this.currentMesh,
        mapKey: `${url}#raw`,
      });
      this.labels.restore();
      this.renderLabelList();
    } catch (err) {
      this.hideLoading();
      console.error("raw load failed", err);
      alert(`Failed to load full model: ${err.message}`);
    }
  }

  async loadProgressiveMesh(lowResUrl, highResUrl) {
    try {
      // Load low-res version first
      this.showLoading("Loading preview...");
      console.log("Loading low-res mesh...");

      this.lowResMesh = await this.meshLoader.loadFromUrl(
        lowResUrl,
        (progress) => {
          this.updateLoadingProgress(progress);
        }
      );

      await this.setupMesh(this.lowResMesh);
      this.hideLoading();
      console.log("Low-res mesh loaded and displayed");

      // Selection + labels operate on the low-res mesh (stable geometry —
      // high-res streaming only swaps textures/visibility, so face indices
      // stay valid for stored labels).
      this.selector = new SurfaceSelector(this.scene);
      this.labels = new LabelManager({
        scene: this.scene,
        root: this.currentMesh,
        mapKey: lowResUrl,
      });
      const restored = this.labels.restore();
      if (restored) console.log(`Restored ${restored} saved labels`);
      this.renderLabelList();

      // NO automatic pre-warm: the adjacency build (incl. one long synchronous
      // global-graph merge) was stealing frames right after load, while users
      // fly. First selection click pays it instead — user is stationary then.

      // Stream high-res textures by proximity. The 61 MB high-res GLB is fetched
      // once and stripped of its textures so nothing is decoded up front; only
      // the nearest tiles ever decode/upload a texture. This is what keeps memory
      // bounded on tablets/phones (see HighResStreamer).
      this.showProgressiveLoader();
      this.isLoadingHighRes = true;

      console.log("Starting high-res streaming...");
      this.streamer = new HighResStreamer({
        scene: this.scene,
        camera: this.camera,
        gltfLoader: this.meshLoader.loaders.gltf,
        nativeSize: this.streamProfile.nativeSize,
        ringSize: this.streamProfile.ringSize,
        nativeCap: this.streamProfile.nativeCap,
        totalCap: this.streamProfile.totalCap,
      });
      const tileCount = await this.streamer.load(highResUrl, this.currentMesh);
      console.log(`High-res streaming active: ${tileCount} tiles`);

      // If review mode started before the high-res GLB arrived, hand it the
      // streamer and point the texture focus at the current item.
      if (this.review) {
        this.review.streamer = this.streamer;
        const item = this.review.cur();
        if (this.review.active && item) this.review.applyFocus(item);
      }

      this.hideProgressiveLoader();
      this.isLoadingHighRes = false;
    } catch (error) {
      this.hideLoading();
      this.hideProgressiveLoader();
      console.error("Error loading progressive mesh:", error);
      alert(`Failed to load mesh: ${error.message}`);
    }
  }

  async setupMesh(mesh) {
    const startTime = performance.now();
    let lastTime = startTime;

    const logTiming = (label) => {
      const now = performance.now();
      const delta = now - lastTime;
      const total = now - startTime;
      console.log(
        `[TIMING] ${label}: ${delta.toFixed(0)}ms (total: ${total.toFixed(
          0
        )}ms)`
      );
      lastTime = now;
    };

    if (this.currentMesh && this.currentMesh !== mesh) {
      this.scene.remove(this.currentMesh);
      this.disposeObject(this.currentMesh);
    }

    // Calculate bounds BEFORE adding to scene
    const box = new THREE.Box3().setFromObject(mesh);
    logTiming("Bounding box calculation");

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    console.log("Mesh size:", size);

    // Fix mesh orientation - rotate in world coordinates
    mesh.rotation.order = "YXZ"; // Apply Y rotation first, then X
    mesh.rotation.y = Math.PI; // 180 degrees around world Y-axis first
    mesh.rotation.x = -Math.PI / 2; // Then 90 degrees around X-axis
    logTiming("Mesh rotation fix");

    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 50 / maxDim;
    mesh.scale.multiplyScalar(scale);

    mesh.position.sub(center.multiplyScalar(scale));
    mesh.position.y = 0;
    logTiming("Scaling and positioning");

    // Optimize materials for large meshes
    let meshCount = 0;
    let materialCount = 0;
    mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshCount++;
        child.frustumCulled = true;
        child.castShadow = false;
        child.receiveShadow = false;

        if (child.material) {
          materialCount++;
          child.material.precision = "mediump";
        }
      }
    });
    console.log(
      `Processed ${meshCount} meshes with ${materialCount} materials`
    );
    logTiming("Material optimization");

    // Set camera position only for first mesh - up and back from origin
    if (!this.currentMesh) {
      this.camera.position.set(0, 10, 15); // Up and back from origin
      this.controls.reset();
      this.controls.lat = -15; // Look down slightly
      this.controls.lon = -90; // Rotate to look along Z-axis
    }
    logTiming("Camera setup");

    // Add to scene
    this.scene.add(mesh);
    this.currentMesh = mesh;
    logTiming("Added to scene");

    // Force render
    this.renderer.render(this.scene, this.camera);
    logTiming("First render (GPU upload)");

    return mesh;
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    // Frame-time telemetry for the ?debug HUD — measure BEFORE any work so
    // stalls anywhere in the app show up, not just in this loop.
    if (this.debugLOD) {
      const now = performance.now();
      if (this._lastFrameT != null) {
        const dt = now - this._lastFrameT;
        this._frameEMA = this._frameEMA == null ? dt : this._frameEMA * 0.9 + dt * 0.1;
        if (dt > (this._frameWorst || 0)) this._frameWorst = dt;
      }
      this._lastFrameT = now;
    }

    if (this.mode === "review" && this.review) {
      this.review.updateFrame(); // tween + orbit damping
    } else {
      this.controls.update();
    }

    // Don't try to render on a lost context - it just spams GL errors until
    // (and if) the browser restores it.
    if (this.contextLost) return;

    // Re-evaluate which tiles stream a high-res texture periodically (not every
    // frame - it sorts all tiles) so detail follows the camera within budget.
    // Uploads drain one-per-frame so they never stack up into a hitch.
    this.frameCount++;
    if (this.streamer) {
      this.streamer.drainUploads();
      if (this.frameCount % LOD_UPDATE_INTERVAL === 0) {
        this.streamer.update();
        if (this.debugLOD) this.updateLODDebug();
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}

new MeshExplorer();
