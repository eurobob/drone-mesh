// FirstPersonControls: nav collision clamping + two-finger twist-to-rotate.
// Importing the harness installs the jsdom globals the controls constructor
// needs (document / element listeners).
import { THREE, assert } from "./harness.mjs";
import { FirstPersonControls } from "../src/FirstPersonControls.js";

// A double-sided quad wall in the z = -5 plane (a ray down -Z hits it at 5u).
function makeWall(z) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-3, -3, z, 3, -3, z, 3, 3, z, -3, 3, z], 3)
  );
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

function makeControls() {
  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.3, 1200);
  const dom = document.createElement("canvas");
  return { fpc: new FirstPersonControls(camera, dom), camera };
}

// --- collision: nav can't cross geometry in the direction of travel --------
{
  const { fpc, camera } = makeControls();
  fpc.collider = makeWall(-5);
  fpc.collider.updateMatrixWorld(true);
  camera.position.set(0, 0, 0);

  fpc.moveBy(new THREE.Vector3(0, 0, -10)); // barrel toward the wall
  const stop = -5 + fpc.collideMargin; // ≈ -4.6
  assert(
    Math.abs(camera.position.z - stop) < 0.15,
    `forward move clamps a margin off the wall (z=${camera.position.z.toFixed(2)}, expect ~${stop})`
  );

  const zBlocked = camera.position.z;
  fpc.moveBy(new THREE.Vector3(0, 0, 10)); // retreat
  assert(camera.position.z > zBlocked + 9, "retreating away from the wall is unclamped");
}

// --- no collider → free movement (behavior preserved off-mesh) -------------
{
  const { fpc, camera } = makeControls();
  fpc.collider = null;
  camera.position.set(0, 0, 0);
  fpc.moveBy(new THREE.Vector3(0, 0, -10));
  assert(camera.position.z === -10, "no collider → move is unclamped");
}

// --- two-finger twist rotates heading (yaw / lon) --------------------------
{
  const { fpc } = makeControls();
  fpc.orbitTarget = null;
  fpc.lon = 0;
  const pd = () => {};
  // two fingers down (horizontal line)
  fpc.onTouchStart({
    preventDefault: pd,
    changedTouches: [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 300, clientY: 200 },
    ],
  });
  // twist: swing the second finger up so the finger-line angle changes
  fpc.onTouchMove({
    preventDefault: pd,
    changedTouches: [{ identifier: 2, clientX: 300, clientY: 120 }],
  });
  assert(fpc.lon !== 0, `twisting two fingers rotates heading (lon=${fpc.lon.toFixed(1)}°)`);
}

// --- twist is suppressed in orbit mode (grab-world pan owns two fingers) ----
{
  const { fpc } = makeControls();
  fpc.orbitTarget = new THREE.Vector3(0, 0, -5);
  fpc.lon = 0;
  const pd = () => {};
  fpc.onTouchStart({
    preventDefault: pd,
    changedTouches: [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 300, clientY: 200 },
    ],
  });
  fpc.onTouchMove({
    preventDefault: pd,
    changedTouches: [{ identifier: 2, clientX: 300, clientY: 120 }],
  });
  assert(fpc.lon === 0, "twist does not change lon in orbit mode");
}

console.log("\nAll controls tests passed.");
