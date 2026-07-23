"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDashboard = function createDashboard(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $,
    esc,
    uiLocale,
    PROJECTLESS_WORKSPACE,
    state,
    compact,
    providerStyle,
    visibleProviders = () => state.providers,
    visibleSessions = () => ((state.snapshot && state.snapshot.sessions) || []),
    isProviderVisible = () => true,
    isRuntimeLoopSession = () => false,
    isControlRoomSession = session => session?.status === "running" || session?.status === "starting",
  } = context;

  function displaySessions() {
    return visibleSessions().filter((session) => (
      typeof context.isRecentSession !== "function" || context.isRecentSession(session)
    ));
  }

  function renderProviderRail() {
    $("#providerRail").innerHTML = visibleProviders()
      .map((provider) => {
        const available = !!state.availability[provider.id];
        return `<div class="provider-rail-item ${available ? "connected" : ""}" style="${providerStyle(provider.id)}">
        <span class="provider-mini-mark">${esc(provider.mark)}</span><strong>${esc(provider.label)}</strong>
        <small>${available ? window.LoadToAgentI18n.t("ui.cli_found") : window.LoadToAgentI18n.t("ui.setup_required")}</small>
        <span class="connection-dot"></span>
      </div>`;
      })
      .join("");
  }

  function isProjectlessSession(session) {
    const cwd = session && (session.originCwd || session.cwd);
    if (!cwd) return true;
    if (typeof session.projectless === "boolean") return session.projectless;
    const normalized = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
    return session.provider === "codex" && session.clientKind === "codex-desktop" && /(?:^|\/)Documents\/Codex\/\d{4}-\d{2}-\d{2}\/new-chat$/i.test(normalized);
  }

  function sessionOriginPath(session) {
    return String(session && (session.originCwd || session.cwd) || "").trim();
  }

  function normalizedProjectPath(value) {
    return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  }

  function projectContainsPath(projectPath, candidatePath) {
    const project = normalizedProjectPath(projectPath);
    const candidate = normalizedProjectPath(candidatePath);
    return Boolean(project && candidate && (candidate === project || candidate.startsWith(`${project}/`)));
  }

  function projectName(projectPath) {
    const normalized = String(projectPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized.split("/").filter(Boolean).pop() || t("workspace.unknown");
  }

  function observedProjects(sessions = displaySessions().filter((session) => !session.parentId)) {
    const projects = new Map();
    const saved = state.workspaces.map((item) => ({ ...item, key: normalizedProjectPath(item.path) }));
    saved.forEach((item) => projects.set(item.key, { path: item.path, name: item.name || projectName(item.path), saved: true, count: 0 }));
    sessions.filter((session) => !session.parentId && !isProjectlessSession(session)).forEach((session) => {
      const originPath = sessionOriginPath(session);
      if (!originPath) return;
      const owner = saved
        .filter((item) => projectContainsPath(item.path, originPath))
        .sort((a, b) => b.key.length - a.key.length)[0];
      const path = owner ? owner.path : originPath;
      const key = normalizedProjectPath(path);
      const project = projects.get(key) || { path, name: projectName(path), saved: false, count: 0 };
      project.count += 1;
      project.lastActivityAt = !project.lastActivityAt || Date.parse(session.updatedAt || 0) > Date.parse(project.lastActivityAt || 0)
        ? session.updatedAt
        : project.lastActivityAt;
      projects.set(key, project);
    });
    const items = [...projects.values()];
    const duplicateNames = new Map();
    items.forEach((item) => duplicateNames.set(item.name.toLocaleLowerCase(), (duplicateNames.get(item.name.toLocaleLowerCase()) || 0) + 1));
    items.forEach((item) => {
      if (duplicateNames.get(item.name.toLocaleLowerCase()) < 2) return;
      const parts = String(item.path).replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
      item.name = parts.slice(-2).join("/") || item.name;
    });
    return items.sort((a, b) => Number(b.count || 0) - Number(a.count || 0)
      || Number(b.saved) - Number(a.saved)
      || String(a.name).localeCompare(String(b.name), uiLocale()));
  }

  function sessionWorkspaceLabel(session) {
    if (isProjectlessSession(session)) return t("ui.no_project");
    const originPath = sessionOriginPath(session);
    const owner = state.workspaces
      .filter((item) => projectContainsPath(item.path, originPath))
      .sort((a, b) => normalizedProjectPath(b.path).length - normalizedProjectPath(a.path).length)[0];
    return owner?.name || (session && session.workspace) || projectName(originPath);
  }

  function controlRoomProject(session) {
    if (isProjectlessSession(session)) return { key: PROJECTLESS_WORKSPACE, path: PROJECTLESS_WORKSPACE, label: t("control.other_projects") };
    const originPath = sessionOriginPath(session);
    const owner = state.workspaces
      .filter((item) => projectContainsPath(item.path, originPath))
      .sort((a, b) => normalizedProjectPath(b.path).length - normalizedProjectPath(a.path).length)[0];
    const path = owner?.path || originPath;
    return {
      key: normalizedProjectPath(path) || String(session?.workspace || session?.id || "unknown").toLocaleLowerCase(),
      path,
      label: owner?.name || (session && session.workspace) || projectName(originPath) || t("control.other_projects"),
    };
  }

  function matchesWorkspaceFilter(session) {
    if (state.workspace === "all") return true;
    if (state.workspace === PROJECTLESS_WORKSPACE) return isProjectlessSession(session);
    return !isProjectlessSession(session) && projectContainsPath(state.workspace, sessionOriginPath(session));
  }

  function renderWorkspaces() {
    const rootSessions = displaySessions().filter((session) => !session.parentId);
    const liveRootSessions = rootSessions.filter(isControlRoomSession);
    const projects = observedProjects(rootSessions);
    const savedProjectOrder = new Map(state.workspaces.map((workspace, index) => [normalizedProjectPath(workspace.path), index]));
    const liveProjects = observedProjects(liveRootSessions).sort((a, b) => {
      const aOrder = savedProjectOrder.get(normalizedProjectPath(a.path));
      const bOrder = savedProjectOrder.get(normalizedProjectPath(b.path));
      if (aOrder != null || bOrder != null) return (aOrder ?? Number.MAX_SAFE_INTEGER) - (bOrder ?? Number.MAX_SAFE_INTEGER);
      return Number(b.count || 0) - Number(a.count || 0) || String(a.name).localeCompare(String(b.name), uiLocale());
    });
    const projectlessCount = rootSessions.filter(isProjectlessSession).length;
    const liveProjectlessCount = liveRootSessions.filter(isProjectlessSession).length;
    const savedWorkspaceExists = state.workspace === "all"
      || (state.workspace === PROJECTLESS_WORKSPACE && projectlessCount > 0)
      || projects.some((project) => normalizedProjectPath(project.path) === normalizedProjectPath(state.workspace));
    if (!savedWorkspaceExists) state.workspace = "all";
    const projectButton = (item, compactClass = "") => `<button type="button" class="workspace-item observed-project ${compactClass} ${state.workspace === item.path ? "selected" : ""}"
      data-workspace="${esc(item.path)}" title="${esc(item.path)}"
      aria-label="${esc(t("project.filter_named", { name: item.name, count: item.count }))}"
      aria-pressed="${state.workspace === item.path ? "true" : "false"}">
      <strong>${esc(item.name)}</strong><small>${Number(item.count || 0)}</small>
      </button>`;
    const mobileHtml =
      `<button type="button" class="workspace-item ${state.workspace === "all" ? "selected" : ""}"
        data-workspace="all" aria-pressed="${state.workspace === "all" ? "true" : "false"}">
      <strong>${window.LoadToAgentI18n.t("project.all")}</strong><small>${rootSessions.length}</small>
      </button>` +
      (projectlessCount
        ? `<button type="button" class="workspace-item projectless ${state.workspace === PROJECTLESS_WORKSPACE ? "selected" : ""}"
          data-workspace="${PROJECTLESS_WORKSPACE}"
          title="${esc(window.LoadToAgentI18n.t("ui.session_not_linked_to_a_specific_project"))}"
          aria-pressed="${state.workspace === PROJECTLESS_WORKSPACE ? "true" : "false"}">
        <strong>${window.LoadToAgentI18n.t("ui.no_project")}</strong>
        <small>${projectlessCount}</small>
        </button>`
        : "") +
      projects.map((item) => item.saved ? `<div class="workspace-row">
        ${projectButton(item)}
        <button type="button" class="workspace-remove" data-remove-workspace="${esc(item.path)}"
          aria-label="${esc(t("workspace.remove_named", { name: item.name }))}"
          title="${esc(window.LoadToAgentI18n.t("ui.remove_from_list"))}">×</button>
        </div>` : projectButton(item)).join("") +
      (!projects.length && !projectlessCount ? `<div class="workspace-empty">${window.LoadToAgentI18n.t("project.empty")}</div>` : "");
    const desktopHtml =
      `<button type="button" class="workspace-item control-room-project-chip ${state.workspace === "all" ? "selected" : ""}"
        data-workspace="all" aria-pressed="${state.workspace === "all" ? "true" : "false"}">
      <strong>${esc(t("control.all_projects"))}</strong><small>${liveRootSessions.length}</small>
      </button>` +
      liveProjects.map((item) => projectButton(item, "control-room-project-chip")).join("") +
      (liveProjectlessCount
        ? `<button type="button" class="workspace-item projectless control-room-project-chip ${state.workspace === PROJECTLESS_WORKSPACE ? "selected" : ""}"
          data-workspace="${PROJECTLESS_WORKSPACE}" aria-pressed="${state.workspace === PROJECTLESS_WORKSPACE ? "true" : "false"}">
        <strong>${esc(t("control.other_projects"))}</strong><small>${liveProjectlessCount}</small>
        </button>`
        : "") +
      (!liveProjects.length && !liveProjectlessCount ? `<div class="workspace-empty">${window.LoadToAgentI18n.t("project.empty")}</div>` : "");
    const desktopList = $("#workspaceList");
    const mobileList = $("#mobileWorkspaceList");
    if (desktopList) {
      desktopList.innerHTML = desktopHtml;
      const updateProjectOverflow = () => {
        const overflowing = desktopList.scrollWidth > desktopList.clientWidth + 2;
        const scrolledEnd = desktopList.scrollLeft + desktopList.clientWidth >= desktopList.scrollWidth - 2;
        desktopList.classList.toggle("is-overflowing", overflowing);
        desktopList.classList.toggle("is-scrolled-end", overflowing && scrolledEnd);
      };
      if (desktopList.dataset.overflowBound !== "true") {
        desktopList.dataset.overflowBound = "true";
        desktopList.addEventListener("scroll", updateProjectOverflow, { passive: true });
        desktopList._overflowObserver = new ResizeObserver(updateProjectOverflow);
        desktopList._overflowObserver.observe(desktopList);
      }
      requestAnimationFrame(updateProjectOverflow);
    }
    if (mobileList) mobileList.innerHTML = mobileHtml;
    const projectSelect = $("#controlRoomProjectSelect");
    if (projectSelect) {
      projectSelect.innerHTML = `<option value="all">${esc(t("control.all_projects"))}</option>`
        + liveProjects.map((item) => `<option value="${esc(item.path)}">${esc(item.name)}</option>`).join("")
        + (liveProjectlessCount ? `<option value="${PROJECTLESS_WORKSPACE}">${esc(t("control.other_projects"))}</option>` : "");
      projectSelect.value = [...projectSelect.options].some((option) => option.value === state.workspace) ? state.workspace : "all";
    }
    const controlSort = $("#controlRoomSortSelect");
    if (controlSort) controlSort.value = state.controlRoomSort || "recent";
    const controlSearch = $("#controlRoomSearchInput");
    if (controlSearch && controlSearch.value !== state.search) controlSearch.value = state.search;
    $("#controlRoomSearch")?.classList.toggle("is-open", Boolean(state.search));
    $("#controlRoomSearchBtn")?.setAttribute("aria-expanded", state.search ? "true" : "false");
    if (controlSearch) {
      controlSearch.tabIndex = state.search ? 0 : -1;
      controlSearch.setAttribute("aria-hidden", state.search ? "false" : "true");
    }
    const selectedProject = projects.find((project) => normalizedProjectPath(project.path) === normalizedProjectPath(state.workspace));
    const mobileSummary = $("#mobileWorkspaceSummary");
    if (mobileSummary) mobileSummary.textContent = state.workspace === "all"
      ? t("project.all")
      : state.workspace === PROJECTLESS_WORKSPACE
        ? t("ui.no_project")
        : selectedProject?.name || projectName(state.workspace);
  }

  function renderGlobalStats() {
    const sessions = displaySessions();
    const totals = {
      active: sessions.filter((session) => session.status === "running" || session.status === "starting").length,
      waiting: sessions.filter((session) => context.matchesManagementFilter?.(session, "attention")).length,
      usage: { total: sessions.reduce((sum, session) => sum + Number(session.usage && session.usage.total || 0), 0) },
    };
    const rootCount = sessions.filter((session) => !session.parentId).length;
    const criticalCount = sessions.filter((session) => context.matchesManagementFilter?.(session, "critical")).length;
    const riskCount = sessions.filter((session) => context.matchesManagementFilter?.(session, "warning")).length;
    const items = [
      [window.LoadToAgentI18n.t("ui.all_tasks"), rootCount, window.LoadToAgentI18n.t("ui.items"), ""],
      [window.LoadToAgentI18n.t("ui.ai_working_now"), totals.active || 0, window.LoadToAgentI18n.t("ui.items"), "live"],
      [window.LoadToAgentI18n.t("management.action_required"), totals.waiting || 0, window.LoadToAgentI18n.t("ui.items"), "alert"],
      [window.LoadToAgentI18n.t("management.health.critical"), criticalCount, window.LoadToAgentI18n.t("ui.items"), "critical"],
      [window.LoadToAgentI18n.t("management.risk_total"), riskCount, window.LoadToAgentI18n.t("ui.items"), "warning"],
    ];
    $("#globalStats").innerHTML = items
      .map(
        ([label, value, unit, cls], index) => `<div class="global-stat ${cls}" data-motion-key="stat:${index}" data-motion-value="${esc(value)}">
      <span>${label}</span>
      <strong>${esc(value)}</strong>
      <em>${unit}</em>
      </div>`,
      )
      .join("");
    $("#navAllCount").textContent = rootCount;
    const activeRootCount = sessions.filter((session) => !session.parentId && isControlRoomSession(session)).length;
    $("#navActiveCount").textContent = activeRootCount;
    const reviewCount = sessions.filter((session) => context.needsManagementReview?.(session)).length;
    $("#navWaitingCount").textContent = reviewCount;
    const scheduledCount = (state.snapshot?.automations || [])
      .filter((item) => isProviderVisible(item.provider || "codex")).length;
    const loopCount = sessions.filter(isRuntimeLoopSession).length;
    $("#navRuntimeCount").textContent = scheduledCount + loopCount;
    const tmuxSessionCount = Number(state.snapshot?.tmux?.summary?.sessions || 0);
    $("#navTmuxCount").textContent = tmuxSessionCount;
    $("#advancedToolsCount").textContent = scheduledCount + loopCount + Number($("#navTerminalCount").textContent || 0) + tmuxSessionCount;
    const navCounts = {
      all: rootCount,
      active: activeRootCount,
      waiting: reviewCount,
      runtime: scheduledCount + loopCount,
      terminal: Number($("#navTerminalCount").textContent || 0),
      tmux: tmuxSessionCount,
    };
    document.querySelectorAll(".nav-item[data-view]").forEach((button) => {
      const key = {
        all: "app.nav.home", active: "app.nav.active", waiting: "app.nav.needs_review", runtime: "app.nav.runtime",
        terminal: "app.nav.session_terminal", tmux: "app.nav.tmux", settings: "app.nav.settings",
      }[button.dataset.view];
      const label = t(key);
      const count = navCounts[button.dataset.view];
      const unitKey = { all: "tasks", active: "tasks", waiting: "items", runtime: "runs", terminal: "sessions", tmux: "sessions" }[button.dataset.view];
      const unit = unitKey ? t(`quality.unit.${unitKey}`) : "";
      const accessibleLabel = Number.isFinite(count) ? t("quality.nav_count_detailed", { label, count, unit }) : label;
      button.setAttribute("aria-label", accessibleLabel);
      button.setAttribute("title", accessibleLabel);
    });
    const advancedCount = scheduledCount + loopCount + Number($("#navTerminalCount").textContent || 0) + tmuxSessionCount;
    $("#advancedToolsNav")?.querySelector("summary")?.setAttribute("aria-label", t("quality.nav_count_detailed", {
      label: t("management.advanced_tools"), count: advancedCount, unit: t("quality.unit.items"),
    }));
    const tmuxShortcut = $("#openTmuxFromAgentWork");
    $("#agentWorkTmuxCount").textContent = tmuxSessionCount;
    tmuxShortcut.dataset.i18nParams = JSON.stringify({ count: tmuxSessionCount });
    tmuxShortcut.setAttribute("aria-label", t("graph.open_tmux_workspace_count", { count: tmuxSessionCount }));
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value || 0));
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const amount = bytes / 1024 ** index;
    return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
  }

  function installationTypeLabel(value) {
    const labels = {
      desktop: window.LoadToAgentI18n.t("ui.desktop_installer"),
      npm: window.LoadToAgentI18n.t("ui.global_npm_installation"),
      source: window.LoadToAgentI18n.t("ui.local_development_build"),
    };
    return labels[value] || window.LoadToAgentI18n.t("ui.checking_installation_type");
  }

  function updatePresentation(update) {
    const status = (update && update.status) || "idle";
    const hasAsset = Boolean(update && update.asset);
    const labels = {
      idle: [
        "·", window.LoadToAgentI18n.t("ui.version_status"),
        window.LoadToAgentI18n.t("ui.ready_to_check_for_updates"), window.LoadToAgentI18n.t("ui.checks_the_latest_stable_github_release"),
      ],
      checking: [
        "↻", window.LoadToAgentI18n.t("ui.checking_latest_version"),
        window.LoadToAgentI18n.t("ui.checking_the_latest_version"), window.LoadToAgentI18n.t("ui.reading_the_latest_stable_github_release_tag"),
      ],
      current: [
        "✓",
        window.LoadToAgentI18n.t("ui.latest_version"),
        window.LoadToAgentI18n.t("ui.you_are_up_to_date"),
        window.LoadToAgentI18n.t("update.current_version", { version: (update && update.currentVersion) || "—" }),
      ],
      available: [
        "↟",
        window.LoadToAgentI18n.t("ui.update_available"),
        window.LoadToAgentI18n.t("update.version_available", { version: (update && update.latestVersion) || "—" }),
        hasAsset
          ? window.LoadToAgentI18n.t("ui.a_verified_installer_for_this_computer_can_be_downloaded_in")
          : window.LoadToAgentI18n.t("ui.the_release_exists_but_a_matching_installer_is_not_available"),
      ],
      downloading: [
        "↓", window.LoadToAgentI18n.t("ui.downloading"), window.LoadToAgentI18n.t("ui.downloading_the_update_file"),
        window.LoadToAgentI18n.t("ui.keep_the_app_open_until_the_download_finishes"),
      ],
      downloaded: [
        "✓", window.LoadToAgentI18n.t("ui.ready_to_install"), window.LoadToAgentI18n.t("ui.the_update_file_is_ready"),
        window.LoadToAgentI18n.t("settings.update.auto_install_restart"),
      ],
      error: [
        "!", window.LoadToAgentI18n.t("ui.check_failed"), window.LoadToAgentI18n.t("ui.could_not_check_for_updates"),
        window.LoadToAgentI18n.t("ui.check_your_internet_connection_and_try_again"),
      ],
      unsupported: [
        "—", window.LoadToAgentI18n.t("ui.manual_update"), window.LoadToAgentI18n.t("ui.this_operating_system_requires_a_manual_update"),
        window.LoadToAgentI18n.t("ui.get_the_latest_file_directly_from_github_releases"),
      ],
    };
    return labels[status] || labels.idle;
  }

  function renderUpdateSettings() {
    const update = state.update || { status: "idle", currentVersion: state.versions.app || "" };
    const [glyph, label, title, text] = updatePresentation(update);
    const available = ["available", "downloading", "downloaded"].includes(update.status);
    const downloading = update.status === "downloading";
    const downloaded = update.status === "downloaded";
    const current = update.currentVersion || state.versions.app || "";
    $("#sidebarAppVersion").textContent = current ? `v${current}` : "v—";
    $("#updatePanel").dataset.updateStatus = update.status || "idle";
    $("#currentVersion").textContent = current ? `v${current}` : "v—";
    $("#latestVersion").textContent = update.latestVersion ? `v${update.latestVersion}` : window.LoadToAgentI18n.t("ui.not_checked");
    $("#installationType").textContent = installationTypeLabel(update.installType);
    $("#releasePublishedAt").textContent = update.publishedAt
      ? window.LoadToAgentI18n.t("update.published", { date: new Date(update.publishedAt).toLocaleDateString(uiLocale()) })
      : window.LoadToAgentI18n.t("ui.stable_releases_only");
    $("#runtimeVersions").textContent = `Electron ${state.versions.electron || "—"} · Node ${state.versions.node || "—"}`;
    $("#updateStateGlyph").textContent = glyph;
    $("#updateStateLabel").textContent = label;
    $("#updateStateTitle").textContent = title;
    $("#updateStateText").textContent = text;
    $("#checkUpdateBtn").disabled = update.status === "checking" || downloading;
    $("#checkUpdateBtn").textContent =
      update.status === "checking" ? window.LoadToAgentI18n.t("ui.checking") : window.LoadToAgentI18n.t("settings.update.check");
    const install = $("#installUpdateBtn");
    install.classList.toggle("hidden", !(available && (update.asset || downloaded)));
    install.disabled = downloading;
    install.textContent = downloading
      ? window.LoadToAgentI18n.t("ui.downloading_2")
      : downloaded
        ? `${window.LoadToAgentI18n.t("settings.update.download")} · ${window.LoadToAgentI18n.t("ui.restart")}`
        : window.LoadToAgentI18n.t("settings.update.download");
    const progress = $("#updateProgress");
    progress.classList.toggle("hidden", !downloading && !downloaded);
    $("#updateProgressLabel").textContent = `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;
    $("#updateProgressBar").style.width = `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;
    $(".update-progress-track").setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, Number(update.progress || 0)))));
    $("#updateProgressBytes").textContent = downloaded
      ? `${formatBytes(update.totalBytes || update.downloadedBytes)} · ${window.LoadToAgentI18n.t("settings.update.file_verified")}`
      : `${formatBytes(update.downloadedBytes)} / ${update.totalBytes ? formatBytes(update.totalBytes) : window.LoadToAgentI18n.t("ui.checking_size")}`;
    const error = $("#updateError");
    error.classList.toggle("hidden", !update.error);
    error.textContent = update.error
      ? window.LoadToAgentI18n.errorText(update.error, "ui.could_not_check_for_updates")
      : "";
    const notes = $("#releaseNotes");
    notes.classList.toggle("hidden", !update.latestVersion);
    $("#releaseNotesText").textContent =
      (update.notes && update.notes.trim()) || window.LoadToAgentI18n.t("ui.no_release_notes_were_provided_for_this_release");
    const notice = $("#updateNotice");
    notice.classList.toggle("hidden", !available || state.view !== "all");
    $("#updateNoticeTitle").textContent = window.LoadToAgentI18n.t("update.available_version", { version: update.latestVersion || "—" });
    $("#updateNoticeText").textContent = downloaded
      ? window.LoadToAgentI18n.t("ui.the_installer_is_ready")
      : window.LoadToAgentI18n.t("ui.download_the_update_from_settings");
    $("#navUpdateBadge").classList.toggle("hidden", !available);
  }

  function renderProviderOverview() {
    pruneProviderFilters();
    const summaries = (state.snapshot && state.snapshot.summary && state.snapshot.summary.providers) || state.providers;
    const sessions = displaySessions();
    const visibleSummaries = summaries.filter((provider) => isProviderVisible(provider.id));
    const overviewTabStopId = state.providerFilters.size ? [...state.providerFilters][0] : visibleSummaries[0]?.id;
    $("#providerOverview").innerHTML = visibleSummaries
      .map((provider, index) => {
        const rootCount = sessions.filter((session) => session.provider === provider.id && !session.parentId).length;
        const selected = state.providerFilters.has(provider.id);
        const tabStop = provider.id === overviewTabStopId;
        return `<button type="button" class="provider-overview-card ${selected ? "selected" : ""}"
          data-provider-card="${esc(provider.id)}"
          data-motion-key="provider:${esc(provider.id)}"
          data-motion-value="${provider.active || 0}:${rootCount}:${(provider.usage && provider.usage.total) || 0}"
          style="${providerStyle(provider.id)}"
          tabindex="${tabStop ? "0" : "-1"}"
          aria-pressed="${selected ? "true" : "false"}">
      <div class="poc-head">
        <span class="provider-mark">${esc(provider.mark)}</span>
        <div><strong>${esc(provider.label)}</strong><small>${esc(provider.company)}</small></div>
        <span class="poc-head-states">
          <span class="poc-filter-state ${selected ? "visible" : ""}" aria-hidden="true">✓ ${window.LoadToAgentI18n.t("filter.applied")}</span>
          <span class="poc-state ${provider.installed ? "online" : ""}">
            ${provider.installed ? window.LoadToAgentI18n.t("ui.available") : window.LoadToAgentI18n.t("ui.setup_required")}
          </span>
        </span>
      </div>
      <div class="poc-metrics">
        <div><b>${provider.active || 0}</b><span>${window.LoadToAgentI18n.t("ui.active_ai")}</span></div>
        <div><b>${rootCount}</b><span>${window.LoadToAgentI18n.t("ui.main_tasks")}</span></div>
        <div><b>${compact(provider.usage && provider.usage.total)}</b><span>${window.LoadToAgentI18n.t("ui.tokens_used_2")}</span></div>
      </div>
    </button>`;
      })
      .join("");
  }

  function pruneProviderFilters() {
    const valid = new Set(visibleProviders().map((provider) => provider.id));
    for (const id of [...state.providerFilters]) if (!valid.has(id)) state.providerFilters.delete(id);
    if (valid.size > 0 && state.providerFilters.size === valid.size) state.providerFilters.clear();
  }

  function toggleProviderFilter(providerId) {
    pruneProviderFilters();
    if (providerId === "all") state.providerFilters.clear();
    else if (state.providerFilters.has(providerId)) state.providerFilters.delete(providerId);
    else state.providerFilters.add(providerId);
    if (visibleProviders().length > 0 && state.providerFilters.size === visibleProviders().length) state.providerFilters.clear();
  }

  function renderProviderFilter() {
    pruneProviderFilters();
    const allSelected = state.providerFilters.size === 0;
    const tabStopId = allSelected ? "all" : [...state.providerFilters][0];
    const button = (id, label, mark = "") => {
      const selected = id === "all" ? allSelected : state.providerFilters.has(id);
      return `<button type="button" class="provider-filter-chip ${selected ? "selected" : ""}"
        data-provider-filter="${esc(id)}" tabindex="${id === tabStopId ? "0" : "-1"}" aria-pressed="${selected ? "true" : "false"}">
        <i class="provider-filter-check" aria-hidden="true">✓</i>
        ${mark ? `<span class="provider-filter-mark" aria-hidden="true">${esc(mark)}</span>` : ""}<b>${esc(label)}</b>
      </button>`;
    };
    $("#providerFilter").innerHTML =
      button("all", window.LoadToAgentI18n.t("ui.all_ai")) +
      visibleProviders().map((provider) => button(provider.id, provider.label, provider.mark)).join("");
  }

  function announceProviderFilter() {
    const labels = state.providerFilters.size
      ? visibleProviders().filter((provider) => state.providerFilters.has(provider.id)).map((provider) => provider.label).join(", ")
      : window.LoadToAgentI18n.t("ui.all_ai");
    $("#providerFilterStatus").textContent = window.LoadToAgentI18n.t("filter.result_summary", {
      providers: labels,
      count: filteredSessions().length,
    });
  }

  function filteredSessions() {
    const allSessions = displaySessions();
    let sessions = state.view === "waiting" ? allSessions : allSessions.filter((session) => !session.parentId);
    if (state.view === "active") sessions = sessions.filter(isControlRoomSession);
    if (state.view === "waiting") sessions = sessions.filter((session) => context.needsManagementReview?.(session));
    if (state.providerFilters.size) sessions = sessions.filter((session) => state.providerFilters.has(session.provider));
    sessions = sessions.filter(matchesWorkspaceFilter);
    const query = state.search.replace(/\s+/g, " ").trim().toLowerCase();
    if (query) {
      sessions = sessions.filter((session) =>
        [session.title, session.model, session.originCwd, session.cwd, session.workspace, session.agentName, ...(session.messages || []).slice(-12).map((item) => item.text)]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }
    if (state.sort === "tokens") sessions.sort((a, b) => Number((b.usage && b.usage.total) || 0) - Number((a.usage && a.usage.total) || 0));
    else if (state.sort === "context") sessions.sort((a, b) => Number((b.context && b.context.percent) || 0) - Number((a.context && a.context.percent) || 0));
    else sessions = stableSessionSort(sessions);
    return sessions;
  }

  function ensureSessionOrder(sessions = []) {
    if (!Array.isArray(state.sessionOrder)) state.sessionOrder = [];
    const known = new Set(state.sessionOrder);
    for (const session of sessions) {
      const id = String(session?.id || "");
      if (!id || known.has(id)) continue;
      state.sessionOrder.push(id);
      known.add(id);
    }
    return state.sessionOrder;
  }

  function stableSessionSort(sessions = []) {
    const order = ensureSessionOrder(sessions);
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...sessions].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }

  function moveSessionOrder(sourceId, targetId, placeAfter = false) {
    const source = String(sourceId || "");
    const target = String(targetId || "");
    if (!source || !target || source === target) return false;
    const order = ensureSessionOrder(displaySessions());
    const sourceIndex = order.indexOf(source);
    if (sourceIndex < 0 || !order.includes(target)) return false;
    order.splice(sourceIndex, 1);
    const targetIndex = order.indexOf(target);
    order.splice(targetIndex + (placeAfter ? 1 : 0), 0, source);
    state.sessionOrder = order;
    return true;
  }

  function graphFilteredSessions() {
    let sessions = displaySessions();
    if (state.providerFilters.size) sessions = sessions.filter((session) => state.providerFilters.has(session.provider));
    sessions = sessions.filter(matchesWorkspaceFilter);
    const query = state.search.replace(/\s+/g, " ").trim().toLowerCase();
    if (query)
      sessions = sessions.filter((session) =>
        [session.title, session.model, session.originCwd, session.cwd, session.workspace, session.agentName, session.agentRole, ...(session.messages || []).map((item) => item.text)]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    if (state.controlRoomSort === "tokens") return [...sessions].sort((a, b) => Number((b.usage && b.usage.total) || 0) - Number((a.usage && a.usage.total) || 0));
    if (state.controlRoomSort === "context") return [...sessions].sort((a, b) => Number((b.context && b.context.percent) || 0) - Number((a.context && a.context.percent) || 0));
    return [...sessions].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

  function renderProviderVisibilitySettings() {
    const list = $("#providerVisibilityList");
    if (!list) return;
    list.innerHTML = state.providers.map((provider) => {
      const visible = isProviderVisible(provider.id);
      const status = window.LoadToAgentI18n.t(visible ? "settings.providers.visible" : "settings.providers.hidden");
      return `<label class="provider-visibility-option ${visible ? "enabled" : "disabled"}" style="${providerStyle(provider.id)}">
        <span class="provider-mark" aria-hidden="true">${esc(provider.mark)}</span>
        <span class="provider-visibility-name"><b>${esc(provider.label)}</b><small>${esc(provider.company)}</small></span>
        <span class="provider-visibility-status">${esc(status)}</span>
        <input type="checkbox" data-provider-visibility="${esc(provider.id)}" ${visible ? "checked" : ""}
          aria-label="${esc(`${provider.label} ${status}`)}">
        <span class="provider-toggle" aria-hidden="true"><i></i></span>
      </label>`;
    }).join("");
  }

  return {
    renderProviderRail,
    isProjectlessSession,
    sessionOriginPath,
    observedProjects,
    sessionWorkspaceLabel,
    controlRoomProject,
    matchesWorkspaceFilter,
    renderWorkspaces,
    renderGlobalStats,
    formatBytes,
    installationTypeLabel,
    updatePresentation,
    renderUpdateSettings,
    renderProviderOverview,
    renderProviderFilter,
    toggleProviderFilter,
    announceProviderFilter,
    filteredSessions,
    graphFilteredSessions,
    stableSessionSort,
    moveSessionOrder,
    renderProviderVisibilitySettings,
  };
};
