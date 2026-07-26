import { LABEL_CLASSES, CONFIDENCE_LEVELS } from "../Labels.js";
import { PaintTools } from "../PaintTools.js";

// Labeling UI: the commit sheet (class picker + confidence), the paint-tool
// wiring, the utilities menu (export / auto-tag / clear), the view-filter
// switcher, click-to-edit of an existing label, save, and the status-card
// list/coverage. Mixed onto MeshExplorer.prototype (`this` is the app).
export const labelingMixin = {
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
  },

  exitEditState() {
    if (this.editingLabelId && this.labels) {
      this.labels.setOverlayVisible(this.editingLabelId, true);
    }
    this.editingLabelId = null;
  },

  initLabelUI() {
    this.ui = {
      panel: document.getElementById("label-panel"),
      summary: document.getElementById("lp-summary"),
      classGrid: document.getElementById("lp-classgrid"),
      classPill: document.getElementById("lp-class"),
      classDot: document.getElementById("lp-class-dot"),
      className: document.getElementById("lp-class-name"),
      confBtn: document.getElementById("lp-conf"),
      confDot: document.getElementById("lp-conf-dot"),
      confName: document.getElementById("lp-conf-name"),
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

    // class picker lives in a popover; the pill in the bar opens it
    for (const cls of LABEL_CLASSES) {
      const b = document.createElement("button");
      b.className = "class-btn";
      b.dataset.cls = cls.id;
      b.style.setProperty("--chip", cls.color);
      b.textContent = cls.name;
      b.addEventListener("click", () => {
        this.pickClass(cls.id);
        this.ui.classGrid.classList.remove("open");
      });
      this.ui.classGrid.appendChild(b);
    }
    this.ui.classPill.addEventListener("click", () =>
      this.ui.classGrid.classList.toggle("open")
    );
    // confidence is a single pill that cycles confirmed → unsure → flagged
    this.ui.confBtn.addEventListener("click", () => {
      const order = CONFIDENCE_LEVELS.map((c) => c.id);
      const i = order.indexOf(this.pickedConfidence);
      this.pickConfidence(order[(i + 1) % order.length]);
    });

    // Paint tools: lasso (mouse) / brush (touch), add OR remove per intent.
    // Reads candidates live and applies hits through applyPaint.
    this.paint = new PaintTools({
      domElement: this.renderer.domElement,
      container: document.getElementById("canvas-container"),
      camera: this.camera,
      getCandidates: (intent) => this.paintCandidates(intent),
      onGestureStart: () => this.pushPendingHistory(),
      onApply: (intent, map) => this.applyPaint(intent, map),
      onBrush: (px, py, radius) => this.onBrush(px, py, radius),
      pickDepth: (px, py) => this.pickSurfaceDepth(px, py),
    });
    this.chrome.setupToolbar();

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
      this.reviewCtl.pendingDirty = false;
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
    // View switcher: overlays default OFF (clean mesh); user opts into a view.
    this.viewMode = "hidden";
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
  },

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
  },

  pickClass(id) {
    this.pickedClass = id;
    const cls = LABEL_CLASSES.find((c) => c.id === id);
    if (this.ui.classDot) this.ui.classDot.style.background = cls ? cls.color : "#fff";
    if (this.ui.className) this.ui.className.textContent = cls ? cls.name : id;
    for (const b of this.ui.classGrid.children) {
      b.classList.toggle("active", b.dataset.cls === id);
    }
  },

  pickConfidence(id) {
    this.pickedConfidence = id;
    const conf = CONFIDENCE_LEVELS.find((c) => c.id === id);
    if (this.ui.confDot) this.ui.confDot.style.background = conf ? conf.color : "#fff";
    if (this.ui.confName) this.ui.confName.textContent = conf ? conf.name : id;
  },

  showLabelPanel() {
    if (!this.ui || !this.pending) return;
    const p = this.pending;
    const editing = !!this.editingLabelId;
    this.ui.summary.textContent = `${p.faceCount.toLocaleString()} faces`;
    // Preselect the suggested class on a fresh selection; keep the user's
    // picks while they refine or edit an existing label.
    if (p.clicks === 1 && !editing) {
      this.pickClass(p.suggested);
      this.pickConfidence("confirmed");
    }
    this.ui.deleteBtn.style.display = editing ? "" : "none";
    this.ui.save.textContent = editing ? "Update" : "Save";
    this.ui.classGrid.classList.remove("open"); // bar first; picker on demand
    this.ui.panel.classList.add("active");
    this.chrome.showDock(true);
  },

  saveLabel() {
    if (!this.pending || !this.labels || !this.pickedClass) return;
    const wasEditing = !!this.editingLabelId;
    if (wasEditing) {
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
    // Reveal what was just tagged: if overlays are hidden, flip to Tagged so
    // the new label is visible (don't override a filter the user chose).
    if (this.mode === "explore" && this.viewMode === "hidden") {
      this.viewMode = "all";
      this.syncViewUI();
    }
    this.renderLabelList();
  },

  // The status card is now just a count + coverage + view filters (the big
  // per-label list is gone — it's noise during tagging). Mode toggle owns the
  // Explore/Review switch, so no Review button here.
  renderLabelList() {
    if (!this.ui || !this.labels) return;
    if (this.mode === "review") return; // review owns overlay visibility
    this.ui.card.classList.toggle("active", !this.pending);
    const labels = this.labels.list;
    this.ui.count.textContent = `${labels.length} label${labels.length === 1 ? "" : "s"}`;
    this.labels.applyView({ mode: this.viewMode, classId: this.isolatedClass });
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
    this.chrome.syncModeToggle();
  },
};
