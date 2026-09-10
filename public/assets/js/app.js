/* =========================================================================
   Clearcut — client application
   -------------------------------------------------------------------------
   The browser never sees an API key. It posts the image to /api/remove-background,
   a serverless function reads the key from encrypted environment variables and
   makes the upstream call, then streams the cutout back.
   ========================================================================= */
(() => {
  "use strict";

  /* ----------------------------- constants ----------------------------- */
  const MAX_DIMENSION = 2500;          // longest edge sent to the API
  const SOFT_MAX_BYTES = 6 * 1024 * 1024;
  const HARD_MAX_BYTES = 15 * 1024 * 1024;
  const MAX_QUEUE = 20;

  const ACCEPTED = /^image\/(png|jpe?g|webp|heic|heif)$/i;

  const SWATCHES = [
    { id: "transparent", label: "Transparent", transparent: true },
    { id: "#ffffff", label: "White" },
    { id: "#0c0e16", label: "Black" },
    { id: "#f1f5f9", label: "Light grey" },
    { id: "#e11d48", label: "Rose" },
    { id: "#f97316", label: "Orange" },
    { id: "#facc15", label: "Yellow" },
    { id: "#10b981", label: "Emerald" },
    { id: "#0ea5e9", label: "Sky" },
    { id: "#6366f1", label: "Indigo" },
    { id: "#8b5cf6", label: "Violet" },
    { id: "#f5d0c5", label: "Sand" },
  ];

  /* ------------------------------- state ------------------------------- */
  const state = {
    items: [],
    activeId: null,
    background: { type: "transparent", color: "#ffffff", bitmap: null, url: null },
    format: "png",
    compare: false,
    processing: false,
    config: { ready: true, mode: "live", maxUploadBytes: HARD_MAX_BYTES, rateLimitPerHour: 40 },
  };

  let seq = 0;

  /* ------------------------------- helpers ----------------------------- */
  const $ = (id) => document.getElementById(id);

  const el = {
    dropzone: $("dropzone"),
    fileInput: $("file-input"),
    pickBtn: $("pick-btn"),
    editor: $("editor"),
    stage: $("stage"),
    stageWrap: null,
    canvas: $("stage-canvas"),
    original: $("stage-original"),
    divider: $("compare-divider"),
    range: $("compare-range"),
    status: $("stage-status"),
    statusText: $("stage-status-text"),
    error: $("stage-error"),
    errorText: $("stage-error-text"),
    retryBtn: $("retry-btn"),
    compareToggle: $("compare-toggle"),
    stageMeta: $("stage-meta"),
    queue: $("queue"),
    queueList: $("queue-list"),
    queueAdd: $("queue-add"),
    swatches: $("swatches"),
    customColor: $("custom-color"),
    bgImageBtn: $("bg-image-btn"),
    bgImageInput: $("bg-image-input"),
    formatHint: $("format-hint"),
    downloadBtn: $("download-btn"),
    downloadAllBtn: $("download-all-btn"),
    resetBtn: $("reset-btn"),
    notice: $("notice"),
    toasts: $("toasts"),
  };
  el.stageWrap = el.canvas.parentElement;

  const ctx = el.canvas.getContext("2d");

  const activeItem = () => state.items.find((i) => i.id === state.activeId) || null;

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function baseName(name) {
    return (name || "image").replace(/\.[^.]+$/, "").slice(0, 60) || "image";
  }

  function toast(message, kind = "") {
    const node = document.createElement("div");
    node.className = `toast${kind ? ` is-${kind}` : ""}`;
    node.setAttribute("role", kind === "error" ? "alert" : "status");
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add("is-leaving");
      node.addEventListener("animationend", () => node.remove(), { once: true });
    }, kind === "error" ? 6000 : 3800);
  }

  function showNotice(message) {
    el.notice.textContent = message;
    el.notice.hidden = false;
  }

  /* ------------------------- image preprocessing ------------------------ */
  async function decode(blob) {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(blob);
      } catch {
        return null;
      }
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /**
   * Resize oversized images before upload. Keeps requests fast and well inside
   * the function timeout without a visible quality loss.
   */
  async function prepare(file) {
    const bitmap = await decode(file);
    if (!bitmap) {
      // Undecodable in this browser (often HEIC) — send the original and let
      // the API handle it. Comparison against the original is disabled.
      return { blob: file, decodable: false, width: 0, height: 0 };
    }

    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const oversized = longest > MAX_DIMENSION;
    const heavy = file.size > SOFT_MAX_BYTES;

    if (!oversized && !heavy) {
      bitmap.close?.();
      return { blob: file, decodable: true, width, height };
    }

    const scale = oversized ? MAX_DIMENSION / longest : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d");
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const keepPng = /png/i.test(file.type);
    let blob = await canvasToBlob(canvas, keepPng ? "image/png" : "image/jpeg", 0.92);

    // A re-encoded PNG can still be enormous — fall back to JPEG.
    if (blob && blob.size > SOFT_MAX_BYTES && keepPng) {
      blob = (await canvasToBlob(canvas, "image/jpeg", 0.92)) || blob;
    }

    return { blob: blob || file, decodable: true, width: w, height: h };
  }

  /* ---------------------------- file intake ---------------------------- */
  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    if (!state.config.ready) {
      toast("Background removal isn't available right now. Please try again later.", "error");
      return;
    }

    const room = MAX_QUEUE - state.items.length;
    if (room <= 0) {
      toast(`You can work on ${MAX_QUEUE} images at a time. Remove one to add another.`, "error");
      return;
    }

    const accepted = [];
    for (const file of files) {
      if (file.type && !ACCEPTED.test(file.type)) {
        toast(`“${file.name}” isn't a supported image type.`, "error");
        continue;
      }
      if (file.size > state.config.maxUploadBytes) {
        toast(`“${file.name}” is ${formatBytes(file.size)} — the limit is ${formatBytes(state.config.maxUploadBytes)}.`, "error");
        continue;
      }
      accepted.push(file);
    }

    const queued = accepted.slice(0, room);
    if (accepted.length > room) {
      toast(`Only the first ${room} image${room === 1 ? "" : "s"} were added.`);
    }
    if (!queued.length) return;

    for (const file of queued) {
      const item = {
        id: `item-${++seq}`,
        file,
        name: file.name || "image",
        status: "queued",
        error: null,
        cutout: null,
        sourceUrl: null,
        sourceOk: false,
        width: 0,
        height: 0,
      };
      state.items.push(item);
    }

    if (!state.activeId) state.activeId = state.items[0].id;

    showEditor();
    renderQueue();
    renderStage();
    runQueue();
  }

  /* ------------------------------ processing --------------------------- */
  async function runQueue() {
    if (state.processing) return;
    state.processing = true;

    try {
      while (true) {
        const item = state.items.find((i) => i.status === "queued");
        if (!item) break;
        await processItem(item);
      }
    } finally {
      state.processing = false;
      updateControls();
    }
  }

  async function processItem(item) {
    item.status = "working";
    renderQueue();
    if (item.id === state.activeId) renderStage();

    try {
      const prepared = await prepare(item.file);

      // Keep an object URL of exactly what we sent, so the before/after
      // comparison lines up pixel for pixel with the returned cutout.
      if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
      item.sourceUrl = URL.createObjectURL(prepared.blob);
      item.sourceOk = prepared.decodable;

      const form = new FormData();
      form.append("image", prepared.blob, item.name);

      const response = await fetch("/api/cutout", {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        let message = "Background removal failed. Please try again.";
        try {
          const payload = await response.json();
          if (payload?.error?.message) message = payload.error.message;
        } catch {
          /* non-JSON error body — keep the default message */
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const bitmap = await decode(blob);
      if (!bitmap) throw new Error("The result couldn't be displayed. Please try again.");

      item.cutout?.close?.();
      item.cutout = bitmap;
      item.width = bitmap.width;
      item.height = bitmap.height;
      item.status = "done";
      item.error = null;
      item.thumb = await makeThumb(bitmap);
    } catch (error) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : "Something went wrong.";
      // Surface it even when the user is looking at a different image in the queue.
      toast(state.items.length > 1 ? `${item.name}: ${item.error}` : item.error, "error");
    }

    renderQueue();
    if (item.id === state.activeId) renderStage();
    updateControls();
  }

  async function makeThumb(bitmap) {
    const size = 116;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext("2d");
    const scale = Math.max(size / bitmap.width, size / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    c.imageSmoothingQuality = "high";
    c.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL("image/png");
  }

  /* ------------------------------ rendering ---------------------------- */
  function drawCover(bitmap, w, h) {
    const scale = Math.max(w / bitmap.width, h / bitmap.height);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    ctx.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function composite(target, bitmap, background) {
    const c = target.getContext("2d");
    target.width = bitmap.width;
    target.height = bitmap.height;
    c.clearRect(0, 0, target.width, target.height);

    if (background.type === "color") {
      c.fillStyle = background.color;
      c.fillRect(0, 0, target.width, target.height);
    } else if (background.type === "image" && background.bitmap) {
      const scale = Math.max(target.width / background.bitmap.width, target.height / background.bitmap.height);
      const dw = background.bitmap.width * scale;
      const dh = background.bitmap.height * scale;
      c.drawImage(background.bitmap, (target.width - dw) / 2, (target.height - dh) / 2, dw, dh);
    }

    c.drawImage(bitmap, 0, 0);
  }

  function renderStage() {
    const item = activeItem();

    el.status.hidden = true;
    el.error.hidden = true;

    if (!item) {
      showDropzone();
      return;
    }

    if (item.status === "working" || item.status === "queued") {
      el.statusText.textContent =
        item.status === "queued" ? "Waiting in the queue…" : "Removing the background…";
      el.status.hidden = false;
    }

    if (item.status === "error") {
      el.errorText.textContent = item.error || "Something went wrong.";
      el.error.hidden = false;
    }

    if (item.cutout) {
      el.stageWrap.style.setProperty("--ar", `${item.width} / ${item.height}`);
      el.canvas.width = item.width;
      el.canvas.height = item.height;
      ctx.clearRect(0, 0, item.width, item.height);

      if (state.background.type === "color") {
        ctx.fillStyle = state.background.color;
        ctx.fillRect(0, 0, item.width, item.height);
      } else if (state.background.type === "image" && state.background.bitmap) {
        drawCover(state.background.bitmap, item.width, item.height);
      }
      ctx.drawImage(item.cutout, 0, 0);

      el.canvas.hidden = false;
      el.canvas.setAttribute("aria-label", `${item.name} with the background removed`);
      el.stageMeta.textContent = `${item.width} × ${item.height} px`;
    } else {
      el.canvas.hidden = true;
      el.stageMeta.textContent = "";
    }

    // Original layer for the comparison view
    if (item.sourceUrl && item.sourceOk) {
      if (el.original.dataset.for !== item.id) {
        el.original.dataset.for = item.id;
        el.original.src = item.sourceUrl;
        el.original.alt = `${item.name}, original`;
      }
    } else {
      el.original.removeAttribute("src");
      el.original.dataset.for = "";
    }

    applyCompare();
    updateControls();
  }

  function applyCompare() {
    const item = activeItem();
    const possible = Boolean(item && item.cutout && item.sourceOk && item.sourceUrl);
    const on = state.compare && possible;

    el.stage.dataset.compare = on ? "on" : "off";
    el.original.hidden = !on;
    el.divider.hidden = !on;
    el.range.hidden = !on;
    el.compareToggle.setAttribute("aria-pressed", String(on));
    el.compareToggle.disabled = !possible;
    el.compareToggle.hidden = !possible;
  }

  function renderQueue() {
    const multiple = state.items.length > 1;
    el.queue.hidden = !multiple;
    el.downloadAllBtn.hidden = !multiple;

    if (!multiple) {
      el.queueList.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const item of state.items) {
      const li = document.createElement("li");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "queue-item";
      button.dataset.id = item.id;
      button.title = item.name;
      button.setAttribute("aria-label", `Show ${item.name}`);
      if (item.id === state.activeId) {
        button.classList.add("is-active");
        button.setAttribute("aria-current", "true");
      }
      if (item.status === "working" || item.status === "queued") button.classList.add("is-busy");
      if (item.status === "error") button.classList.add("is-error");

      if (item.thumb) {
        const img = document.createElement("img");
        img.src = item.thumb;
        img.alt = "";
        button.appendChild(img);
      }

      const remove = document.createElement("span");
      remove.className = "queue-remove";
      remove.dataset.remove = item.id;
      remove.setAttribute("role", "button");
      remove.setAttribute("tabindex", "0");
      remove.setAttribute("aria-label", `Remove ${item.name}`);
      remove.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
      button.appendChild(remove);

      li.appendChild(button);
      fragment.appendChild(li);
    }

    el.queueList.replaceChildren(fragment);
  }

  function updateControls() {
    const item = activeItem();
    const ready = Boolean(item && item.cutout);
    el.downloadBtn.disabled = !ready;

    const done = state.items.filter((i) => i.cutout).length;
    el.downloadAllBtn.disabled = done === 0;
    el.downloadAllBtn.textContent = done > 1 ? `Download all (${done})` : "Download all";

    // Format hint
    if (state.format === "jpeg") {
      el.formatHint.textContent =
        state.background.type === "transparent"
          ? "JPG can't hold transparency — the background will be exported as white."
          : "Flattened JPG, smaller file. Good for the web.";
    } else {
      el.formatHint.textContent =
        state.background.type === "transparent"
          ? "Transparent background, best for logos and product shots."
          : "PNG with your chosen background, lossless quality.";
    }
  }

  function showEditor() {
    el.dropzone.hidden = true;
    el.editor.hidden = false;
    revealStudio();
  }

  /** Bring the result into view — on a phone the editor sits below the fold. */
  function revealStudio() {
    const studio = document.getElementById("studio");
    if (!studio) return;
    const { top } = studio.getBoundingClientRect();
    const header = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h"), 10) || 68;
    if (top >= header && top <= window.innerHeight * 0.4) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    studio.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }

  function showDropzone() {
    el.editor.hidden = true;
    el.dropzone.hidden = false;
  }

  /* ----------------------------- backgrounds --------------------------- */
  function buildSwatches() {
    const fragment = document.createDocumentFragment();

    for (const swatch of SWATCHES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `swatch${swatch.transparent ? " is-transparent" : ""}`;
      button.dataset.value = swatch.id;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(swatch.id === "transparent"));
      button.setAttribute("aria-label", swatch.label);
      button.title = swatch.label;
      if (!swatch.transparent) button.style.setProperty("--sw", swatch.id);
      fragment.appendChild(button);
    }

    el.swatches.replaceChildren(fragment);
  }

  function setBackground(next) {
    state.background = { ...state.background, ...next };

    for (const button of el.swatches.querySelectorAll(".swatch")) {
      const matches =
        state.background.type === "transparent"
          ? button.dataset.value === "transparent"
          : state.background.type === "color" && button.dataset.value === state.background.color;
      button.setAttribute("aria-checked", String(matches));
    }

    renderStage();
  }

  /* ------------------------------ downloads ---------------------------- */
  async function exportItem(item) {
    const canvas = document.createElement("canvas");
    const background =
      state.format === "jpeg" && state.background.type === "transparent"
        ? { type: "color", color: "#ffffff" }
        : state.background;

    composite(canvas, item.cutout, background);

    const type = state.format === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await canvasToBlob(canvas, type, 0.92);
    if (!blob) throw new Error("Export failed.");

    return { blob, filename: `${baseName(item.name)}-clearcut.${state.format === "jpeg" ? "jpg" : "png"}` };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function downloadActive() {
    const item = activeItem();
    if (!item?.cutout) return;
    try {
      const { blob, filename } = await exportItem(item);
      saveBlob(blob, filename);
      toast(`Saved ${filename}`, "success");
    } catch {
      toast("The download failed. Please try again.", "error");
    }
  }

  async function downloadAll() {
    const items = state.items.filter((i) => i.cutout);
    if (!items.length) return;

    let saved = 0;
    for (const item of items) {
      try {
        const { blob, filename } = await exportItem(item);
        saveBlob(blob, filename);
        saved += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      } catch {
        /* skip the failures, report the total below */
      }
    }
    toast(`Saved ${saved} image${saved === 1 ? "" : "s"}.`, saved ? "success" : "error");
  }

  /* ------------------------------- events ------------------------------ */
  el.pickBtn.addEventListener("click", () => el.fileInput.click());
  el.queueAdd.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("click", (event) => {
    // The button has its own handler; clicking anywhere else opens the picker too.
    if (event.target.closest("button")) return;
    el.fileInput.click();
  });

  el.fileInput.addEventListener("change", () => {
    addFiles(el.fileInput.files);
    el.fileInput.value = "";
  });

  // Drag and drop over the whole page
  let dragDepth = 0;
  const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");

  window.addEventListener("dragenter", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    el.dropzone.dataset.state = "dragging";
  });
  window.addEventListener("dragover", (event) => {
    if (isFileDrag(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", (event) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropzone.dataset.state = "idle";
  });
  window.addEventListener("drop", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    el.dropzone.dataset.state = "idle";
    addFiles(event.dataTransfer.files);
  });

  // Paste from clipboard
  window.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });

  // Queue interaction
  el.queueList.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      event.stopPropagation();
      removeItem(remove.dataset.remove);
      return;
    }
    const button = event.target.closest(".queue-item");
    if (button) selectItem(button.dataset.id);
  });
  el.queueList.addEventListener("keydown", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (remove && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopPropagation();
      removeItem(remove.dataset.remove);
    }
  });

  function selectItem(id) {
    if (!id || id === state.activeId) return;
    state.activeId = id;
    renderQueue();
    renderStage();
  }

  function removeItem(id) {
    const index = state.items.findIndex((i) => i.id === id);
    if (index === -1) return;

    const [item] = state.items.splice(index, 1);
    item.cutout?.close?.();
    if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);

    if (state.activeId === id) {
      state.activeId = state.items[Math.min(index, state.items.length - 1)]?.id || null;
    }

    if (!state.items.length) {
      resetAll();
      return;
    }

    renderQueue();
    renderStage();
  }

  // Background controls
  el.swatches.addEventListener("click", (event) => {
    const button = event.target.closest(".swatch");
    if (!button) return;
    const value = button.dataset.value;
    if (value === "transparent") setBackground({ type: "transparent" });
    else setBackground({ type: "color", color: value });
  });

  el.customColor.addEventListener("input", () => {
    setBackground({ type: "color", color: el.customColor.value });
  });

  el.bgImageBtn.addEventListener("click", () => el.bgImageInput.click());
  el.bgImageInput.addEventListener("change", async () => {
    const file = el.bgImageInput.files?.[0];
    el.bgImageInput.value = "";
    if (!file) return;

    const bitmap = await decode(file);
    if (!bitmap) {
      toast("That background image couldn't be read.", "error");
      return;
    }
    state.background.bitmap?.close?.();
    setBackground({ type: "image", bitmap });
    toast("Background image applied.");
  });

  // Format
  for (const input of document.querySelectorAll('input[name="format"]')) {
    input.addEventListener("change", () => {
      state.format = input.value;
      updateControls();
    });
  }

  // Compare
  el.compareToggle.addEventListener("click", () => {
    state.compare = !state.compare;
    applyCompare();
  });
  el.range.addEventListener("input", () => {
    el.stageWrap.style.setProperty("--split", `${el.range.value}%`);
  });
  el.original.addEventListener("error", () => {
    const item = activeItem();
    if (item) item.sourceOk = false;
    applyCompare();
  });

  // Actions
  el.downloadBtn.addEventListener("click", downloadActive);
  el.downloadAllBtn.addEventListener("click", downloadAll);
  el.retryBtn.addEventListener("click", () => {
    const item = activeItem();
    if (!item) return;
    item.status = "queued";
    item.error = null;
    renderQueue();
    renderStage();
    runQueue();
  });
  el.resetBtn.addEventListener("click", resetAll);

  function resetAll() {
    for (const item of state.items) {
      item.cutout?.close?.();
      if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
    }
    state.items = [];
    state.activeId = null;
    state.compare = false;
    el.original.removeAttribute("src");
    el.original.dataset.for = "";
    renderQueue();
    showDropzone();
    updateControls();
  }

  // Header shadow on scroll
  const header = document.querySelector(".site-header");
  const onScroll = () => header.classList.toggle("is-stuck", window.scrollY > 4);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ------------------------------ bootstrap ---------------------------- */
  buildSwatches();
  updateControls();

  fetch("/api/status")
    .then((response) => (response.ok ? response.json() : null))
    .then((config) => {
      if (!config) return;
      state.config = { ...state.config, ...config };

      if (!config.ready) {
        const missing = Array.isArray(config.missing) ? config.missing.filter(Boolean) : [];
        showNotice(
          missing.length
            ? `Background removal is unavailable: the server is missing ${missing.join(" and ")}. ` +
              "Add it in Netlify → Project configuration → Environment variables (scope: Functions), then redeploy."
            : "Background removal is temporarily unavailable — the service isn't configured.",
        );
      } else if (config.mode === "sandbox") {
        showNotice("Sandbox mode: results are watermarked test images and no credits are used.");
      }
    })
    .catch(() => {
      /* The status endpoint is a nicety; the app works without it. */
    });
})();
