import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LABEL_CLASSES } from "../Labels.js";
import { ReviewMode } from "../ReviewMode.js";

// Review-mode glue between the app and ReviewMode: arming each queued item as
// a live (editable) pending selection, the Adjust sub-mode, the review-sheet
// sync, the Confirm/Reclass verb interceptors, and entering/exiting review
// (orbit camera setup + ReviewMode wiring). Mixed onto MeshExplorer.prototype.
export const reviewMixin = {
  armReviewItem(item) {
    this.quietDisarm();
    const adjustBtn = document.getElementById("ra-adjust");
    if (!item) {
      this.reviewAdjust = false; // queue complete
      this.setReviewAdjusting(false);
      if (adjustBtn) adjustBtn.style.display = "none";
      return;
    }
    if (adjustBtn) adjustBtn.style.display = "";
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
    this.setReviewAdjusting(false); // each item starts as clean triage
  },

  // Toggle the editing sub-mode: reveals the shared tool bar + focus cluster
  // (floated above the review card) so a boundary can be tidied. Off by
  // default so a straight Confirm/Skip pass stays uncluttered.
  setReviewAdjusting(on) {
    this.reviewAdjusting = on;
    document.body.classList.toggle("adjusting", on);
    const btn = document.getElementById("ra-adjust");
    if (btn) btn.classList.toggle("active", on);
    this.showToolbar(on);
    this.showDock(on);
    if (!on) this.setTool("navigate"); // leaving adjust returns to orbit-only
  },

  quietDisarm() {
    this.setIntent("add"); // erase off for the next item; keep current tool
    if (this.controls && this.controls.orbitTarget) {
      this.controls.orbitTarget = null;
      this.controls.syncFromCamera();
    }
    // Don't force the previous item's overlay back on — ReviewMode.show() has
    // already set overlay visibility for the new item (only the current one),
    // and re-showing here leaves the just-skipped item highlighted in its tag
    // colour. Review's setOverlaysVisible / exit restore is the authority.
    this.editingLabelId = null;
    this.pending = null;
    this.pendingHistory = [];
    this.pendingDirty = false;
    if (this.selector) this.selector.clearHighlight();
    this.showDock(false);
  },

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
  },

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
  },

  // Class chip: clean = classic reclass verb (advance); dirty = just set the
  // class, it saves with the rest of the edit.
  handleReviewReclass(classId) {
    this.pickClass(classId);
    if (!this.pendingDirty) return false; // default reclass+advance
    this.updateReviewSheet();
    return true;
  },

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
          // one compact card; the shared tool bar is revealed only on Adjust.
          hud: document.getElementById("review-actions"),
          progress: document.getElementById("rh-progress"),
          klass: document.getElementById("rh-class"),
          classHero: document.getElementById("ra-class"),
          meta: document.getElementById("rh-meta"),
          exit: null, // no ✕ on the card; Explore/Review toggle exits
          actions: document.getElementById("review-actions"),
          reclass: document.getElementById("ra-reclass"),
          verbs: document.getElementById("ra-verbs"), // verb row, hidden on complete
          tools: null, // tool bar is the shared #toolbar, revealed via Adjust
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
    document.body.classList.add("review-mode"); // raises the tool bar above the verbs
    this.controls.enabled = false;
    this.orbit.enabled = true;
    this.setTool("navigate"); // orbit to inspect; pick a tool to adjust
    // Seed the orbit target with the current view direction so the first
    // frame doesn't snap toward a stale target.
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.orbit.target.copy(this.camera.position).addScaledVector(dir, 10);

    this.ui.card.classList.remove("active");
    document.getElementById("info").classList.remove("active");
    this.showToolbar(false); // tools stay hidden until Adjust
    this.syncModeToggle();

    if (!this.review.enter()) this.handleReviewExit();
  },

  handleReviewExit() {
    this.quietDisarm();
    this.reviewAdjust = false;
    this.reviewAdjusting = false;
    this.mode = "explore";
    document.body.classList.remove("review-mode", "adjusting");
    if (this.orbit) this.orbit.enabled = false;
    this.controls.enabled = true;
    this.controls.syncFromCamera();
    this.setTool("navigate"); // resets FP paintMode for explore
    this.showToolbar(true);
    this.syncModeToggle();
    this.renderLabelList();
  },
};
