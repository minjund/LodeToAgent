"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createQualityEnhancements = function createQualityEnhancements(context = {}) {
  const t = (key, params) => window.WhiteboxI18n.t(key, params);
  const {
    $, state, rememberDialogTrigger, restoreDialogTrigger, setDialogOpenState, currentDialog,
    announce, selectView, openRunModal, performUiAction,
  } = context;
  const DASHBOARD_STORAGE_KEY = "whitebox:dashboard-preferences:v2";
  const RUN_DRAFT_STORAGE_KEY = "whitebox:run-draft:v2";
  const QUALITY_PREF_STORAGE_KEY = "whitebox:quality-preferences:v3";
  const DASHBOARD_VERSION = 2;
  const RUN_DRAFT_VERSION = 2;
  const QUALITY_PREF_VERSION = 3;
  const MAX_QUALITY_TEXT = 180;
  const CLAUDE_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
  const CLAUDE_WRITE_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions"]);
  let activeCommandIndex = 0;
  let visibleCommands = [];
  let quickFocusToken = null;
  let shortcutFocusToken = null;
  let qualityMutationFrame = 0;
  let runDraftTimer = 0;
  const pendingQualityRoots = new Set();
  let qualityGuardsInstalled = false;

  function safeParse(storage, key) {
    try {
      const value = JSON.parse(storage.getItem(key) || "null");
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (error) {
      window.WhiteboxRendererUtils.reportRecoverableError(`quality-storage-${key}`, error);
      return null;
    }
  }

  function normalizedSearch(value) {
    return String(value || "").slice(0, 240).replace(/\s+/g, " ").trim();
  }

  function qualityText(value, limit = MAX_QUALITY_TEXT) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function normalizedRunCreationOptions(value = {}) {
    const provider = String(value.provider || "").trim().toLowerCase().slice(0, 40);
    const sourcePluginId = /^(?:direct|builtin\.(?:omo|aside))$/.test(String(value.sourcePluginId || "direct"))
      ? String(value.sourcePluginId || "direct") : "direct";
    const directClaude = sourcePluginId === "direct" && provider === "claude";
    const permissionMode = directClaude && CLAUDE_PERMISSION_MODES.has(value.permissionMode)
      ? value.permissionMode
      : "";
    return [
      sourcePluginId,
      provider,
      String(value.cwd || "").trim().slice(0, 2_000),
      String(value.model || "").trim().slice(0, 160),
      String(value.prompt || "").trim().slice(0, 8_000),
      directClaude ? CLAUDE_WRITE_PERMISSION_MODES.has(permissionMode) : Boolean(value.allowWrites),
      permissionMode,
    ];
  }

  function runCreationFingerprint(value = {}) {
    const input = JSON.stringify(normalizedRunCreationOptions(value));
    const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    const primes = [0x01000193, 0x27d4eb2d, 0x165667b1, 0x9e3779b1];
    for (const character of input) {
      const code = character.codePointAt(0);
      for (let index = 0; index < hashes.length; index += 1) {
        hashes[index] = Math.imul(hashes[index] ^ code, primes[index]);
        hashes[index] ^= hashes[index] >>> 13;
      }
    }
    return `rc1:${hashes.map(hash => (hash >>> 0).toString(16).padStart(8, "0")).join("")}`;
  }

  function normalizedPendingCreation(value, expectedFingerprint = "") {
    const creationId = typeof value?.creationId === "string" ? value.creationId.trim() : "";
    const creationFingerprint = typeof value?.creationFingerprint === "string"
      ? value.creationFingerprint.trim().toLowerCase()
      : "";
    if (!/^[A-Za-z0-9:._-]{1,240}$/.test(creationId)
      || !/^rc1:[a-f0-9]{32}$/.test(creationFingerprint)
      || (expectedFingerprint && creationFingerprint !== expectedFingerprint)) return null;
    return { creationId, creationFingerprint };
  }

  function defaultQualityPreferences() {
    return {
      version: QUALITY_PREF_VERSION,
      inputModality: "pointer",
      reduceMotion: false,
      compactDensity: false,
      advancedRunOpen: false,
    };
  }

  function loadQualityPreferences() {
    const saved = safeParse(localStorage, QUALITY_PREF_STORAGE_KEY);
    const defaults = defaultQualityPreferences();
    state.qualityPreferences = saved?.version === QUALITY_PREF_VERSION ? {
      ...defaults,
      inputModality: saved.inputModality === "keyboard" ? "keyboard" : "pointer",
      reduceMotion: saved.reduceMotion === true,
      compactDensity: saved.compactDensity === true,
      advancedRunOpen: saved.advancedRunOpen === true,
    } : defaults;
    applyQualityPreferences();
  }

  function saveQualityPreferences() {
    const value = { ...defaultQualityPreferences(), ...(state.qualityPreferences || {}) };
    value.version = QUALITY_PREF_VERSION;
    try {
      localStorage.setItem(QUALITY_PREF_STORAGE_KEY, JSON.stringify(value));
    } catch (error) {
      window.WhiteboxRendererUtils.reportRecoverableError("quality-preferences-save", error);
    }
  }

  function applyQualityPreferences() {
    const preferences = state.qualityPreferences || defaultQualityPreferences();
    document.body.dataset.inputModality = preferences.inputModality === "keyboard" ? "keyboard" : "pointer";
    document.body.dataset.qualityMotion = preferences.reduceMotion ? "reduced" : "standard";
    document.body.dataset.qualityDensity = preferences.compactDensity ? "compact" : "comfortable";
    document.body.classList.toggle("quality-keyboard-mode", preferences.inputModality === "keyboard");
  }

  function loadQualityState() {
    const dashboard = safeParse(localStorage, DASHBOARD_STORAGE_KEY);
    if (dashboard?.version === DASHBOARD_VERSION) {
      state.search = normalizedSearch(dashboard.search);
      state.providerFilters = new Set(
        Array.isArray(dashboard.providers)
          ? dashboard.providers.filter((id) => typeof id === "string" && /^[a-z0-9_-]{1,40}$/i.test(id)).slice(0, 20)
          : [],
      );
      state.workspace = typeof dashboard.workspace === "string" && dashboard.workspace.length <= 2_000
        ? dashboard.workspace
        : "all";
      state.sort = ["recent", "tokens", "context"].includes(dashboard.sort) ? dashboard.sort : "recent";
      state.controlRoomSort = ["recent", "tokens", "context"].includes(dashboard.controlRoomSort) ? dashboard.controlRoomSort : "recent";
      state.sessionOrder = Array.isArray(dashboard.sessionOrder)
        ? dashboard.sessionOrder.filter(id => typeof id === "string" && id.length <= 500).slice(0, 1_000)
        : [];
      state.projectOrder = Array.isArray(dashboard.projectOrder)
        ? dashboard.projectOrder.filter(id => typeof id === "string" && id.length <= 2_000).slice(0, 1_000)
        : [];
    } else {
      state.search = "";
      state.providerFilters.clear();
      state.workspace = "all";
      state.sort = "recent";
      state.sessionOrder = [];
      state.projectOrder = [];
    }
    const search = $("#searchInput");
    if (search) search.value = state.search;
    const sort = $("#sortSelect");
    if (sort) sort.value = state.sort;
    loadQualityPreferences();

    const draft = safeParse(sessionStorage, RUN_DRAFT_STORAGE_KEY);
    if (draft?.version === RUN_DRAFT_VERSION) {
      const provider = typeof draft.provider === "string" && /^[a-z0-9_-]{1,40}$/i.test(draft.provider) ? draft.provider : "";
      const sourcePluginId = /^(?:direct|builtin\.(?:omo|aside))$/.test(String(draft.sourcePluginId || "direct")) ? String(draft.sourcePluginId || "direct") : "direct";
      const restoredDraft = {
        sourcePluginId,
        prompt: typeof draft.prompt === "string" ? draft.prompt.slice(0, 8_000) : "",
        cwd: typeof draft.cwd === "string" ? draft.cwd.slice(0, 2_000) : "",
        model: typeof draft.model === "string" ? draft.model.slice(0, 160) : "",
        allowWrites: draft.allowWrites === true,
        permissionMode: sourcePluginId === "direct" && provider === "claude" && CLAUDE_PERMISSION_MODES.has(draft.permissionMode)
          ? draft.permissionMode
          : sourcePluginId === "direct" && provider === "claude" && !Object.hasOwn(draft, "permissionMode") && draft.allowWrites === true
            ? "acceptEdits"
            : "",
        provider,
      };
      const pendingCreation = normalizedPendingCreation(draft, runCreationFingerprint(restoredDraft));
      state.runDraft = pendingCreation ? { ...restoredDraft, ...pendingCreation } : restoredDraft;
      if (state.runDraft.provider) state.runProvider = state.runDraft.provider;
      state.runSource = state.runDraft.sourcePluginId || "direct";
    } else state.runDraft = { sourcePluginId: "direct", prompt: "", cwd: "", model: "", allowWrites: false, permissionMode: "", provider: "" };
  }

  function saveDashboardPreferences() {
    const value = {
      version: DASHBOARD_VERSION,
      search: normalizedSearch(state.search),
      providers: [...state.providerFilters],
      workspace: String(state.workspace || "all").slice(0, 2_000),
      sort: ["recent", "tokens", "context"].includes(state.sort) ? state.sort : "recent",
      controlRoomSort: ["recent", "tokens", "context"].includes(state.controlRoomSort) ? state.controlRoomSort : "recent",
      sessionOrder: (state.sessionOrder || []).filter(id => typeof id === "string" && id.length <= 500).slice(0, 1_000),
      projectOrder: (state.projectOrder || []).filter(id => typeof id === "string" && id.length <= 2_000).slice(0, 1_000),
    };
    try {
      localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(value));
    } catch (error) {
      window.WhiteboxRendererUtils.reportRecoverableError("dashboard-preferences-save", error);
    }
  }

  function currentRunDraft() {
    const provider = String(state.runProvider || "").slice(0, 40);
    const directClaude = (state.runSource || "direct") === "direct" && provider === "claude";
    const permissionMode = directClaude && CLAUDE_PERMISSION_MODES.has($("#runClaudePermissionMode")?.value)
      ? $("#runClaudePermissionMode").value
      : "";
    const draft = {
      version: RUN_DRAFT_VERSION,
      sourcePluginId: state.runSource || "direct",
      prompt: $("#runPrompt")?.value.slice(0, 8_000) || "",
      cwd: $("#runCwd")?.value.slice(0, 2_000) || "",
      model: $("#runModel")?.value.slice(0, 160) || "",
      allowWrites: directClaude ? CLAUDE_WRITE_PERMISSION_MODES.has(permissionMode) : Boolean($("#allowWrites")?.checked),
      permissionMode,
      provider,
    };
    const pendingCreation = normalizedPendingCreation(
      state.runDraft,
      runCreationFingerprint(draft),
    );
    return pendingCreation ? { ...draft, ...pendingCreation } : draft;
  }

  function persistRunDraft(draft) {
    state.runDraft = { ...draft };
    try {
      sessionStorage.setItem(RUN_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (error) {
      window.WhiteboxRendererUtils.reportRecoverableError("run-draft-save", error);
    }
  }

  function saveRunDraft() {
    clearTimeout(runDraftTimer);
    runDraftTimer = 0;
    persistRunDraft(currentRunDraft());
  }

  function setPendingRunCreation(value = {}) {
    clearTimeout(runDraftTimer);
    runDraftTimer = 0;
    const draft = currentRunDraft();
    const pendingCreation = normalizedPendingCreation(value, runCreationFingerprint(draft));
    if (pendingCreation) Object.assign(draft, pendingCreation);
    else {
      delete draft.creationId;
      delete draft.creationFingerprint;
    }
    persistRunDraft(draft);
    return pendingCreation;
  }

  function clearPendingRunCreation() {
    clearTimeout(runDraftTimer);
    runDraftTimer = 0;
    const draft = currentRunDraft();
    delete draft.creationId;
    delete draft.creationFingerprint;
    persistRunDraft(draft);
  }

  function scheduleRunDraftSave() {
    clearTimeout(runDraftTimer);
    runDraftTimer = setTimeout(saveRunDraft, 250);
  }

  function restoreRunDraft() {
    const draft = state.runDraft || {};
    if ($("#runPrompt") && !$("#runPrompt").value) $("#runPrompt").value = draft.prompt || "";
    if ($("#runCwd") && !$("#runCwd").value) $("#runCwd").value = draft.cwd || "";
    if ($("#runModel") && !$("#runModel").value) $("#runModel").value = draft.model || "";
    if ($("#allowWrites")) $("#allowWrites").checked = Boolean(draft.allowWrites);
    if ($("#runClaudePermissionMode")) {
      const restoredMode = (draft.sourcePluginId || "direct") === "direct" && draft.provider === "claude" && CLAUDE_PERMISSION_MODES.has(draft.permissionMode)
        ? draft.permissionMode
        : "";
      $("#runClaudePermissionMode").value = restoredMode;
    }
    if (draft.provider) state.runProvider = draft.provider;
    if (/^(?:direct|builtin\.(?:omo|aside))$/.test(String(draft.sourcePluginId || ""))) state.runSource = draft.sourcePluginId;
  }

  function clearRunDraft(options = {}) {
    clearTimeout(runDraftTimer);
    runDraftTimer = 0;
    state.runDraft = { sourcePluginId: "direct", prompt: "", cwd: "", model: "", allowWrites: false, permissionMode: "", provider: "" };
    state.runSource = "direct";
    try {
      sessionStorage.removeItem(RUN_DRAFT_STORAGE_KEY);
    } catch (error) {
      window.WhiteboxRendererUtils.reportRecoverableError("run-draft-clear", error);
    }
    if ($("#runPrompt")) $("#runPrompt").value = "";
    if ($("#runCwd")) $("#runCwd").value = "";
    if ($("#runModel")) $("#runModel").value = "";
    if ($("#allowWrites")) $("#allowWrites").checked = false;
    if ($("#runClaudePermissionMode")) $("#runClaudePermissionMode").value = "";
    $("#runForm")?.querySelectorAll('[aria-invalid="true"]').forEach((element) => element.removeAttribute("aria-invalid"));
    $("#runError")?.classList.add("hidden");
    context.syncRunComposer?.();
    if (options.focus !== false) $("#runPrompt")?.focus();
    if (options.silent !== true) announce(t("quality.draft_cleared"));
  }

  function commandDefinitions() {
    return [
      ["all", "⌂", t("app.nav.home"), t("quality.command.view"), () => selectView("all", { focusMain: true })],
      ["active", "●", t("app.nav.active"), t("quality.command.view"), () => selectView("active", { focusMain: true })],
      ["waiting", "!", t("app.nav.needs_review"), t("quality.command.view"), () => selectView("waiting", { focusMain: true })],
      ["runtime", "↻", t("app.nav.runtime"), t("quality.command.view"), () => selectView("runtime", { focusMain: true })],
      ["tmux", "▦", t("app.nav.tmux"), t("quality.command.view"), () => selectView("tmux", { focusMain: true })],
      ["settings", "⚙", t("app.nav.settings"), t("quality.command.view"), () => selectView("settings", { focusMain: true })],
      ["new-task", "+", t("ui.new_ai_task"), t("quality.command.action"), () => openRunModal()],
      ["probe", "↻", t("ui.check_ai_connections_again"), t("quality.command.action"), () => $("#probeBtn")?.click()],
      ["workspace", "⌘", t("control.add_project"), t("quality.command.action"), () => $("#sidebarNewProjectBtn")?.click()],
      ["shortcuts", "?", t("quality.shortcuts.title"), t("quality.command.help"), () => openShortcutHelp()],
    ].map(([id, icon, label, group, run]) => ({ id, icon, label, group, run }));
  }

  function renderQuickCommands() {
    const input = $("#quickPaletteInput");
    const query = String(input?.value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    visibleCommands = commandDefinitions().filter((command) => `${command.label} ${command.group}`.toLocaleLowerCase().includes(query));
    activeCommandIndex = Math.max(0, Math.min(activeCommandIndex, visibleCommands.length - 1));
    const list = $("#quickPaletteList");
    list.innerHTML = visibleCommands.map((command, index) => `<button id="quick-command-${command.id}" type="button" role="option" aria-selected="${index === activeCommandIndex ? "true" : "false"}" tabindex="-1" data-quick-command="${command.id}" class="${index === activeCommandIndex ? "active" : ""}"><span aria-hidden="true">${command.icon}</span><b>${context.esc(command.label)}</b><small>${context.esc(command.group)}</small><i aria-hidden="true">↵</i></button>`).join("");
    const active = visibleCommands[activeCommandIndex];
    if (active) input?.setAttribute("aria-activedescendant", `quick-command-${active.id}`);
    else input?.removeAttribute("aria-activedescendant");
    const status = visibleCommands.length
      ? t("quality.quick_results", { count: visibleCommands.length })
      : t("quality.quick_empty");
    $("#quickPaletteStatus").textContent = status;
  }

  function openQuickPalette() {
    if (currentDialog?.()) return;
    if (!quickFocusToken) quickFocusToken = rememberDialogTrigger("quickPaletteModal");
    const modal = $("#quickPaletteModal");
    setDialogOpenState(modal, true);
    modal.classList.remove("hidden");
    $("#quickPaletteInput").value = "";
    activeCommandIndex = 0;
    renderQuickCommands();
    requestAnimationFrame(() => $("#quickPaletteInput")?.focus());
  }

  function closeQuickPalette() {
    const modal = $("#quickPaletteModal");
    if (modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    setDialogOpenState(modal, false);
    const focusToken = quickFocusToken;
    quickFocusToken = null;
    if (focusToken) restoreDialogTrigger(focusToken);
  }

  function executeQuickCommand(id) {
    const command = visibleCommands.find((item) => item.id === id) || commandDefinitions().find((item) => item.id === id);
    if (!command) return;
    closeQuickPalette();
    command.run();
  }

  function openShortcutHelp() {
    if (currentDialog?.()) return;
    if (!shortcutFocusToken) shortcutFocusToken = rememberDialogTrigger("shortcutHelpModal");
    const modal = $("#shortcutHelpModal");
    setDialogOpenState(modal, true);
    modal.classList.remove("hidden");
    requestAnimationFrame(() => $("#closeShortcutHelpBtn")?.focus());
  }

  function closeShortcutHelp() {
    const modal = $("#shortcutHelpModal");
    if (modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    setDialogOpenState(modal, false);
    const focusToken = shortcutFocusToken;
    shortcutFocusToken = null;
    if (focusToken) restoreDialogTrigger(focusToken);
  }

  async function copyText(value) {
    const text = String(value || "");
    if (!text) return false;
    try {
      if (window.whitebox?.writeClipboard) await window.whitebox.writeClipboard(text);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.className = "clipboard-fallback";
        document.body.append(area);
        area.select();
        const copied = document.execCommand("copy");
        area.remove();
        if (!copied) throw new Error("copy unavailable");
      }
      announce(t("quality.copy_success"));
      context.toast?.(t("quality.copy_success"));
      return true;
    } catch (error) {
      window.WhiteboxRendererUtils.reportRecoverableError("clipboard-copy", error);
      announce(t("quality.copy_failed"));
      context.toast?.(t("quality.copy_failed"));
      return false;
    }
  }

  function safeBackdrop(backdrop, close, separateSurface = null) {
    const pointerRoot = separateSurface ? document : backdrop;
    let press = null;
    let releaseTimer = 0;
    const updateMovement = (event) => {
      if (!press || press.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press.moved = true;
    };
    pointerRoot.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (separateSurface && backdrop.classList.contains("hidden"))) {
        press = null;
        return;
      }
      clearTimeout(releaseTimer);
      press = {
        pointerId: event.pointerId,
        startedOnBackdrop: event.target === backdrop,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
    }, Boolean(separateSurface));
    pointerRoot.addEventListener("pointermove", updateMovement, Boolean(separateSurface));
    pointerRoot.addEventListener("pointerup", (event) => {
      updateMovement(event);
      clearTimeout(releaseTimer);
      // Keep the press through the following click event, then discard it if
      // the pointerup did not produce a click on the backdrop.
      releaseTimer = setTimeout(() => { press = null; }, 0);
    }, Boolean(separateSurface));
    pointerRoot.addEventListener("pointercancel", () => {
      clearTimeout(releaseTimer);
      press = null;
    }, Boolean(separateSurface));
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) return;
      const directActivation = !press && event.detail === 0;
      const safePointerActivation = Boolean(press && press.startedOnBackdrop && !press.moved);
      clearTimeout(releaseTimer);
      press = null;
      if (directActivation || safePointerActivation) close();
    });
  }

  function markInputModality(mode) {
    const preferences = { ...defaultQualityPreferences(), ...(state.qualityPreferences || {}) };
    const next = mode === "keyboard" ? "keyboard" : "pointer";
    if (preferences.inputModality === next) return;
    preferences.inputModality = next;
    state.qualityPreferences = preferences;
    applyQualityPreferences();
  }

  function describeControl(control) {
    return qualityText(
      control.getAttribute("aria-label")
      || control.getAttribute("title")
      || control.textContent
      || control.getAttribute("data-i18n")
      || control.id
      || control.name,
    );
  }

  function enhanceControl(control) {
    if (!(control instanceof HTMLElement)) return;
    const firstEnhancement = control.dataset.qualityEnhanced !== "true";
    control.dataset.qualityEnhanced = "true";
    const label = describeControl(control);
    if (firstEnhancement && label && !control.getAttribute("aria-label") && control.matches(".icon-button, .top-icon-action, .close-button")) {
      control.setAttribute("aria-label", label);
    }
    if (firstEnhancement && label && !control.getAttribute("title") && control.scrollWidth > control.clientWidth) control.setAttribute("title", label);
    if (firstEnhancement && control.matches("button") && !control.getAttribute("type")) control.setAttribute("type", "button");
    if (control.matches("button, [role='button'], input, select, textarea")) {
      control.setAttribute("data-quality-control", "");
      if (control.matches("input[required], textarea[required], select[required]")) control.setAttribute("aria-required", "true");
    }
    if (control.matches("button, [role='button']")) {
      const rect = control.getBoundingClientRect?.();
      if (rect && (rect.width < 40 || rect.height < 40)) control.setAttribute("data-quality-touch-target", "padded");
    }
    if (control.matches(":disabled, [aria-disabled='true']")) {
      control.setAttribute("data-quality-disabled", "true");
      if (!control.getAttribute("aria-describedby")) control.setAttribute("data-quality-disabled-reason", t("quality.disabled_reason"));
    } else {
      control.removeAttribute("data-quality-disabled");
      control.removeAttribute("data-quality-disabled-reason");
    }
  }

  function enhanceQualityControls(root = document) {
    if (root instanceof HTMLElement && root.matches("button, [role='button'], input, select, textarea, summary, [tabindex]")) enhanceControl(root);
    root.querySelectorAll?.("button, [role='button'], input, select, textarea, summary, [tabindex]").forEach(enhanceControl);
  }

  function installQualityMutationObserver() {
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === "attributes") pendingQualityRoots.add(record.target);
        record.addedNodes?.forEach((node) => {
          if (node instanceof HTMLElement) pendingQualityRoots.add(node);
        });
      });
      cancelAnimationFrame(qualityMutationFrame);
      qualityMutationFrame = requestAnimationFrame(() => {
        const roots = [...pendingQualityRoots];
        pendingQualityRoots.clear();
        roots.forEach(enhanceQualityControls);
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "class", "title", "aria-label"] });
    return observer;
  }

  function installPressedStateMirrors() {
    document.addEventListener("pointerdown", (event) => {
      const control = event.target.closest?.("button, [role='button']");
      if (control) control.setAttribute("data-quality-pressed", "true");
    }, true);
    ["pointerup", "pointercancel", "pointerleave"].forEach((type) => {
      document.addEventListener(type, (event) => {
        const control = event.target.closest?.("button, [role='button']");
        if (control) control.removeAttribute("data-quality-pressed");
      }, true);
    });
    document.addEventListener("keydown", (event) => {
      if (![" ", "Enter"].includes(event.key)) return;
      const control = event.target.closest?.("button, [role='button']");
      if (control) control.setAttribute("data-quality-pressed", "true");
    }, true);
    document.addEventListener("keyup", (event) => {
      if (![" ", "Enter"].includes(event.key)) return;
      const control = event.target.closest?.("button, [role='button']");
      if (control) control.removeAttribute("data-quality-pressed");
    }, true);
  }

  function installFormRecovery() {
    document.addEventListener("input", (event) => {
      const field = event.target;
      if (!(field instanceof HTMLElement)) return;
      if (field.matches("[aria-invalid='true']") && qualityText(field.value || field.textContent)) field.removeAttribute("aria-invalid");
      const form = field.closest("form");
      const error = form?.querySelector(".form-error:not(.hidden)");
      if (error && qualityText(field.value || field.textContent)) error.classList.add("hidden");
    }, true);
    document.addEventListener("blur", (event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement)) return;
      if (field.matches("#runModel, #tmuxCreateName, #tmuxCreateCwd")) field.value = field.value.trim();
    }, true);
  }

  function installDetailsStateMemory() {
    const advanced = document.querySelector(".run-advanced");
    if (!advanced) return;
    advanced.open = Boolean(state.qualityPreferences?.advancedRunOpen);
    advanced.addEventListener("toggle", () => {
      state.qualityPreferences = { ...defaultQualityPreferences(), ...(state.qualityPreferences || {}), advancedRunOpen: advanced.open };
      saveQualityPreferences();
    });
  }

  function installOverflowTitles() {
    const refresh = () => {
      document.querySelectorAll("button, .nav-item, .meta-chip, .session-card h3, .terminal-session-card").forEach((element) => {
        const label = describeControl(element);
        if (label && element.scrollWidth > element.clientWidth && !element.getAttribute("title")) element.setAttribute("title", label);
      });
    };
    refresh();
    window.addEventListener("resize", refresh);
  }

  function installViewportSafetyClass() {
    const setViewport = () => {
      document.documentElement.dataset.qualityViewport = window.innerWidth < 760 ? "mobile" : window.innerWidth < 1120 ? "tablet" : "desktop";
    };
    setViewport();
    window.addEventListener("resize", setViewport);
  }

  function installGlobalQualityGuards() {
    if (qualityGuardsInstalled) return;
    qualityGuardsInstalled = true;
    enhanceQualityControls();
    installQualityMutationObserver();
    installPressedStateMirrors();
    installFormRecovery();
    installDetailsStateMemory();
    installOverflowTitles();
    installViewportSafetyClass();
    document.addEventListener("keydown", () => markInputModality("keyboard"), true);
    document.addEventListener("pointerdown", () => markInputModality("pointer"), true);
  }

  function bindQualityEvents() {
    installGlobalQualityGuards();
    $("#shortcutHelpBtn")?.addEventListener("click", openShortcutHelp);
    $("#closeShortcutHelpBtn")?.addEventListener("click", closeShortcutHelp);
    $("#closeQuickPaletteBtn")?.addEventListener("click", closeQuickPalette);
    safeBackdrop($("#quickPaletteModal"), closeQuickPalette);
    safeBackdrop($("#shortcutHelpModal"), closeShortcutHelp);
    $("#quickPaletteInput")?.addEventListener("input", () => {
      activeCommandIndex = 0;
      renderQuickCommands();
    });
    $("#quickPaletteInput")?.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const count = visibleCommands.length;
        if (!count) return;
        activeCommandIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : (activeCommandIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        renderQuickCommands();
        $("#quickPaletteList")?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && visibleCommands[activeCommandIndex]) {
        event.preventDefault();
        executeQuickCommand(visibleCommands[activeCommandIndex].id);
      }
    });
    $("#quickPaletteList")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-quick-command]");
      if (button) executeQuickCommand(button.dataset.quickCommand);
    });
    $("#clearRunDraftBtn")?.addEventListener("click", clearRunDraft);
    $("#runForm")?.addEventListener("input", scheduleRunDraftSave);
    $("#runForm")?.addEventListener("change", saveRunDraft);
    window.addEventListener("beforeunload", saveRunDraft);
    $("#emptyClearFiltersBtn")?.addEventListener("click", () => $("#resetFiltersBtn")?.click());
    document.addEventListener("keydown", (event) => {
      const editable = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable='true']"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if ($("#quickPaletteModal").classList.contains("hidden")) openQuickPalette();
        else closeQuickPalette();
        return;
      }
      if (!editable && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "?" && !currentDialog?.()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openShortcutHelp();
        return;
      }
      if (event.key !== "Escape") return;
      if (!$("#quickPaletteModal").classList.contains("hidden")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeQuickPalette();
      } else if (!$("#shortcutHelpModal").classList.contains("hidden")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeShortcutHelp();
      }
    }, true);
  }

  return {
    DASHBOARD_STORAGE_KEY,
    RUN_DRAFT_STORAGE_KEY,
    normalizedSearch,
    loadQualityState,
    saveDashboardPreferences,
    saveRunDraft,
    runCreationFingerprint,
    setPendingRunCreation,
    clearPendingRunCreation,
    restoreRunDraft,
    clearRunDraft,
    renderQuickCommands,
    openQuickPalette,
    closeQuickPalette,
    openShortcutHelp,
    closeShortcutHelp,
    copyText,
    safeBackdrop,
    bindQualityEvents,
    QUALITY_PREF_STORAGE_KEY,
    qualityText,
    defaultQualityPreferences,
    loadQualityPreferences,
    saveQualityPreferences,
    applyQualityPreferences,
    enhanceControl,
    enhanceQualityControls,
    installGlobalQualityGuards,
  };
};
