import { worldArea } from "./Labels.js";

// Tier-0 auto-tagging: segment the whole mesh into coherent surface regions
// using the same flood fill as manual selection, classify each region with
// geometric priors (normal class + height above site) plus a colour check
// for vegetation, and store them as "flagged" (red) proposals. Humans then
// verify in review mode — the verify-don't-paint workflow.
//
// Results persist through LabelManager like any other label (that IS the
// cache: one run, restored on every reload). Re-run after detection tweaks
// by clearing source==="auto" labels first.

const MIN_FACES = 4; // regions smaller than this are noise (tree fragments)
const MIN_AREA = 0.25; // scene units² — filters slivers that pass the face gate
const MAX_AUTO_LABELS = 400; // draw-call / storage sanity cap
const COLOR_SAMPLE_FACES = 40;

function regionMeanColor(selector, selected) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  outer: for (const [mesh, faces] of selected) {
    for (const f of faces) {
      const c = selector.faceColor(mesh, f);
      if (c) {
        r += c[0];
        g += c[1];
        b += c[2];
        n++;
      }
      if (n >= COLOR_SAMPLE_FACES) break outer;
    }
  }
  return n ? [r / n, g / n, b / n] : null;
}

function isGreenish(c) {
  return c && c[1] > c[0] * 1.12 && c[1] > c[2] * 1.12;
}

export async function autoTag({
  selector,
  labels,
  root,
  onProgress,
  minFaces = MIN_FACES,
  minArea = MIN_AREA,
  maxLabels = MAX_AUTO_LABELS,
}) {
  selector.ensureGlobalGraph(root);
  const tiles = labels.tileMeshes;

  // visited[mesh][face] — seeded from existing labels so human work is
  // never overwritten and re-runs don't duplicate confirmed surfaces.
  const visited = new Map();
  for (const m of tiles) {
    visited.set(m, new Uint8Array(selector.ensureIntra(m).faceCount));
  }
  for (const label of labels.list) {
    for (const { t, df } of label.tiles) {
      const arr = visited.get(tiles[t]);
      if (!arr) continue;
      let acc = 0;
      for (const d of df) {
        acc += d;
        if (acc < arr.length) arr[acc] = 1;
      }
    }
  }

  let created = 0;
  let regions = 0;

  outer: for (let ti = 0; ti < tiles.length; ti++) {
    const mesh = tiles[ti];
    const arr = visited.get(mesh);

    for (let f = 0; f < arr.length; f++) {
      if (arr[f]) continue;

      const result = selector.select({ object: mesh, faceIndex: f }, root);
      if (!result || !result.totalSelected) {
        arr[f] = 1; // unclassifiable seed — never revisit
        continue;
      }

      // Claim only faces no earlier region took. select()'s per-seed normal
      // cone means two seeds can flood overlapping regions; without this the
      // labels would share triangles. First region to reach a face owns it.
      const claimed = new Map();
      let faceCount = 0;
      let area = 0;
      for (const [m, faces] of result.selected) {
        const va = visited.get(m);
        const fresh = new Set();
        for (const ff of faces) {
          if (va && va[ff]) continue; // already owned by an earlier region
          fresh.add(ff);
          if (va) va[ff] = 1;
        }
        if (fresh.size) {
          claimed.set(m, fresh);
          faceCount += fresh.size;
          area += worldArea(m, fresh);
        }
      }
      regions++;

      if (faceCount < minFaces || area < minArea) continue;

      let classId = labels.suggestFor({
        targetClass: result.targetClass,
        selected: claimed,
      });
      // Geometric priors can't tell a palm canopy from a roof — colour can.
      if (classId !== "building-wall" && isGreenish(regionMeanColor(selector, claimed))) {
        classId = "vegetation";
      }

      labels.add({
        selected: claimed,
        classId,
        confidence: "flagged", // red: machine proposal awaiting human review
        suggested: classId,
        targetClass: result.targetClass,
        source: "auto",
        deferPersist: true, // one persist at the end, not O(n²) serialization
      });
      created++;
      if (created >= maxLabels) break outer;
    }

    if (onProgress) onProgress(ti + 1, tiles.length, created);
    // Yield so the loading UI repaints between tiles.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  labels.persist();
  return { created, regions };
}
