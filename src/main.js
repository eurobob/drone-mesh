import * as THREE from "three";
import { FirstPersonControls } from "./FirstPersonControls.js";
import { MeshLoader } from "./MeshLoader.js";
import { HighResStreamer } from "./HighResStreamer.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SurfaceSelector } from "./SurfaceSelector.js";
import { LabelManager, LABEL_CLASSES, CONFIDENCE_LEVELS } from "./Labels.js";
import { ReviewMode } from "./ReviewMode.js";
import { autoTag } from "./AutoTagger.js";
import { PaintTools } from "./PaintTools.js";

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
// span the ENTIRE site. The streamer detects that and uses a face-level
// spatial index for deferred-until-needed loading: pages with geometry near
// the camera/gaze promote (native inner radius, ring outer), everything else
// stays base until approached, demoting when left behind. Caps are sized for
// "how many pages a neighbourhood touches", not tile counts.
// ONE strategy for every device: deferred single-tier loading — nothing
// speculative, native-quality textures only near the camera. Hardware
// evidence changes COVERAGE (caps = how many pages may be resident), never
// the strategy and never the quality ceiling. Caps are the safety net; the
// 3D-distance reach is what actually bounds residency.
// keepDist = retention radius: how far you can back away before resident
// textures evict. Validated hardware keeps most of a session's visited area
// warm (the texture is already paid for — retention is the cheap luxury);
// lite devices evict aggressively.
// Lite native is 1024, not 2048: one locale of scattered atlas pages needs
// ~20-40 pages resident, and cheap devices can afford that ONLY at 1024
// (≈5.6 MB/page vs 22). Full local coverage at good quality beats patchy
// coverage at max quality — the earlier 6-page cap starved neighbourhoods.
const LITE_CAPS = { nativeSize: 1024, ringSize: 1024, nativeCap: 24, totalCap: 48, keepDist: 16 };
const RICH_CAPS = { nativeSize: 2048, ringSize: 1024, nativeCap: 32, totalCap: 128, keepDist: 45 };
const LOD_UPDATE_INTERVAL = 12; // frames between LOD re-evaluations

// Bump on every meaningful change. Shown in the info panel and logged at startup
// so it's possible to confirm the live preview is actually running current code
// (vs a stale cached bundle).
const BUILD_VERSION = "erase-toggle-1";

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

    // "explore" = free-roam + click-to-label; "review" = one queue item at a
    // time under an orbit camera with scoped tile rendering.
    this.mode = "explore";
    this.orbit = null;
    this.review = null;

    // Selection refinement state: subtract mode, undo history (snapshots of
    // the pending face map, capped), and the label being edited in place.
    // Editing model: two orthogonal axes. Intent = what a gesture does
    // (add / remove); Tool = how you point (tap / brush / lasso). Tap uses
    // the flood-fill click path; brush/lasso hand off to PaintTools. Both
    // tools honor the current intent, so lasso/brush can add OR remove.
    this.editIntent = "add";
    // navigate = camera only (no tagging); tap/brush/lasso = tagging tools.
    // Default to navigate so a tap never tags by accident — the user opts in
    // by picking a tool from the bar.
    this.editTool = "navigate";
    this.paint = null;
    this.pendingHistory = [];
    this.editingLabelId = null;

    this.init();
    this.setupEventListeners();
    this.animate();

    // URL surface, deliberately tiny:
    //   (nothing) — the experience. Local files auto-detected, else CDN.
    //   ?debug    — HUD + state tinting + load-zone rings, all of it.
    //   ?full     — ground truth: whole GLB, no pipeline.
    // (?tex/?ring/?tiles/?lite/?hq/?local remain as undocumented tuning.)
    const params = new URLSearchParams(location.search);
    const dbg = params.has("debug") || params.has("viz");
    this.debugLOD = dbg;
    this.debugViz = dbg;

    // LITE IS THE DEFAULT — for every device, always. The rich profile is
    // opt-IN via progressive enhancement: granted only on POSITIVE hardware
    // evidence (reported memory or a recognisably capable GPU), never on
    // touch devices (thermals), never on unknown hardware. Overrides:
    // ?hq forces rich, ?lite forces lite.
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    let gpu = "";
    try {
      const gl = this.renderer.getContext();
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = String(
        info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      );
    } catch (e) {
      /* no evidence → stay lite */
    }
    const memoryOK = (navigator.deviceMemory || 0) >= 8;
    const gpuOK = /apple m\d|rtx|geforce|radeon pro|radeon rx|nvidia/i.test(gpu);
    const validated = !isTouch && (memoryOK || gpuOK);
    const rich = params.has("hq") || (validated && !params.has("lite"));
    const base = rich ? RICH_CAPS : LITE_CAPS;
    console.log(
      `[drone-mesh] coverage: ${rich ? "RICH (validated hardware)" : "LITE (default)"} · ` +
        `gpu="${gpu}" · deviceMemory=${navigator.deviceMemory ?? "n/a"} · ` +
        `same strategy + native quality either way`
    );
    // Uniform (atlas) maps hold ALL pages at ringSize, so ringSize IS the
    // close-up quality. Desktop = native 2048 unconditionally (~2.9 GB
    // textures, Blender parity; measured source: 107×2048 + 23×1024).
    // Weaker machines can pass ?ring=1024 — no silent downgrades.
    this.streamProfile = {
      ...base,
      nativeSize: parseInt(params.get("tex"), 10) || base.nativeSize,
      ringSize: parseInt(params.get("ring"), 10) || base.ringSize,
      totalCap: parseInt(params.get("tiles"), 10) || base.totalCap,
    };
    console.log(
      `[drone-mesh] stream caps: ${this.streamProfile.nativeCap} native @ ${this.streamProfile.nativeSize}px, total ${this.streamProfile.totalCap}`
    );
    this.startLoading(params);
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 10, 1000);

    // near/far ratio drives depth precision. The mesh normalizes to a 50-unit
    // box, so a 0.1 near against 2000 far (ratio 20000) wastes precision and
    // z-fights overlays; 0.3/1200 keeps ~4× the precision while still letting
    // the camera get close to a building without clipping.
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.3,
      1200
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

    // Kill iOS OS-level zoom that the viewport meta alone doesn't stop:
    // pinch (gesture* events) and double-tap-to-zoom.
    ["gesturestart", "gesturechange", "gestureend"].forEach((ev) =>
      document.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
    );
    let lastTouchEnd = 0;
    document.addEventListener(
      "touchend",
      (e) => {
        const now = performance.now();
        if (now - lastTouchEnd < 320) e.preventDefault(); // second tap of a double-tap
        lastTouchEnd = now;
      },
      { passive: false }
    );

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
      this.handleSurfaceSelection(event.clientX, event.clientY, {
        add: event.shiftKey, // momentary overrides; intent axis is the default
        sub: event.altKey,
      });
    });

    // Handle touch taps for mobile
    let tapTimeout = null;
    canvas.addEventListener("touchend", (event) => {
      if (event.touches.length === 0 && event.changedTouches.length === 1) {
        const touch = event.changedTouches[0];
        // Use timeout to distinguish tap from drag
        if (tapTimeout) clearTimeout(tapTimeout);
        tapTimeout = setTimeout(() => {
          this.handleSurfaceSelection(touch.clientX, touch.clientY, {});
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
        if (this.mode === "review" && this.pendingDirty) {
          this.cancelPendingSelection(); // discard edits, stay on the item
        } else if (this.mode === "review" && this.review) {
          this.review.exit();
        } else {
          this.cancelPendingSelection();
        }
        return;
      }
      if (event.key === "z" && this.pending && (this.mode === "explore" || this.reviewAdjust)) {
        this.undoPending();
        return;
      }
      // Live LOD range tuning in ?debug: [ shrinks the load/reveal radii,
      // ] grows them. Rings + HUD update live; report the multiplier that
      // feels right and it becomes the default.
      if (this.debugLOD && this.streamer && (event.key === "[" || event.key === "]")) {
        const s = this.streamer;
        s.rangeScale =
          event.key === "["
            ? Math.max(0.25, s.rangeScale * 0.8)
            : Math.min(4, s.rangeScale * 1.25);
        s.update();
        this.updateLODDebug();
        return;
      }
      // Desktop review shortcuts (FirstPersonControls is disabled in review,
      // so no WASD conflicts).
      if (this.mode === "review" && this.review && this.review.active && !this.pendingDirty) {
        if (event.key === "Enter") this.review.correct();
        else if (event.key === "s" || event.key === "S") this.review.skip();
        else if (event.key === "f" || event.key === "F") this.review.flag();
      }
    });

    this.initLabelUI();
  }

  handleSurfaceSelection(clientX, clientY, rawMods = {}) {
    if (this.editTool !== "tap") return; // brush/lasso own the pointer
    const adjusting = this.mode === "review" && this.reviewAdjust;
    if (this.mode !== "explore" && !adjusting) return;
    if (!this.currentMesh || !this.selector) return;

    // Resolve add/remove: Shift/Alt are momentary overrides of the current
    // intent; otherwise the intent axis decides. Extending an existing
    // selection with tap defaults to the intent; a first tap always starts
    // fresh. In review adjust, a bare tap must never abandon the item.
    const mods = {
      add: rawMods.add || (!rawMods.sub && this.editIntent === "add"),
      sub: rawMods.sub || (!rawMods.add && this.editIntent === "remove"),
    };
    if (adjusting && !this.pending) return; // shouldn't happen; guard

    // Convert screen coordinates to normalized device coordinates
    this.mouse.x = (clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Raycast the low-res mesh only. It is the canonical label substrate:
    // its geometry never changes while high-res textures stream in and out,
    // so face indices stay valid. (three's raycaster ignores `visible`, which
    // is exactly what we want for tiles whose low-res twin is hidden.)
    const intersects = this.raycaster.intersectObject(this.currentMesh, true);
    if (!intersects.length) return; // empty space: leave selection; Cancel/Esc clears
    const hit = intersects[0];

    // Tap with no pending selection: edit an existing label if we hit one,
    // else start a fresh selection.
    if (!this.pending && !adjusting && this.labels) {
      const owner = this.labels.findLabelAt(hit.object, hit.faceIndex);
      if (owner) {
        this.enterEditLabel(owner);
        return;
      }
    }

    // Subtract: remove the flood region under the click from the pending set.
    if (mods.sub && this.pending) {
      const region = this.selector.select(hit, this.currentMesh);
      if (!region || !region.totalSelected) return;
      this.pushPendingHistory();
      for (const [mesh, faces] of region.selected) {
        const set = this.pending.selected.get(mesh);
        if (!set) continue;
        for (const f of faces) set.delete(f);
        if (!set.size) this.pending.selected.delete(mesh);
      }
      if (!this.pending.selected.size) {
        this.cancelPendingSelection();
        return;
      }
      this.pending.clicks++;
      this.refreshPending();
      return;
    }

    const result = this.selector.select(hit, this.currentMesh);
    if (!result || result.totalSelected === 0) return;

    if (mods.add && this.pending) {
      this.pushPendingHistory();
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
      if (this.editingLabelId) this.exitEditState(); // clicked away mid-edit
      this.pendingHistory = [];
      this.pending = {
        selected: result.selected,
        targetClass: result.targetClass,
        clicks: 1,
      };
    }
    this.refreshPending();
  }

  // Recompute pending stats, redraw the highlight, refresh whichever surface
  // owns the interaction (review sheet vs explore panel).
  refreshPending() {
    const p = this.pending;
    if (!p) return;
    p.faceCount = 0;
    for (const set of p.selected.values()) p.faceCount += set.size;
    p.suggested = this.labels ? this.labels.suggestFor(p) : "other";
    this.selector.showFaces(p.selected);
    if (this.mode === "review" && this.reviewAdjust) {
      this.pendingDirty = true;
      this.updateReviewSheet();
    } else {
      this.showLabelPanel();
    }
    this.syncDock();
  }

  pushPendingHistory() {
    if (!this.pending) return;
    const snap = new Map();
    for (const [mesh, faces] of this.pending.selected) snap.set(mesh, new Set(faces));
    this.pendingHistory.push(snap);
    if (this.pendingHistory.length > 20) this.pendingHistory.shift();
  }

  undoPending() {
    if (!this.pending || !this.pendingHistory.length) return;
    this.pending.selected = this.pendingHistory.pop();
    this.pending.clicks = Math.max(1, this.pending.clicks - 1);
    this.refreshPending();
  }

  growPending() {
    if (!this.pending || !this.selector) return;
    this.pushPendingHistory();
    this.pending.selected = this.selector.growSelection(
      this.pending.selected,
      this.currentMesh
    );
    this.refreshPending();
  }

  shrinkPending() {
    if (!this.pending || !this.selector) return;
    this.pushPendingHistory();
    const shrunk = this.selector.shrinkSelection(
      this.pending.selected,
      this.currentMesh
    );
    if (!shrunk.size) return; // never shrink to nothing — undo is for that
    this.pending.selected = shrunk;
    this.refreshPending();
  }

  // --- in-review editing (always armed) --------------------------------------

  // Every review item arrives ready to edit: its faces are the live pending
  // selection, tools work immediately, taps add (− Remove toggle subtracts).
  // Clean state = verbs (Confirm/Flag/Skip); any change = Save/Discard.
  armReviewItem(item) {
    this.quietDisarm();
    if (!item) {
      this.reviewAdjust = false; // queue complete
      return;
    }
    this.reviewAdjust = true;
    this.editingLabelId = item.label.id;
    this.labels.setOverlayVisible(item.label.id, false); // live highlight replaces it
    this.pending = {
      selected: this.labels.decodeSelection(item.label),
      targetClass: item.label.geomClass || "roof-flat",
      clicks: 1,
    };
    this.pending.faceCount = item.label.faceCount;
    this.pendingDirty = false;
    this.pickClass(item.label.class);
    this.pickConfidence(item.label.confidence);
    this.selector.showFaces(this.pending.selected);
    this.updateReviewSheet();
    this.showDock(true);
  }

  quietDisarm() {
    this.setTool("tap");
    this.editIntent = "add";
    if (this.editingLabelId && this.labels) {
      this.labels.setOverlayVisible(this.editingLabelId, true);
    }
    this.editingLabelId = null;
    this.pending = null;
    this.pendingHistory = [];
    this.pendingDirty = false;
    if (this.selector) this.selector.clearHighlight();
    this.showDock(false);
  }

  updateReviewSheet() {
    if (!this.review || !this.review.ui) return;
    const ui = this.review.ui;
    const dirty = !!this.pendingDirty;
    document.getElementById("ra-discard").style.display = dirty ? "" : "none";
    document.getElementById("ra-delete").style.display = "";
    ui.flag.style.display = dirty ? "none" : "";
    ui.skip.style.display = dirty ? "none" : "";
    ui.correct.textContent = dirty ? "✓ Save changes" : "✓ Confirm";
    this.syncDock();
    const cls = LABEL_CLASSES.find((c) => c.id === this.pickedClass);
    if (cls) {
      ui.klass.textContent = cls.name;
      ui.classHero.style.setProperty("--cls", cls.color);
      document.getElementById("ra-class-dot").style.background = cls.color;
    }
    if (this.pending) {
      ui.meta.textContent = `${this.pending.faceCount.toLocaleString()} faces`;
    }
  }

  // Confirm button: clean = verdict, dirty = save the edit (and count it).
  handleReviewConfirm() {
    if (!this.pendingDirty) return false; // let ReviewMode.correct() run
    this.labels.update(this.editingLabelId, {
      selected: this.pending.selected,
      classId: this.pickedClass,
      confidence: "confirmed",
    });
    this.pendingDirty = false;
    this.editingLabelId = null; // updated overlay repaints visible
    this.review.correct(); // advance; next item re-arms via onItemShown
    return true;
  }

  // Class chip: clean = classic reclass verb (advance); dirty = just set the
  // class, it saves with the rest of the edit.
  handleReviewReclass(classId) {
    this.pickClass(classId);
    if (!this.pendingDirty) return false; // default reclass+advance
    this.updateReviewSheet();
    return true;
  }

  // --- click-to-edit existing labels ----------------------------------------

  enterEditLabel(label) {
    this.editingLabelId = label.id;
    this.labels.setOverlayVisible(label.id, false); // pending highlight replaces it
    this.pendingHistory = [];
    this.pending = {
      selected: this.labels.decodeSelection(label),
      targetClass: label.geomClass || "roof-flat",
      clicks: 1,
    };
    this.refreshPending();
    // panel opens via refreshPending; preselect the label's own values
    this.pickClass(label.class);
    this.pickConfidence(label.confidence);
  }

  exitEditState() {
    if (this.editingLabelId && this.labels) {
      this.labels.setOverlayVisible(this.editingLabelId, true);
    }
    this.editingLabelId = null;
  }

  cancelPendingSelection() {
    this.setTool("tap");
    this.editIntent = "add";
    // In review, "cancel" means discard edits: re-present the item fresh.
    if (this.mode === "review" && this.reviewAdjust && this.review) {
      this.review.show(this.review.index);
      return;
    }
    this.exitEditState();
    this.pending = null;
    this.pendingHistory = [];
    if (this.selector) this.selector.clearHighlight();
    this.showDock(false);
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
        : "defer(atlas)";
    const ema = this._frameEMA == null ? 0 : this._frameEMA;
    const worst = this._frameWorst || 0;
    el.textContent =
      `LOD ${mode} · ${native} native + ${ring} ring / ${s.totalCap} · ` +
      `${decoding} decoding · ${s.uploadQueue.length} queued · ${s.decodeCount} total\n` +
      `sizes ring=${s.ringSize} native=${s.nativeSize} · deviceMemory=${navigator.deviceMemory ?? "n/a"}\n` +
      `range ×${s.rangeScale.toFixed(2)} → load ${s.loadRadius.toFixed(1)}u · reveal ${s.revealRadius.toFixed(1)}u · keep ${s.unloadDist}u  ([ / ] to tune)\n` +
      `motion ${s.camSpeed.toFixed(1)}u/s ${s.motionHold ? "· HELD (idle)" : "· streaming"}\n` +
      `frame ${ema.toFixed(1)}ms avg · worst ${worst.toFixed(0)}ms since last update`;
    this._frameWorst = 0;
  }

  // ?viz: tint each tile's material by its live streaming state. Tint means
  // "the streamer touched this"; untinted means base-only. A static green map
  // = streamer idle; flashing orange while flying = churn.
  updateVizTint() {
    const s = this.streamer;
    const matOf = (m) =>
      m && (Array.isArray(m.material) ? m.material[0] : m.material);
    for (const t of s.tiles) {
      for (const m of [t.mesh, t.low]) {
        const mat = matOf(m);
        if (!mat || !mat.color) continue;
        if (mat.userData._origColor === undefined) {
          mat.userData._origColor = mat.color.getHex();
        }
      }
      // Tint ONLY the enhanced overlay (renders where clusters reveal —
      // strictly local). Never tint the base mesh: it is the whole-map
      // scatter, and tinting it flashed every decode across the entire map.
      const tint =
        t.state === "high"
          ? t.size >= s.nativeSize
            ? 0x55ff55
            : 0xffee44
          : null;
      const hiMat = matOf(t.mesh);
      if (hiMat && hiMat.color) {
        hiMat.color.setHex(tint !== null ? tint : hiMat.userData._origColor);
      }
      const loMat = matOf(t.low);
      if (loMat && loMat.color && loMat.userData._origColor !== undefined) {
        loMat.color.setHex(loMat.userData._origColor);
      }
    }
  }

  // ?viz: wireframe rings on the ground showing the actual 3D-distance load
  // zone (green = native reach, yellow = ring reach). Because the thresholds
  // are true 3D distances, the ground-plane rings shrink as you climb —
  // at high altitude they vanish: nothing is close, nothing loads.
  updateVizRings() {
    const s = this.streamer;
    if (!s || !s.grid || s.spatialTiling) return;
    if (!this.vizRings) {
      const mkRing = (color) => {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
        }
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
        const line = new THREE.Line(geom, mat);
        line.renderOrder = 1001;
        this.scene.add(line);
        return line;
      };
      this.vizRings = { native: mkRing(0x33ff33), ring: mkRing(0xffdd33) };
    }
    const cam = this.camera.position;
    const cell = s.cellOf(cam);
    const gy = s.cellY ? s.cellY[cell.cz * s.grid.n + cell.cx] : 0;
    const dy = cam.y - gy;
    const place = (line, R) => {
      const r = Math.sqrt(Math.max(0, R * R - dy * dy));
      line.visible = r > 0.05;
      line.position.set(cam.x, gy + 0.05, cam.z);
      line.scale.set(r, 1, r);
    };
    place(this.vizRings.native, s.loadRadius); // green: load radius (live-tuned)
    place(this.vizRings.ring, s.unloadDist); // yellow: keep-resident boundary
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
          hud: document.getElementById("review-actions"), // one sheet now
          progress: document.getElementById("rh-progress"),
          klass: document.getElementById("rh-class"),
          classHero: document.getElementById("ra-class"),
          meta: document.getElementById("rh-meta"),
          exit: document.getElementById("rh-exit"),
          actions: document.getElementById("review-actions"),
          reclass: document.getElementById("ra-reclass"),
          verbs: document.getElementById("ra-verbs"),
          tools: document.getElementById("ra-tools"),
          correct: document.getElementById("ra-correct"),
          wrong: document.getElementById("ra-class"), // the class chip toggles the picker
          flag: document.getElementById("ra-flag"),
          skip: document.getElementById("ra-skip"),
        },
        onChange: () => this.renderLabelList(),
        onExit: () => this.handleReviewExit(),
        onItemShown: (item) => this.armReviewItem(item),
        onCorrect: () => this.handleReviewConfirm(),
        onReclass: (classId) => this.handleReviewReclass(classId),
      });
    }
    // Refresh refs — labels is rebuilt per map, streamer arrives after load.
    this.review.labels = this.labels;
    this.review.streamer = this.streamer;

    this.mode = "review";
    this.editTool = "navigate"; // orbit to inspect; pick a tool to adjust
    this.controls.enabled = false;
    this.orbit.enabled = true;
    // Seed the orbit target with the current view direction so the first
    // frame doesn't snap toward a stale target.
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.orbit.target.copy(this.camera.position).addScaledVector(dir, 10);

    this.ui.card.classList.remove("active");
    document.getElementById("info").classList.remove("active");
    this.showToolbar(true);
    this.syncModeToggle();

    if (!this.review.enter()) this.handleReviewExit();
  }

  handleReviewExit() {
    this.quietDisarm();
    this.reviewAdjust = false;
    this.mode = "explore";
    this.editTool = "navigate";
    if (this.orbit) this.orbit.enabled = false;
    this.controls.enabled = true;
    this.controls.syncFromCamera();
    this.showToolbar(true);
    this.syncModeToggle();
    this.syncToolbar();
    this.renderLabelList();
  }

  setIntent(intent) {
    this.editIntent = intent;
    if (this.paint) this.paint.setIntent(intent);
    this.syncToolbar();
  }

  // Tool selection also governs the camera: tap leaves navigation free
  // (you move between clicks); brush/lasso lock the active controller so the
  // gesture is ours. Reset to tap whenever a selection ends.
  setTool(tool) {
    // brush/lasso need a selection to act on; fall back to tap
    if ((tool === "brush" || tool === "lasso") && !this.pending) tool = "tap";
    this.editTool = tool;
    if (this.paint) {
      this.paint.setIntent(this.editIntent);
      // PaintTools only engages for brush/lasso; navigate/tap leave it off
      this.paint.setTool(tool === "brush" || tool === "lasso" ? tool : "tap");
    }
    // Camera is free for navigate + tap (drag looks); locked for brush/lasso
    // so the gesture owns the pointer.
    const locked = tool === "brush" || tool === "lasso";
    if (this.mode === "review") {
      if (this.orbit) this.orbit.enabled = !locked;
    } else if (this.controls) {
      this.controls.enabled = !locked;
    }
    this.syncToolbar();
  }

  // Apply a paint gesture's hit faces per intent (add merges, remove deletes).
  applyPaint(intent, map) {
    if (!this.pending) return;
    if (intent === "add") {
      for (const [mesh, faces] of map) {
        let set = this.pending.selected.get(mesh);
        if (!set) { set = new Set(); this.pending.selected.set(mesh, set); }
        for (const f of faces) set.add(f);
      }
    } else {
      for (const [mesh, faces] of map) {
        const set = this.pending.selected.get(mesh);
        if (!set) continue;
        for (const f of faces) set.delete(f);
        if (!set.size) this.pending.selected.delete(mesh);
      }
      if (!this.pending.selected.size && this.mode === "explore") {
        this.setTool("tap");
        this.cancelPendingSelection();
        return;
      }
    }
    this.refreshPending();
  }

  // Distance from the camera to the frontmost mesh surface at a canvas pixel,
  // or null on a miss. Anchors paint gestures to the surface under the cursor.
  pickSurfaceDepth(px, py) {
    if (!this.currentMesh) return null;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    this.mouse.x = (px / w) * 2 - 1;
    this.mouse.y = -(py / h) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.currentMesh, true);
    return hits.length ? hits[0].distance : null;
  }

  // Candidate faces a paint gesture may touch: for remove, the pending set;
  // for add, visible (in-frustum, front-facing) faces not already selected.
  paintCandidates(intent) {
    if (intent === "remove") return this.pending ? this.pending.selected : null;
    if (!this.currentMesh) return null;
    const cam = this.camera.position;
    this.camera.updateMatrixWorld();
    const pv = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );
    const frustum = new THREE.Frustum().setFromProjectionMatrix(pv);
    const out = new Map();
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    let budget = 60000; // bound per-move projection cost
    this.currentMesh.traverse((mesh) => {
      if (!mesh.isMesh || budget <= 0) return;
      const pos = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.index;
      const faceCount = index ? index.count / 3 : pos.count / 3;
      const sel = this.pending && this.pending.selected.get(mesh);
      const vi = (f, k) => (index ? index.getX(f * 3 + k) : f * 3 + k);
      for (let f = 0; f < faceCount; f++) {
        if (budget <= 0) break;
        if (sel && sel.has(f)) continue;
        va.fromBufferAttribute(pos, vi(f, 0)).applyMatrix4(mesh.matrixWorld);
        vb.fromBufferAttribute(pos, vi(f, 1)).applyMatrix4(mesh.matrixWorld);
        vc.fromBufferAttribute(pos, vi(f, 2)).applyMatrix4(mesh.matrixWorld);
        c.copy(va).add(vb).add(vc).multiplyScalar(1 / 3);
        if (!frustum.containsPoint(c)) continue;
        n.crossVectors(e1.subVectors(vb, va), e2.subVectors(vc, va));
        if (n.dot(e1.subVectors(c, cam)) >= 0) continue; // back-facing → skip
        let s = out.get(mesh);
        if (!s) { s = new Set(); out.set(mesh, s); }
        s.add(f);
        budget--;
      }
    });
    return out;
  }

  // Snap the camera onto the current selection from an orthogonal direction
  // so tools operate on a clean, aligned view (e.g. top-down to paint a roof).
  focusSelection(dir) {
    if (!this.pending || !this.pending.selected.size) return;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const [mesh, faces] of this.pending.selected) {
      const pos = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.index;
      for (const f of faces) {
        for (let k = 0; k < 3; k++) {
          const idx = index ? index.getX(f * 3 + k) : f * 3 + k;
          box.expandByPoint(v.fromBufferAttribute(pos, idx).applyMatrix4(mesh.matrixWorld));
        }
      }
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (radius / Math.tan(fov / 2)) * 1.5;
    const axis = {
      top: new THREE.Vector3(0.001, 1, 0.001),
      front: new THREE.Vector3(0, 0.15, 1),
      side: new THREE.Vector3(1, 0.15, 0),
    }[dir] || new THREE.Vector3(0.3, 0.6, 1);
    axis.normalize();
    this.camera.position.copy(center).addScaledVector(axis, dist);
    this.camera.lookAt(center);
    if (this.mode === "review" && this.orbit) {
      this.orbit.target.copy(center);
    } else if (this.controls) {
      this.controls.syncFromCamera();
    }
  }

  // --- primary tool bar + editing chrome ------------------------------------

  syncDock() { this.syncToolbar(); }

  // showDock(on): on = a selection is being edited. Reveals the refine/intent
  // tools + focus-view cluster and clears the status card out of the way.
  showDock(on) {
    const bar = document.getElementById("toolbar");
    if (bar) bar.classList.toggle("editing", on);
    const fg = document.getElementById("focus-group");
    if (fg) fg.classList.toggle("visible", on);
    const card = document.getElementById("labels-card");
    if (card) {
      if (on) card.classList.remove("active");
      else if (this.mode === "explore" && this.labels) card.classList.add("active");
    }
    this.syncToolbar();
  }

  showToolbar(on) {
    const bar = document.getElementById("toolbar");
    if (bar) bar.classList.toggle("visible", on);
  }

  syncToolbar() {
    const bar = document.getElementById("toolbar");
    if (!bar) return;
    bar.querySelectorAll("[data-tool]").forEach((b) =>
      b.classList.toggle("active", b.dataset.tool === this.editTool)
    );
    // Erase = the remove intent, shown as an on/off modifier (not a tool).
    const erasing = this.editIntent === "remove";
    bar.classList.toggle("erasing", erasing);
    const erase = document.getElementById("tb-erase");
    if (erase) erase.classList.toggle("active", erasing);
    const undo = document.getElementById("tb-undo");
    if (undo) undo.disabled = this.pendingHistory.length === 0;
  }

  setupToolbar() {
    const bar = document.getElementById("toolbar");
    if (!bar) return;
    bar.querySelectorAll("[data-tool]").forEach((b) =>
      b.addEventListener("click", () => this.setTool(b.dataset.tool))
    );
    document.getElementById("tb-erase").addEventListener("click", () =>
      this.setIntent(this.editIntent === "add" ? "remove" : "add")
    );
    document.getElementById("tb-undo").addEventListener("click", () => this.undoPending());
    document.getElementById("tb-grow").addEventListener("click", () => this.growPending());
    document.getElementById("tb-shrink").addEventListener("click", () => this.shrinkPending());

    // top-left: focus-view cluster + info popover
    document.querySelectorAll("#focus-group [data-view3d]").forEach((b) =>
      b.addEventListener("click", () => this.focusSelection(b.dataset.view3d))
    );
    document.getElementById("btn-info").addEventListener("click", () =>
      document.getElementById("info").classList.toggle("active")
    );

    // top-center: Explore / Review
    document.getElementById("mode-explore").addEventListener("click", () => {
      if (this.mode === "review" && this.review) this.review.exit();
    });
    document.getElementById("mode-review").addEventListener("click", () => {
      if (this.mode === "explore") this.enterReviewMode();
    });

    // top-right: tucked utilities menu
    const menu = document.getElementById("labels-menu");
    document.getElementById("labels-menu-btn").addEventListener("click", () =>
      menu.classList.toggle("open")
    );
  }

  syncModeToggle() {
    const ex = document.getElementById("mode-explore");
    const rv = document.getElementById("mode-review");
    if (ex) ex.classList.toggle("active", this.mode === "explore");
    if (rv) rv.classList.toggle("active", this.mode === "review");
  }

  // --- labeling UI -----------------------------------------------------------

  initLabelUI() {
    this.ui = {
      panel: document.getElementById("label-panel"),
      summary: document.getElementById("lp-summary"),
      classes: document.getElementById("lp-classes"),
      conf: document.getElementById("lp-conf"),
      deleteBtn: document.getElementById("lp-delete"),
      save: document.getElementById("lp-save"),
      cancel: document.getElementById("lp-cancel"),
      card: document.getElementById("labels-card"),
      count: document.getElementById("labels-count"),
      export: document.getElementById("labels-export"),
      clear: document.getElementById("labels-clear"),
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

    // Paint tools: lasso (mouse) / brush (touch), add OR remove per intent.
    // Reads candidates live and applies hits through applyPaint.
    this.paint = new PaintTools({
      domElement: this.renderer.domElement,
      container: document.getElementById("canvas-container"),
      camera: this.camera,
      getCandidates: (intent) => this.paintCandidates(intent),
      onGestureStart: () => this.pushPendingHistory(),
      onApply: (intent, map) => this.applyPaint(intent, map),
      pickDepth: (px, py) => this.pickSurfaceDepth(px, py),
    });
    this.setupToolbar();

    this.ui.deleteBtn.addEventListener("click", () => {
      if (this.editingLabelId && this.labels && confirm("Delete this label?")) {
        const id = this.editingLabelId;
        this.editingLabelId = null; // overlay is going away — skip restore
        this.labels.remove(id);
        this.cancelPendingSelection();
        this.renderLabelList();
      }
    });

    // review-sheet controls that live outside ReviewMode's own bindings
    const bindTool = (id, fn) => document.getElementById(id).addEventListener("click", fn);
    bindTool("ra-discard", () => this.cancelPendingSelection());
    bindTool("ra-delete", () => {
      if (!this.editingLabelId || !this.labels) return;
      if (!confirm("Delete this label?")) return;
      const id = this.editingLabelId;
      this.editingLabelId = null; // gone — no overlay to restore
      this.pending = null;
      this.pendingDirty = false;
      if (this.selector) this.selector.clearHighlight();
      this.labels.remove(id);
      if (this.review) this.review.removeCurrentItem();
      this.renderLabelList();
    });
    this.ui.save.addEventListener("click", () => this.saveLabel());
    this.ui.cancel.addEventListener("click", () => this.cancelPendingSelection());
    this.ui.autoBtn.addEventListener("click", () => {
      document.getElementById("labels-menu").classList.remove("open");
      this.runAutoTag();
    });
    this.ui.export.addEventListener("click", () => {
      document.getElementById("labels-menu").classList.remove("open");
      if (this.labels) this.labels.exportDownload();
    });
    this.ui.clear.addEventListener("click", () => {
      document.getElementById("labels-menu").classList.remove("open");
      if (this.labels && confirm("Delete all labels for this map?")) {
        this.labels.clearAll();
        this.renderLabelList();
      }
    });
    // View switcher: mode segments + per-class isolation dots.
    this.viewMode = "all";
    this.isolatedClass = null;
    document.getElementById("view-modes").addEventListener("click", (event) => {
      const btn = event.target.closest(".view-btn");
      if (!btn) return;
      this.viewMode = btn.dataset.view;
      this.isolatedClass = null;
      this.syncViewUI();
      if (this.labels) {
        this.labels.applyView({ mode: this.viewMode, classId: null });
      }
    });
    const classRow = document.getElementById("view-classes");
    for (const cls of LABEL_CLASSES) {
      const b = document.createElement("button");
      b.className = "class-dot-btn";
      b.title = `Show only ${cls.name}`;
      b.dataset.cls = cls.id;
      b.style.background = cls.color;
      b.addEventListener("click", () => {
        this.isolatedClass = this.isolatedClass === cls.id ? null : cls.id;
        this.syncViewUI();
        if (this.labels) {
          this.labels.applyView({ mode: this.viewMode, classId: this.isolatedClass });
        }
      });
      classRow.appendChild(b);
    }
  }

  syncViewUI() {
    for (const b of document.getElementById("view-modes").children) {
      b.classList.toggle(
        "active",
        !this.isolatedClass && b.dataset.view === this.viewMode
      );
    }
    for (const b of document.getElementById("view-classes").children) {
      b.classList.toggle("active", b.dataset.cls === this.isolatedClass);
    }
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
    const editing = !!this.editingLabelId;
    this.ui.summary.textContent =
      (editing ? "EDITING · " : "") +
      `${p.faceCount.toLocaleString()} faces · ${tiles} tile${tiles === 1 ? "" : "s"}` +
      (p.clicks > 1 ? ` · ${p.clicks} clicks` : "") +
      ` · suggested: ${this.labels ? this.labels.className(p.suggested) : p.suggested}`;
    // Preselect the suggestion on a fresh selection; keep the user's picks
    // while they refine (add/sub/grow/shrink) or edit an existing label.
    if (p.clicks === 1 && !editing) {
      this.pickClass(p.suggested);
      this.pickConfidence("confirmed");
    }
    this.ui.deleteBtn.style.display = editing ? "" : "none";
    this.ui.save.textContent = editing ? "Update label" : "Save label";
    this.ui.panel.classList.add("active");
    this.showDock(true);
  }

  saveLabel() {
    if (!this.pending || !this.labels || !this.pickedClass) return;
    if (this.editingLabelId) {
      this.labels.update(this.editingLabelId, {
        selected: this.pending.selected,
        classId: this.pickedClass,
        confidence: this.pickedConfidence,
      });
      this.editingLabelId = null; // updated overlay repaints visible
    } else {
      this.labels.add({
        selected: this.pending.selected,
        classId: this.pickedClass,
        confidence: this.pickedConfidence,
        suggested: this.pending.suggested,
        targetClass: this.pending.targetClass,
      });
    }
    this.cancelPendingSelection();
    this.renderLabelList();
  }

  // The status card is now just a count + coverage + view filters (the big
  // per-label list is gone — it's noise during tagging). Mode toggle owns the
  // Explore/Review switch, so no Review button here.
  renderLabelList() {
    if (!this.ui || !this.labels) return;
    const mesh = this.mode === "explore";
    this.ui.card.classList.toggle("active", mesh && !this.pending);
    const labels = this.labels.list;
    this.ui.count.textContent = `${labels.length} label${labels.length === 1 ? "" : "s"}`;
    this.labels.applyView(); // re-assert the active view filter
    const covEl = document.getElementById("labels-coverage");
    if (labels.length) {
      const compute = () => {
        covEl.textContent = `${this.labels.coverage().toFixed(0)}% covered`;
      };
      if (window.requestIdleCallback) requestIdleCallback(compute);
      else setTimeout(compute, 50);
    } else {
      covEl.textContent = "";
    }
    // Review is only reachable with something to review.
    const rv = document.getElementById("mode-review");
    if (rv) rv.disabled = !labels.length;
    this.syncModeToggle();
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

  // Pick mesh sources (local copies auto-detected, else CDN) and dispatch to
  // the requested mode. No ?local needed on dev machines with the files.
  async startLoading(params) {
    let useLocal = params.has("local");
    if (!useLocal) {
      try {
        const probe = await fetch("/resources/models/coconut-low.glb", { method: "HEAD" });
        useLocal = probe.ok;
      } catch (e) {
        /* CDN it is */
      }
    }
    const lowUrl = useLocal
      ? "/resources/models/coconut-low.glb"
      : "https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNx0lqYJJ2zb6Xow4apUyGg09cPEkSDjMLBJKHq";
    const highUrl = useLocal
      ? "/resources/models/coconut-high.glb"
      : "https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNxioLwD1Ldeg4T8dxVEobRa6BzCGisrcLNPtOl";
    console.log(`[drone-mesh] source: ${useLocal ? "local files" : "CDN"}`);

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
      this.showToolbar(true);
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
      this.showToolbar(true);
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
        keepDist: this.streamProfile.keepDist,
        maxAnisotropy: Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
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

      // Keep the pill up — with a live counter — until every wanted texture
      // is actually resident. The warmup window is where upload work happens
      // (and where frames may dip); labeling it stops it reading as "the app
      // is just slow".
      const pillText = document.querySelector("#progressive-loader span");
      const warmupWatch = setInterval(() => {
        const s = this.streamer;
        if (!s || !s.tiles.length) return;
        const resident = s.tiles.filter((t) => t.state === "high").length;
        const wanted = s.tiles.filter((t) => t.wanted).length;
        if (pillText) {
          pillText.textContent = `Enhancing quality… ${resident}/${wanted || "?"}`;
        }
        const done =
          s.uploadQueue.length === 0 &&
          s.decoding === 0 &&
          s.tiles.every((t) => !t.wanted || t.state === "high");
        if (done) {
          clearInterval(warmupWatch);
          this.hideProgressiveLoader();
          if (pillText) pillText.textContent = "Enhancing quality...";
          console.log(`[streamer] warmup complete: ${resident} textures resident`);
        }
      }, 250);
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
        this._frameWorstNow = dt; // this specific frame, for spike forensics
      }
      this._lastFrameT = now;
    }

    if (this.mode === "review" && this.review) {
      this.review.updateFrame(); // tween + orbit damping
    } else {
      this.controls.update();
    }

    // Camera speed (units/sec, smoothed) feeds the streamer's motion gate so
    // texture work never lands during a fly-through.
    if (this.streamer) {
      const nowM = performance.now();
      this._camPos = this._camPos || this.camera.position.clone();
      if (this._camT) {
        const dt = (nowM - this._camT) / 1000;
        if (dt > 0) {
          const inst = this.camera.position.distanceTo(this._camPos) / dt;
          this._camSpeed = (this._camSpeed || 0) * 0.7 + inst * 0.3;
          this.streamer.setMotion(this._camSpeed);
        }
      }
      this._camPos.copy(this.camera.position);
      this._camT = nowM;
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
        if (this.debugViz) {
          this.updateVizTint();
          this.updateVizRings();
        }
      }
    }

    // Long-frame forensics: correlate every spike with streamer activity so
    // "LOD tanks my fps" is verifiable frame by frame.
    if (this.debugLOD && this._frameWorstNow > 33) {
      const s = this.streamer;
      console.log(
        `[perf] ${this._frameWorstNow.toFixed(0)}ms frame · ` +
          (s
            ? `lastUpload=tile ${s.lastUploadTile ?? "none"}@${s.lastUploadSize ?? "-"} ` +
              `${s.lastUploadAt ? Math.round(performance.now() - s.lastUploadAt) + "ms ago" : ""} · ` +
              `decoding=${s.decoding} queued=${s.uploadQueue.length}`
            : "no streamer")
      );
      this._frameWorstNow = 0;
    }

    this.renderer.render(this.scene, this.camera);
  }
}

new MeshExplorer();
