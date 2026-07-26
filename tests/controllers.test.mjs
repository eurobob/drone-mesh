// Controller-glue coverage (the mixins) via the jsdom harness. These are the
// paths that previously only had manual smoke-testing: the pending-selection
// lifecycle, the label commit flow, tool/intent chrome sync, and the review
// state machine.
import { makeApp, wholeQuad, assert } from "./harness.mjs";

// --- labeling: commit flow -------------------------------------------------
{
  const { app, mesh, labels } = makeApp();

  app.applyPaint("add", wholeQuad(mesh)); // brush/lasso-style add with no prior pending
  assert(app.pending && app.pending.faceCount === 2, "applyPaint(add) starts a pending selection");
  assert(
    document.getElementById("label-panel").classList.contains("active"),
    "commit panel opens on a fresh selection"
  );

  app.pickClass("building-roof");
  app.pickConfidence("confirmed");
  assert(app.pickedClass === "building-roof", "pickClass records the chosen class");
  app.saveLabel();

  assert(labels.list.length === 1, "saveLabel persists one label");
  assert(labels.list[0].class === "building-roof", "saved label carries the picked class");
  assert(labels.list[0].confidence === "confirmed", "saved label carries the picked confidence");
  assert(app.pending === null, "pending clears after save");
  assert(
    document.getElementById("labels-count").textContent.startsWith("1 label"),
    "status card count updates"
  );
}

// --- selection lifecycle: undo + cancel ------------------------------------
{
  const { app, mesh } = makeApp();

  app.applyPaint("add", wholeQuad(mesh));
  assert(app.pending.faceCount === 2, "pending has both faces");

  app.pushPendingHistory();
  app.applyPaint("remove", new Map([[mesh, new Set([1])]]));
  assert(app.pending.faceCount === 1, "remove drops a face");

  app.undoPending();
  assert(app.pending.faceCount === 2, "undo restores the prior selection");

  app.cancelPendingSelection();
  assert(app.pending === null, "cancel clears the pending selection");
  assert(
    !document.getElementById("label-panel").classList.contains("active"),
    "cancel hides the commit panel"
  );
}

// --- chrome: intent + tool sync --------------------------------------------
{
  const { app } = makeApp({ editTool: "navigate" });

  app.setIntent("remove");
  assert(app.editIntent === "remove", "setIntent updates intent");
  assert(
    document.getElementById("toolbar").classList.contains("erasing"),
    "erase modifier reflected on the tool bar"
  );

  app.setTool("brush");
  assert(app.editTool === "brush", "setTool updates the active tool");
  assert(app.controls.paintMode === true, "brush locks the camera controller into paint mode");
  assert(
    document.querySelector('[data-tool="brush"]').classList.contains("active"),
    "brush button shows active in the tool bar"
  );
}

// --- review: enter, arm, adjust, dirty-save --------------------------------
{
  const { app, mesh, labels } = makeApp();
  labels.add({
    selected: wholeQuad(mesh),
    classId: "building-roof",
    confidence: "unsure",
    suggested: "building-roof",
    targetClass: "roof-flat",
  });

  app.enterReviewMode();
  assert(app.mode === "review", "enterReviewMode switches mode");
  assert(document.body.classList.contains("review-mode"), "review-mode body class set");
  assert(app.pending && app.pending.selected.size, "first queue item armed as a live pending selection");
  assert(app.reviewAdjust === true, "review item is armed for editing");

  app.setReviewAdjusting(true);
  assert(document.body.classList.contains("adjusting"), "Adjust reveals the editing tools (body.adjusting)");
  app.setReviewAdjusting(false);
  assert(!document.body.classList.contains("adjusting"), "leaving Adjust clears body.adjusting");

  // dirty edit → Confirm saves the reclass instead of running the plain verb
  app.pendingDirty = true;
  app.pickClass("ground");
  const handled = app.handleReviewConfirm();
  assert(handled === true, "dirty Confirm is handled as a save");
  assert(labels.list[0].class === "ground", "the reclass was saved to the label");
}

console.log("\nAll controller tests passed.");
