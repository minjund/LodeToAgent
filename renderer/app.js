"use strict";
window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};
window.LoadToAgentAppFactories.createCore = function createCore(context = {}) {
  const { $, $$, esc, uiLocale, providerLabel, reportRecoverableError } = window.LoadToAgentRendererUtils;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const observedText = (value) => window.LoadToAgentI18n.observedText(value);
  const PROJECTLESS_WORKSPACE = "__projectless__";
  const state = {
    providers: [],
    providerMap: new Map(),
    availability: {},
    workspaces: [],
    snapshot: null,
    rawSnapshot: null,
    activeRuns: [],
    versions: {},
    update: null,
    view: "all",
    providerFilters: new Set(),
    hiddenProviders: new Set(),
    workspace: "all",
    search: "",
    sort: "recent",
    selectedId: null,
    drawerTab: "chat",
    drawerMode: "session",
    runProvider: "claude",
    details: new Map(),
    detailLoadingIds: new Set(),
    drawerForceLatest: false,
    visibleLimit: 30,
    graphFocusId: null,
    graphExpandedProviders: new Set(),
    expandedCompletedSubagents: new Set(),
    expandedTmuxSubagents: new Set(),
    selectedRuntimeLoopId: null,
    tmuxFocus: null,
    agentCommandDrafts: new Map(),
    agentCommandTargets: new Map(),
    agentCommandSending: new Set(),
    stopRequests: new Set(),
    detailErrors: new Map(),
    guideCompleted: new Set(),
    guideExpanded: true,
    platform: { id: "win32", label: "Windows", localShell: "powershell", localShellLabel: t("terminal.windows_shell"), nativeTmux: false },
  };
  Object.defineProperty(state, "provider", {
    enumerable: true,
    get() {
      const selected = [...state.providerFilters];
      return selected.length === 0 ? "all" : selected.length === 1 ? selected[0] : "multiple";
    },
    set(value) {
      state.providerFilters.clear();
      if (value && value !== "all" && value !== "multiple") state.providerFilters.add(String(value));
    },
  });
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const motionState = {
    ready: false, modalTimer: 0, modalFocusTimer: 0, toastTimer: 0, drawerTimer: 0, drawerContentTimer: 0,
    drawerRenderKey: "", drawerTab: "", activeDialogTrigger: null, dialogGeneration: 0,
  };
  document.documentElement.dataset.motion = motionPreference.matches ? "reduced" : "full";
  motionPreference.addEventListener("change", (event) => {
    document.documentElement.dataset.motion = event.matches ? "reduced" : "full";
  });
  function captureMotionLayout() {
    const items = new Map();
    $$("[data-motion-key]").forEach((element) => {
      const key = element.dataset.motionKey;
      if (!key || items.has(key)) return;
      const rect = element.getBoundingClientRect();
      items.set(key, { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, value: element.dataset.motionValue || "" });
    });
    return items;
  }
  function motionEnterOffset(element, kind) {
    if (kind === "focus" || kind === "focus-back") {
      if (element.closest(".upstream-column")) return { x: -18, y: 0 };
      if (element.closest(".downstream-column")) return { x: 18, y: 0 };
    }
    if (kind === "view") return { x: 0, y: 14 };
    return { x: 0, y: 9 };
  }
  function playMotionLayout(previous, kind = "refresh") {
    const elements = $$("[data-motion-key]");
    document.documentElement.dataset.lastMotion = kind;
    if (!motionState.ready) {
      motionState.ready = true;
      return;
    }
    if (motionPreference.matches) return;
    requestAnimationFrame(() => {
      let entered = 0;
      elements.forEach((element) => {
        const key = element.dataset.motionKey;
        const before = previous.get(key);
        const after = element.getBoundingClientRect();
        if (before) {
          const dx = before.rect.left - after.left;
          const dy = before.rect.top - after.top;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            element.animate(
              [
                { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.82 },
                { transform: "translate(0, 0)", opacity: 1 },
              ],
              { duration: 440, easing: "cubic-bezier(.22, 1, .36, 1)" },
            );
          }
          if (before.value && before.value !== (element.dataset.motionValue || "")) {
            element.classList.add("motion-updated");
            element.addEventListener("animationend", () => element.classList.remove("motion-updated"), { once: true });
          }
          return;
        }
        const offset = motionEnterOffset(element, kind);
        element.animate(
          [
            { transform: `translate(${offset.x}px, ${offset.y}px) scale(.985)`, opacity: 0 },
            { transform: "translate(0, 0) scale(1)", opacity: 1 },
          ],
          { duration: 360, delay: Math.min(entered++, 8) * 28, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" },
        );
      });
    });
  }
  function animateVisibleSections() {
    if (motionPreference.matches) return;
    $$(".main-stage > section:not(.hidden)").forEach((section, index) => {
      section.classList.remove("motion-section-in");
      section.style.setProperty("--motion-section-delay", `${Math.min(index, 4) * 42}ms`);
      requestAnimationFrame(() => section.classList.add("motion-section-in"));
    });
  }
  const localizedLookup = (keys) => new Proxy(Object.create(null), {
    get: (_target, property) => keys[property] ? t(keys[property]) : undefined,
  });
  const STATUS = localizedLookup({
    starting: "ui.preparing", running: "ui.working", waiting: "app.nav.needs_review", idle: "ui.idle",
    completed: "ui.completed", failed: "ui.problem", cancelled: "ui.stopped",
  });
  const VIEW_TITLES = localizedLookup({
    all: "ui.recent_conversations_and_tasks", active: "ui.active_tasks", waiting: "ui.tasks_needing_review",
    runtime: "runtime.title", terminal: "app.nav.session_terminal", tmux: "app.nav.tmux", settings: "settings.title",
  });
  const VIEW_META_KEYS = {
    all: ["ui.ai_work_overview", "ui.see_all_ai_work_at_a_glance", "ui.active_work_and_items_needing_your_review_appear_first_find"],
    active: ["ui.active_now", "ui.see_which_ai_is_working_now", "ui.see_what_is_being_handled_then_open_a_task_for"],
    waiting: ["ui.your_turn", "ui.handle_items_that_need_your_review_first", "ui.only_tasks_waiting_for_your_response_or_choice_are_shown"],
    runtime: ["runtime.eyebrow", "runtime.title", "runtime.description"],
    terminal: ["ui.continue_an_existing_conversation", "ui.continue_ai_sessions_in_the_terminal", "ui.continue_the_same_task_with_its_previous_conversation_beside_the"],
    tmux: ["ui.advanced_work_tools", "ui.manage_multi_terminal_work_in_one_place", "ui.this_view_is_only_for_existing_tmux_workflows_home_and"],
    settings: ["ui.application_management", "ui.check_versions_and_updates", "ui.compare_the_installed_and_latest_stable_versions_then_download_a"],
  };
  const VIEW_META = new Proxy(Object.create(null), {
    get: (_target, property) => {
      const keys = VIEW_META_KEYS[property];
      return keys ? { eyebrow: t(keys[0]), title: t(keys[1]), subtitle: t(keys[2]) } : undefined;
    },
  });
  const GUIDE_STORAGE_KEY = "loadtoagent:start-guide:v1";
  const GUIDE_STEPS = ["create", "active", "waiting", "detail"];
  function loadGuideState() {
    try {
      const saved = JSON.parse(localStorage.getItem(GUIDE_STORAGE_KEY) || "{}");
      state.guideCompleted = new Set((saved.completed || []).filter((step) => GUIDE_STEPS.includes(step)));
      state.guideExpanded = saved.expanded !== false;
    } catch (error) {
      reportRecoverableError("guide-state-load", error);
      state.guideCompleted = new Set();
      state.guideExpanded = true;
    }
  }
  function saveGuideState() {
    try {
      localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ completed: [...state.guideCompleted], expanded: state.guideExpanded }));
    } catch (error) {
      reportRecoverableError("guide-state-save", error);
    }
  }
  function renderGuide() {
    const completed = state.guideCompleted.size;
    GUIDE_STEPS.forEach((step) => {
      const item = document.querySelector(`[data-guide-step="${step}"]`);
      const done = state.guideCompleted.has(step);
      item?.classList.toggle("completed", done);
      item?.querySelector("button")?.setAttribute("aria-pressed", done ? "true" : "false");
    });
    const percent = (completed / GUIDE_STEPS.length) * 100;
    $("#guideProgressBar").style.width = `${percent}%`;
    const progress = $(".guide-progress");
    progress.setAttribute("aria-valuenow", String(completed));
    $("#guideButtonProgress").textContent = completed === GUIDE_STEPS.length
      ? window.LoadToAgentI18n.t("ui.basics_completed")
      : window.LoadToAgentI18n.t("common.progress", { current: completed, total: GUIDE_STEPS.length });
    $("#guideProgressText").textContent =
      completed === GUIDE_STEPS.length
        ? window.LoadToAgentI18n.t("ui.you_completed_the_basics_you_can_reopen_this_guide_anytime")
        : window.LoadToAgentI18n.t("guide.steps_remaining", { count: GUIDE_STEPS.length - completed });
    $("#guideBtn").setAttribute("aria-expanded", state.guideExpanded ? "true" : "false");
  }
  function markGuideStep(step) {
    if (!GUIDE_STEPS.includes(step) || state.guideCompleted.has(step)) return;
    state.guideCompleted.add(step);
    saveGuideState();
    renderGuide();
  }
  function syncViewChrome() {
    const meta = VIEW_META[state.view] || VIEW_META.all;
    document.body.dataset.currentView = state.view;
    $("#pageEyebrow").textContent = meta.eyebrow;
    $("#pageTitle").textContent = meta.title;
    $("#pageSubtitle").textContent = meta.subtitle;
    document.title = `${VIEW_TITLES[state.view] || "LoadToAgent"} · LoadToAgent`;
    $$(".nav-item[data-view]").forEach((item) => {
      const active = item.dataset.view === state.view;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    const advancedView = ["terminal", "tmux", "settings"].includes(state.view);
    $("#mobileMoreBtn")?.classList.toggle("active", advancedView);
    if (advancedView) $("#mobileMoreBtn")?.setAttribute("aria-current", "page");
    else $("#mobileMoreBtn")?.removeAttribute("aria-current");
  }
  function selectView(view, options = {}) {
    state.view = view;
    state.visibleLimit = 30;
    if (view === "active" || view === "waiting") markGuideStep(view);
    syncViewChrome();
    context.renderSessions(options.motionKind || "view");
    $("#mobileToolsMenu")?.classList.add("hidden");
    $("#mobileMoreBtn")?.setAttribute("aria-expanded", "false");
    document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
    if (options.focusMain) $("#mainContent")?.focus({ preventScroll: true });
  }
  function currentDialog() {
    if (!$("#runModal").classList.contains("hidden")) return $("#runModal");
    if (!$("#tmuxCreateModal").classList.contains("hidden")) return $("#tmuxCreateModal");
    if ($("#detailDrawer").classList.contains("open")) return $("#detailDrawer");
    return null;
  }
  function dialogFocusable(dialog) {
    const selector = [
      "button:not([disabled])", "[href]", "input:not([disabled])", "select:not([disabled])",
      "textarea:not([disabled])", '[tabindex]:not([tabindex="-1"])',
    ].join(", ");
    return [...dialog.querySelectorAll(selector)].filter(
      (element) => !element.closest(".hidden") && !element.hidden && element.getClientRects().length,
    );
  }
  function trapDialogFocus(event) {
    if (event.key !== "Tab") return;
    const dialog = currentDialog();
    if (!dialog) return;
    const focusable = dialogFocusable(dialog);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }
  function rememberDialogTrigger() {
    motionState.dialogGeneration += 1;
    motionState.activeDialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  function restoreDialogTrigger(expectedGeneration = null) {
    if (expectedGeneration != null && expectedGeneration !== motionState.dialogGeneration) return false;
    const trigger = motionState.activeDialogTrigger;
    motionState.activeDialogTrigger = null;
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    return true;
  }
  window.LoadToAgentA11y = { rememberDialogTrigger, restoreDialogTrigger };
  function readablePreview(value, maxCharacters = 120) {
    const full = String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
    if (full.length <= maxCharacters) return { full, text: full, truncated: false };
    const sample = full.slice(0, maxCharacters + 1);
    const wordBoundary = sample.lastIndexOf(" ");
    const cut = wordBoundary >= Math.floor(maxCharacters * 0.72) ? wordBoundary : maxCharacters;
    return { full, text: `${sample.slice(0, cut).trimEnd()}…`, truncated: true };
  }
  function memoryCategoryLabel(value) {
    const keys = {
      insight: "content.memory.insight", convention: "content.memory.convention", failure: "content.memory.failure",
      decision: "content.memory.decision", pattern: "content.memory.pattern",
    };
    return keys[String(value || "").toLowerCase()] ? t(keys[String(value || "").toLowerCase()]) : String(value || t("content.memory.record"));
  }
  function jsonValueHtml(value, depth = 0) {
    if (value == null) return `<span class="json-empty">${esc(t("content.none"))}</span>`;
    if (typeof value === "boolean") return `<span class="json-primitive">${esc(t(value ? "content.yes" : "content.no"))}</span>`;
    if (typeof value === "number") return `<span class="json-primitive">${esc(value.toLocaleString(uiLocale()))}</span>`;
    if (typeof value === "string") return `<span class="json-string">${esc(value)}</span>`;
    if (depth >= 4) return `<span class="json-string">${esc(JSON.stringify(value))}</span>`;
    if (Array.isArray(value)) {
      const shown = value.slice(0, 40);
      const visibleItems = shown.map((item) => `<li>${jsonValueHtml(item, depth + 1)}</li>`).join("");
      const moreItems = value.length > shown.length ? `<li class="json-more">${esc(t("content.more_items", { count: value.length - shown.length }))}</li>` : "";
      return `<ol class="json-array">${visibleItems}${moreItems}</ol>`;
    }
    const entries = Object.entries(value).slice(0, 40);
    return `<dl class="json-object">${entries.map(([key, item]) => `<div><dt>${esc(key)}</dt><dd>${jsonValueHtml(item, depth + 1)}</dd></div>`).join("")}</dl>`;
  }
  function memoryCandidatesHtml(items) {
    return `<div class="memory-candidates">
      <div class="structured-heading">
      <b>${esc(t("content.memory.to_save"))}</b>
      <span>${esc(t("common.items", { count: items.length }))}</span>
      </div>${items
        .map(
          (item, index) => `<article class="memory-candidate">
      <header>
      <b>${index + 1}</b>
      <span class="memory-target">${esc(item.target || "MEMORY")}</span>
      <span class="memory-category">${esc(memoryCategoryLabel(item.category))}</span>
      </header>
      <p>${esc(item.content || t("content.empty"))}</p>
      </article>`,
        )
        .join("")}</div>`;
  }
  function inlineMarkdown(value) {
    return esc(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
  function markdownHtml(value) {
    const output = [];
    let fence = false;
    let code = [];
    let list = "";
    const closeList = () => {
      if (list) {
        output.push(`</${list}>`);
        list = "";
      }
    };
    for (const line of String(value || "")
      .replace(/\r\n/g, "\n")
      .split("\n")) {
      if (/^```/.test(line)) {
        closeList();
        if (fence) {
          output.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
          code = [];
          fence = false;
        } else fence = true;
        continue;
      }
      if (fence) {
        code.push(line);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || ordered) {
        const next = bullet ? "ul" : "ol";
        if (list !== next) {
          closeList();
          output.push(`<${next}>`);
          list = next;
        }
        output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
        continue;
      }
      closeList();
      if (!line.trim()) {
        output.push("<br>");
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) output.push(`<h${heading[1].length + 2}>${inlineMarkdown(heading[2])}</h${heading[1].length + 2}>`);
      else output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    closeList();
    if (fence) output.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    return `<div class="chat-content markdown">${output.join("")}</div>`;
  }
  function roadmapHtml(value) {
    const text = String(value || "").trim();
    const lines = text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const hasRoadmapSignal = /(?:로드맵|작업\s*계획|roadmap|implementation\s+plan|milestone|phase\s*\d+)/i.test(text);
    const steps = lines.filter((line) => /^(?:[-*]\s+|\d+[.)]\s+|#{2,3}\s+(?!로드맵|roadmap))/i.test(line));
    if (!hasRoadmapSignal || (text.length < 420 && steps.length < 6)) return "";
    const heading = lines.find((line) => /^#{1,3}\s+/.test(line));
    const title = readablePreview((heading || t("content.roadmap.title")).replace(/^#{1,3}\s+/, ""), 72).text;
    const previewSteps = (steps.length ? steps : lines.filter((line) => !/^#{1,3}\s+/.test(line)))
      .slice(0, 3)
      .map((line) => readablePreview(line.replace(/^(?:[-*]\s+|\d+[.)]\s+|#{2,3}\s+)/, "").replace(/\*\*/g, ""), 92).text);
    const countLabel = steps.length ? t("content.roadmap.steps", { count: steps.length }) : t("content.roadmap.long_plan");
    return `<details class="chat-roadmap" data-roadmap-collapsed="true">
      <summary>
      <span class="chat-roadmap-mark" aria-hidden="true">MAP</span>
      <span>
      <b>${esc(title)}</b>
      <small>${esc(t("content.roadmap.collapsed", { count: countLabel }))}</small>
      </span>
      <i aria-hidden="true">↓</i>
      </summary>
      <ol class="chat-roadmap-preview">${previewSteps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>
      <div class="chat-roadmap-full">${markdownHtml(text)}</div>
      </details>`;
  }
  function messageContentHtml(message) {
    const text = String((message && message.text) || "").trim();
    if (!text) return `<div class="chat-content empty">${esc(t("content.no_displayable_content"))}</div>`;
    if (/^[\[{]/.test(text) && /[\]}]$/.test(text)) {
      try {
        const parsed = JSON.parse(text);
        const isMemoryCandidate = (item) =>
          item && typeof item === "object" && "content" in item && ("target" in item || "category" in item);
        if (Array.isArray(parsed) && parsed.length && parsed.every(isMemoryCandidate)) {
          return memoryCandidatesHtml(parsed);
        }
        return `<div class="structured-json">
          <div class="structured-heading">
          <b>${esc(t("content.structured_data"))}</b>
          <span>${Array.isArray(parsed) ? esc(t("common.items", { count: parsed.length })) : "JSON"}</span>
          </div>${jsonValueHtml(parsed)}</div>`;
      } catch (_plainChatMessage) {
        // A normal chat message may begin with JSON punctuation without being JSON.
      }
    }
    const roadmap = message && message.role === "assistant" ? roadmapHtml(text) : "";
    if (roadmap) return roadmap;
    return markdownHtml(text);
  }
  function compact(value) {
    const n = Number(value || 0);
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
    return n.toLocaleString(uiLocale());
  }
  function fullNumber(value) {
    return Number(value || 0).toLocaleString(uiLocale());
  }
  function timeAgo(value) {
    const ms = Date.now() - Date.parse(value || 0);
    if (!Number.isFinite(ms)) return "-";
    if (ms < 8_000) return window.LoadToAgentI18n.t("time.just_now");
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return window.LoadToAgentI18n.t("time.seconds_ago", { count: sec });
    const min = Math.floor(sec / 60);
    if (min < 60) return window.LoadToAgentI18n.t("time.minutes_ago", { count: min });
    const hour = Math.floor(min / 60);
    if (hour < 24) return window.LoadToAgentI18n.t("time.hours_ago", { count: hour });
    const day = Math.floor(hour / 24);
    return day < 30 ? window.LoadToAgentI18n.t("time.days_ago", { count: day }) : new Date(value).toLocaleDateString(uiLocale());
  }
  function timeOnly(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function providerInfo(id) {
    return state.providerMap.get(id) || { id, label: providerLabel(id), company: "", accent: "#8fa2b7", mark: "AI", docs: "" };
  }
  function providerStyle(id) {
    return `--provider:${providerInfo(id).accent}`;
  }
  function agentRoleLabel(value) {
    const labels = {
      explorer: window.LoadToAgentI18n.t("ui.research"), reviewer: window.LoadToAgentI18n.t("ui.review"),
      worker: window.LoadToAgentI18n.t("ui.execution"), general: window.LoadToAgentI18n.t("ui.assistance"),
      planner: window.LoadToAgentI18n.t("ui.planning"), tester: window.LoadToAgentI18n.t("ui.testing"),
    };
    return labels[String(value || "").toLowerCase()] || String(value || window.LoadToAgentI18n.t("ui.assistance"));
  }
  function statusClass(status) {
    return ["running", "waiting", "completed", "failed", "cancelled"].includes(status) ? status : "";
  }
  function currentActivity(session) {
    const items = session.lifecycle || [];
    const running = isLiveSession(session) ? [...items].reverse().find((item) => item.status === "running") : null;
    const last = running || items[items.length - 1];
    if (last) {
      return {
        title: observedText(last.label || t("ui.activity")), detail: observedText(last.detail || session.statusDetail || ""), type: last.type || "activity",
      };
    }
    const message = (session.messages || [])[session.messages.length - 1];
    return { title: observedText(session.statusDetail || t("ui.temporarily_idle")), detail: observedText((message && message.text) || ""), type: "activity" };
  }
  function isLiveSession(session) {
    return session && (session.status === "running" || session.status === "starting");
  }
  function isRuntimeLoopSession(session) {
    if (!session || session.parentId || !isLiveSession(session)) return false;
    if (session.loop === true || (session.loop && typeof session.loop === "object")) return true;
    const ids = new Set([String(session.id || ""), String(session.externalId || "")].filter(Boolean));
    return (state.snapshot?.automations || []).some((automation) =>
      automation.enabled && automation.targetThreadId && ids.has(String(automation.targetThreadId)));
  }
  function subagentWorkState(session) {
    if (isLiveSession(session)) return "working";
    if (session && session.status === "failed") return "attention";
    return "resting";
  }
  function subagentWorkLabel(session) {
    const labels = {
      working: window.LoadToAgentI18n.t("ui.working"), resting: window.LoadToAgentI18n.t("ui.idle"),
      attention: window.LoadToAgentI18n.t("ui.needs_attention"),
    };
    return labels[subagentWorkState(session)];
  }
  function readableActivityDetail(value) {
    const text = String(value || "").trim();
    if (!text || !/^[\[{]/.test(text)) return text;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return text;
      if (parsed.cell_id) return t("activity.waiting_for_result", { wait: parsed.yield_time_ms ? t("activity.max_seconds", { count: Math.round(Number(parsed.yield_time_ms) / 1000) }) : "" });
      if (parsed.command) return t("activity.command", { value: String(parsed.command).replace(/\s+/g, " ").slice(0, 180) });
      if (parsed.path || parsed.file_path) return t("activity.file", { value: parsed.path || parsed.file_path });
      if (parsed.prompt) return t("activity.delegated", { value: String(parsed.prompt).replace(/\s+/g, " ").slice(0, 180) });
      const summary = Object.entries(parsed)
        .slice(0, 3)
        .map(([key, item]) => `${key}: ${typeof item === "object" ? t("activity.structured_data") : item}`)
        .join(" · ");
      return summary || text;
    } catch (_malformedCommandPreview) {
      // Command previews may be truncated while an agent is still writing them.
      return text;
    }
  }
  function latestWorkCopy(session) {
    const delegation = session.delegation || {};
    const completedResult = delegation.result || session.result;
    if (session.status === "completed" && completedResult) return t("activity.completed_result", { value: completedResult });
    if (session.status === "completed") return t("activity.completed_returned");
    const activity = currentActivity(session);
    if (activity.detail) return readableActivityDetail(activity.detail);
    const messages = session.messages || [];
    const assistant = [...messages].reverse().find((item) => item.role === "assistant" && item.text);
    if (assistant) return assistant.text;
    const tool = [...messages].reverse().find((item) => item.role === "tool");
    if (tool) return t("activity.tool_execution", { tool: tool.title || t("session.tool"), value: tool.text || t("activity.waiting_for_result_short") });
    return activity.title || session.statusDetail || t("activity.waiting_for_next");
  }
  function statusIcon(type) {
    if (/tool/.test(type)) return "⌘";
    if (/reason/.test(type)) return "◌";
    if (/error|fail/.test(type)) return "!";
    if (/start|turn/.test(type)) return "↗";
    if (/end|complete/.test(type)) return "✓";
    return "·";
  }
  return {
    $,
    $$,
    esc,
    uiLocale,
    providerLabel,
    reportRecoverableError,
    observedText,
    PROJECTLESS_WORKSPACE,
    state,
    motionPreference,
    motionState,
    STATUS,
    VIEW_TITLES,
    VIEW_META,
    GUIDE_STORAGE_KEY,
    GUIDE_STEPS,
    captureMotionLayout,
    motionEnterOffset,
    playMotionLayout,
    animateVisibleSections,
    loadGuideState,
    saveGuideState,
    renderGuide,
    markGuideStep,
    syncViewChrome,
    selectView,
    currentDialog,
    dialogFocusable,
    trapDialogFocus,
    rememberDialogTrigger,
    restoreDialogTrigger,
    readablePreview,
    memoryCategoryLabel,
    jsonValueHtml,
    memoryCandidatesHtml,
    inlineMarkdown,
    markdownHtml,
    roadmapHtml,
    messageContentHtml,
    compact,
    fullNumber,
    timeAgo,
    timeOnly,
    providerInfo,
    providerStyle,
    agentRoleLabel,
    statusClass,
    currentActivity,
    isLiveSession,
    isRuntimeLoopSession,
    subagentWorkState,
    subagentWorkLabel,
    readableActivityDetail,
    latestWorkCopy,
    statusIcon,
  };
};
