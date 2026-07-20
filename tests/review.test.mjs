// Review mode: full base mesh stays visible, texture focus on the current
// item, prefetch on the next, queue ordering + verbs, storage roundtrip.
import * as THREE from "three";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
};
globalThis.alert = () => {};

const { HighResStreamer } = await import("../src/HighResStreamer.js");
const { LabelManager } = await import("../src/Labels.js");
const { ReviewMode } = await import("../src/ReviewMode.js");

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
};

function quadAt(x, y) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([x, y, 0, x + 1, y, 0, x + 1, y, 1, x, y, 1], 3)
  );
  geom.setIndex([0, 2, 1, 0, 3, 2]);
  return new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
}
const near = quadAt(0, 3); // tile 0
const far = quadAt(40, 0); // tile 1
const root = new THREE.Group();
root.add(near, far);
root.updateMatrixWorld(true);

const labels = new LabelManager({ scene: new THREE.Scene(), root, mapKey: "rv2" });
labels.add({
  selected: new Map([[far, new Set([0, 1])]]),
  classId: "ground",
  confidence: "unsure",
  suggested: "ground",
  targetClass: "roof-flat",
});
labels.add({
  selected: new Map([[near, new Set([0, 1])]]),
  classId: "building-roof",
  confidence: "unsure",
  suggested: "building-roof",
  targetClass: "roof-flat",
});

const camera = new THREE.PerspectiveCamera(75, 0.6, 0.1, 2000);
camera.position.set(0, 6, 6);
const orbit = { target: new THREE.Vector3(), update() {}, enabled: false };

const streamer = new HighResStreamer({
  scene: null,
  camera,
  gltfLoader: null,
  nativeSize: 1024,
  ringSize: 1024,
  nativeCap: 2,
  totalCap: 2,
});
streamer.active = true;
streamer.tilePitch = 40;
streamer.tiles = [near, far].map((lowMesh, i) => ({
  index: i,
  mesh: { visible: false },
  low: lowMesh,
  center: new THREE.Vector3(i * 40, 0, 0),
  bytes: {},
  mime: "image/webp",
  state: "low",
  size: 0,
  targetSize: 0,
  decoding: false,
  texture: null,
  wanted: false,
}));
streamer.promote = (t) => {
  t.state = "high";
  t.size = t.targetSize;
  streamer.applyTileVisibility(t);
};

const review = new ReviewMode({
  camera,
  orbit,
  labels,
  streamer,
  ui: null,
  onChange: () => {},
  onExit: () => {},
});

assert(review.enter() === true, "enter() succeeds");
assert(review.queue[0].label.class === "building-roof", "NN ordering: near item first");
assert(
  JSON.stringify(streamer.focusTiles) === "[0]" &&
    JSON.stringify(streamer.prefetchTiles) === "[1]",
  "focus/prefetch point at current/next item tiles"
);
for (const t of streamer.tiles) {
  assert(t.mesh.visible !== t.low.visible, `tile ${t.index} visible at exactly one LOD`);
}
assert(streamer.tiles[1].state === "high", "next item's texture prefetched");

review.correct();
assert(
  JSON.stringify(streamer.focusTiles) === "[1]" && streamer.prefetchTiles === null,
  "advance moves focus to next item"
);
assert(
  labels.list.find((l) => l.class === "building-roof").confidence === "confirmed",
  "Correct persists confirmed"
);

review.reclass("vegetation");
assert(review.index === review.queue.length, "queue complete");
assert(review.stats.confirmed === 1 && review.stats.reclassed === 1, "stats tallied");

review.exit();
assert(streamer.focusTiles === null, "exit returns streamer to gaze mode");

// no-streamer fallback (reset visibility first — streamer scenario above
// legitimately hid low meshes behind their promoted fakes)
streamer.active = false;
near.visible = true;
far.visible = true;
const review2 = new ReviewMode({ camera, orbit, labels, streamer: null, ui: null });
assert(review2.enter() === true, "enter() works with no streamer yet");
assert(near.visible && far.visible, "all base tiles remain visible without streamer");
review2.skip();
review2.skip();
review2.exit();

const labels2 = new LabelManager({ scene: new THREE.Scene(), root, mapKey: "rv2" });
labels2.restore();
assert(
  labels2.list.every((l) => l.confidence === "confirmed"),
  "review verdicts survived the storage roundtrip"
);

console.log("\nAll review-mode tests passed.");
