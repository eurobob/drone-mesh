import * as THREE from "three";

// Manual selection tidying, device-dependent by pointer type:
//   • mouse / pen  → LASSO: drag a freeform loop, release to remove every
//                    selected triangle whose centroid falls inside it.
//   • touch/finger → ERASE BRUSH: drag over triangles to rub them out live.
//
// Operates only on the CURRENT pending selection (a bounded face set), so
// it's a precision tidy tool, not a whole-mesh query. A 2D SVG overlay draws
// the lasso path / brush cursor; geometry is projected to screen per frame.
// The camera controller is expected to be disabled by the host while a paint
// tool is active, so pointer input is ours alone.

const BRUSH_RADIUS_PX = 26;

// Even-odd ray cast. poly: flat [x0,y0,x1,y1,...]; pt: [x,y] in the same px space.
export function pointInPolygon(pt, poly) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    const intersect =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export class PaintTools {
  // getCandidates(intent) → Map(mesh → Set(faceIdx)) the gesture may affect:
  //   "remove" → the current pending faces; "add" → visible unselected faces.
  // onApply(intent, map) applies the hit faces (host adds or removes).
  constructor({ domElement, container, camera, getCandidates, onGestureStart, onApply }) {
    this.domElement = domElement;
    this.camera = camera;
    this.getCandidates = getCandidates;
    this.onGestureStart = onGestureStart || (() => {});
    this.onApply = onApply || (() => {});

    this.tool = "tap"; // tap (off) | brush | lasso
    this.intent = "add"; // add | remove
    this.enabled = false;
    this.gesture = null;
    this._raf = null;
    this._movePt = null;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:800;overflow:visible;display:none;";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "rgba(24,160,255,0.15)");
    path.setAttribute("stroke", "#18a0ff");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-dasharray", "6 4");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", BRUSH_RADIUS_PX);
    circle.setAttribute("fill", "rgba(192,57,43,0.18)");
    circle.setAttribute("stroke", "#C0392B");
    circle.setAttribute("stroke-width", "2");
    circle.style.display = "none";
    svg.appendChild(path);
    svg.appendChild(circle);
    container.appendChild(svg);
    this.svg = svg;
    this.path = path;
    this.circle = circle;

    this._onDown = (e) => this.onPointerDown(e);
    this._onMove = (e) => this.onPointerMove(e);
    this._onUp = (e) => this.onPointerUp(e);
    domElement.addEventListener("pointerdown", this._onDown);
    domElement.addEventListener("pointermove", this._onMove);
    domElement.addEventListener("pointerup", this._onUp);
    domElement.addEventListener("pointercancel", this._onUp);
  }

  // tool: "tap" disables painting (host click handler drives selection);
  // "brush"/"lasso" enable the pointer overlay.
  setTool(tool) {
    this.tool = tool;
    this.enabled = tool === "brush" || tool === "lasso";
    this.svg.style.display = this.enabled ? "block" : "none";
    if (!this.enabled) this.cancelGesture();
  }

  setIntent(intent) {
    this.intent = intent;
    const accent = intent === "add" ? "#18a0ff" : "#C0392B";
    this.path.setAttribute("stroke", accent);
    this.path.setAttribute(
      "fill",
      intent === "add" ? "rgba(24,160,255,0.15)" : "rgba(192,57,43,0.15)"
    );
    this.circle.setAttribute("stroke", accent);
    this.circle.setAttribute(
      "fill",
      intent === "add" ? "rgba(24,160,255,0.18)" : "rgba(192,57,43,0.18)"
    );
  }

  cancelGesture() {
    this.gesture = null;
    this.path.setAttribute("d", "");
    this.circle.style.display = "none";
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  rectPt(e) {
    const r = this.domElement.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top, r];
  }

  // Snapshot world-space centroids of the candidate faces for fast projection.
  snapshotFaces() {
    const faces = this.getCandidates(this.intent);
    const cx = [], cy = [], cz = [], meshRef = [], faceIdx = [];
    const v = new THREE.Vector3();
    if (faces) {
      for (const [mesh, set] of faces) {
        const pos = mesh.geometry.getAttribute("position");
        const index = mesh.geometry.index;
        for (const f of set) {
          let x = 0, y = 0, z = 0;
          for (let c = 0; c < 3; c++) {
            const vi = index ? index.getX(f * 3 + c) : f * 3 + c;
            v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
            x += v.x; y += v.y; z += v.z;
          }
          cx.push(x / 3); cy.push(y / 3); cz.push(z / 3);
          meshRef.push(mesh); faceIdx.push(f);
        }
      }
    }
    return { cx, cy, cz, meshRef, faceIdx, removed: new Set() };
  }

  onPointerDown(e) {
    if (!this.enabled) return;
    const snap = this.snapshotFaces();
    if (!snap.cx.length) return; // nothing to act on
    e.preventDefault();
    this.domElement.setPointerCapture?.(e.pointerId);
    this.onGestureStart();
    const [x, y] = this.rectPt(e);
    // The chosen tool wins; pointer type is a fallback if somehow unset.
    const mode = this.tool === "brush" || this.tool === "lasso"
      ? this.tool
      : e.pointerType === "touch" ? "brush" : "lasso";
    this.gesture = { mode, ...snap, points: [x, y] };
    if (mode === "brush") {
      this.circle.style.display = "";
      this.circle.setAttribute("cx", x);
      this.circle.setAttribute("cy", y);
      this.brushAt(x, y);
    }
  }

  onPointerMove(e) {
    if (!this.enabled || !this.gesture) return;
    e.preventDefault();
    const [x, y] = this.rectPt(e);
    this._movePt = [x, y];
    if (this._raf) return; // coalesce to one process per frame
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      const g = this.gesture;
      if (!g) return;
      const [mx, my] = this._movePt;
      if (g.mode === "brush") {
        this.circle.setAttribute("cx", mx);
        this.circle.setAttribute("cy", my);
        this.brushAt(mx, my);
      } else {
        g.points.push(mx, my);
        this.path.setAttribute("d", this.pathData(g.points));
      }
    });
  }

  onPointerUp(e) {
    if (!this.gesture) return;
    e.preventDefault?.();
    const g = this.gesture;
    if (g.mode === "lasso" && g.points.length >= 6) {
      const hit = new Map();
      const v = new THREE.Vector3();
      for (let i = 0; i < g.cx.length; i++) {
        if (g.removed.has(i)) continue;
        v.set(g.cx[i], g.cy[i], g.cz[i]).project(this.camera);
        if (v.z < -1 || v.z > 1) continue; // behind camera / clipped
        const sx = (v.x * 0.5 + 0.5) * this.domElement.clientWidth;
        const sy = (-v.y * 0.5 + 0.5) * this.domElement.clientHeight;
        if (pointInPolygon([sx, sy], g.points)) this.mark(hit, g, i);
      }
      if (hit.size) this.onApply(this.intent, hit);
    }
    this.cancelGesture();
  }

  // Brush: hit faces whose projected centroid is within the cursor radius.
  brushAt(px, py) {
    const g = this.gesture;
    const hit = new Map();
    const v = new THREE.Vector3();
    const r2 = BRUSH_RADIUS_PX * BRUSH_RADIUS_PX;
    const w = this.domElement.clientWidth;
    const h = this.domElement.clientHeight;
    for (let i = 0; i < g.cx.length; i++) {
      if (g.removed.has(i)) continue;
      v.set(g.cx[i], g.cy[i], g.cz[i]).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const dx = sx - px, dy = sy - py;
      if (dx * dx + dy * dy <= r2) this.mark(hit, g, i);
    }
    if (hit.size) this.onApply(this.intent, hit);
  }

  mark(hit, g, i) {
    g.removed.add(i); // "consumed this gesture", regardless of add/remove
    const mesh = g.meshRef[i];
    let s = hit.get(mesh);
    if (!s) { s = new Set(); hit.set(mesh, s); }
    s.add(g.faceIdx[i]);
  }

  pathData(pts) {
    let d = `M ${pts[0]} ${pts[1]}`;
    for (let i = 2; i < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
    return d + " Z";
  }
}
