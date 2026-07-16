"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDashboard = function createDashboard(context = {}) {
  const {
    $,
    esc,
    uiLocale,
    PROJECTLESS_WORKSPACE,
    state,
    compact,
    providerStyle,
  } = context;

  function renderProviderRail() {
    $("#providerRail").innerHTML = state.providers
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
    if (!session || !session.cwd) return true;
    if (typeof session.projectless === "boolean") return session.projectless;
    const normalized = String(session.cwd).replace(/\\/g, "/").replace(/\/+$/, "");
    return session.provider === "codex" && session.clientKind === "codex-desktop" && /(?:^|\/)Documents\/Codex\/\d{4}-\d{2}-\d{2}\/new-chat$/i.test(normalized);
  }

  function sessionWorkspaceLabel(session) {
    return isProjectlessSession(session) ? window.LoadToAgentI18n.t("ui.no_project") : (session && session.workspace) || "작업 폴더 미상";
  }

  function matchesWorkspaceFilter(session) {
    if (state.workspace === "all") return true;
    if (state.workspace === PROJECTLESS_WORKSPACE) return isProjectlessSession(session);
    return (
      !isProjectlessSession(session) &&
      String((session && session.cwd) || "")
        .toLowerCase()
        .startsWith(state.workspace.toLowerCase())
    );
  }

  function renderWorkspaces() {
    const list = $("#workspaceList");
    const projectlessCount = ((state.snapshot && state.snapshot.sessions) || []).filter((session) => !session.parentId && isProjectlessSession(session)).length;
    list.innerHTML =
      `<button type="button" class="workspace-item ${state.workspace === "all" ? "selected" : ""}"
        data-workspace="all" aria-pressed="${state.workspace === "all" ? "true" : "false"}">
      <strong>${window.LoadToAgentI18n.t("ui.all_workspaces")}</strong>
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
      state.workspaces
        .map(
          (item) => `<div class="workspace-row">
        <button type="button" class="workspace-item ${state.workspace === item.path ? "selected" : ""}"
          data-workspace="${esc(item.path)}" title="${esc(item.path)}"
          aria-pressed="${state.workspace === item.path ? "true" : "false"}">
        <strong>${esc(item.name)}</strong>
        </button>
        <button type="button" class="workspace-remove" data-remove-workspace="${esc(item.path)}"
          aria-label="${esc(item.name)} 작업 폴더를 목록에서 제거"
          title="${esc(window.LoadToAgentI18n.t("ui.remove_from_list"))}">×</button>
        </div>`,
        )
        .join("") +
      (!state.workspaces.length ? `<div class="workspace-empty">${window.LoadToAgentI18n.t("ui.use_the_button_to_add_frequently_used_workspaces")}</div>` : "");
  }

  function renderGlobalStats() {
    const totals = (state.snapshot && state.snapshot.summary && state.snapshot.summary.totals) || {};
    const sessions = (state.snapshot && state.snapshot.sessions) || [];
    const rootCount = sessions.filter((session) => !session.parentId).length;
    const helperCount = sessions.filter((session) => session.parentId).length;
    const items = [
      [window.LoadToAgentI18n.t("ui.all_tasks"), rootCount, window.LoadToAgentI18n.t("ui.items"), ""],
      [window.LoadToAgentI18n.t("ui.ai_working_now"), totals.active || 0, window.LoadToAgentI18n.t("ui.items"), "live"],
      [window.LoadToAgentI18n.t("ui.waiting_for_review"), totals.waiting || 0, window.LoadToAgentI18n.t("ui.items"), "alert"],
      [window.LoadToAgentI18n.t("ui.helper_ai_history"), helperCount, window.LoadToAgentI18n.t("ui.items"), ""],
      [window.LoadToAgentI18n.t("ui.tokens_used"), compact(totals.usage && totals.usage.total), window.LoadToAgentI18n.t("ui.items"), ""],
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
    $("#navActiveCount").textContent = totals.active || 0;
    $("#navWaitingCount").textContent = totals.waiting || 0;
    $("#navTmuxCount").textContent = (state.snapshot && state.snapshot.tmux && state.snapshot.tmux.summary && state.snapshot.tmux.summary.aiPanes) || 0;
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
        window.LoadToAgentI18n.t("ui.open_the_installer_and_follow_its_instructions_to_finish_updating"),
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
        ? window.LoadToAgentI18n.t("ui.open_installer")
        : window.LoadToAgentI18n.t("settings.update.download");
    const progress = $("#updateProgress");
    progress.classList.toggle("hidden", !downloading && !downloaded);
    $("#updateProgressLabel").textContent = `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;
    $("#updateProgressBar").style.width = `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;
    $(".update-progress-track").setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, Number(update.progress || 0)))));
    $("#updateProgressBytes").textContent = downloaded
      ? `${formatBytes(update.totalBytes || update.downloadedBytes)} · 파일 검증 완료`
      : `${formatBytes(update.downloadedBytes)} / ${update.totalBytes ? formatBytes(update.totalBytes) : window.LoadToAgentI18n.t("ui.checking_size")}`;
    const error = $("#updateError");
    error.classList.toggle("hidden", !update.error);
    error.textContent = update.error || "";
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
    const sessions = (state.snapshot && state.snapshot.sessions) || [];
    $("#providerOverview").innerHTML = summaries
      .map((provider) => {
        const rootCount = sessions.filter((session) => session.provider === provider.id && !session.parentId).length;
        const selected = state.providerFilters.has(provider.id);
        return `<button type="button" class="provider-overview-card ${selected ? "selected" : ""}"
          data-provider-card="${esc(provider.id)}"
          data-motion-key="provider:${esc(provider.id)}"
          data-motion-value="${provider.active || 0}:${rootCount}:${(provider.usage && provider.usage.total) || 0}"
          style="${providerStyle(provider.id)}"
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
    const valid = new Set(state.providers.map((provider) => provider.id));
    for (const id of [...state.providerFilters]) if (!valid.has(id)) state.providerFilters.delete(id);
    if (valid.size > 0 && state.providerFilters.size === valid.size) state.providerFilters.clear();
  }

  function toggleProviderFilter(providerId) {
    pruneProviderFilters();
    if (providerId === "all") state.providerFilters.clear();
    else if (state.providerFilters.has(providerId)) state.providerFilters.delete(providerId);
    else state.providerFilters.add(providerId);
    if (state.providers.length > 0 && state.providerFilters.size === state.providers.length) state.providerFilters.clear();
  }

  function renderProviderFilter() {
    pruneProviderFilters();
    const allSelected = state.providerFilters.size === 0;
    const button = (id, label, mark = "") => {
      const selected = id === "all" ? allSelected : state.providerFilters.has(id);
      return `<button type="button" class="provider-filter-chip ${selected ? "selected" : ""}"
        data-provider-filter="${esc(id)}" aria-pressed="${selected ? "true" : "false"}">
        <i class="provider-filter-check" aria-hidden="true">✓</i>
        ${mark ? `<span class="provider-filter-mark" aria-hidden="true">${esc(mark)}</span>` : ""}<b>${esc(label)}</b>
      </button>`;
    };
    $("#providerFilter").innerHTML =
      button("all", window.LoadToAgentI18n.t("ui.all_ai")) +
      state.providers.map((provider) => button(provider.id, provider.label, provider.mark)).join("");
  }

  function announceProviderFilter() {
    const labels = state.providerFilters.size
      ? state.providers.filter((provider) => state.providerFilters.has(provider.id)).map((provider) => provider.label).join(", ")
      : window.LoadToAgentI18n.t("ui.all_ai");
    $("#providerFilterStatus").textContent = window.LoadToAgentI18n.t("filter.result_summary", {
      providers: labels,
      count: filteredSessions().length,
    });
  }

  function filteredSessions() {
    const allSessions = [...((state.snapshot && state.snapshot.sessions) || [])];
    let sessions = state.view === "waiting" ? allSessions : allSessions.filter((session) => !session.parentId);
    if (state.view === "active") sessions = sessions.filter((session) => session.status === "running" || session.status === "starting");
    if (state.view === "waiting") sessions = sessions.filter((session) => session.status === "waiting");
    if (state.providerFilters.size) sessions = sessions.filter((session) => state.providerFilters.has(session.provider));
    sessions = sessions.filter(matchesWorkspaceFilter);
    const query = state.search.trim().toLowerCase();
    if (query) {
      sessions = sessions.filter((session) =>
        [session.title, session.model, session.cwd, session.agentName, ...(session.messages || []).slice(-12).map((item) => item.text)]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }
    if (state.sort === "tokens") sessions.sort((a, b) => Number((b.usage && b.usage.total) || 0) - Number((a.usage && a.usage.total) || 0));
    else if (state.sort === "context") sessions.sort((a, b) => Number((b.context && b.context.percent) || 0) - Number((a.context && a.context.percent) || 0));
    else
      sessions.sort((a, b) => {
        const activeA = a.status === "running" || a.status === "starting" ? 1 : 0;
        const activeB = b.status === "running" || b.status === "starting" ? 1 : 0;
        return activeB - activeA || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      });
    return sessions;
  }

  function graphFilteredSessions() {
    let sessions = [...((state.snapshot && state.snapshot.sessions) || [])];
    if (state.providerFilters.size) sessions = sessions.filter((session) => state.providerFilters.has(session.provider));
    sessions = sessions.filter(matchesWorkspaceFilter);
    const query = state.search.trim().toLowerCase();
    if (query)
      sessions = sessions.filter((session) =>
        [session.title, session.model, session.cwd, session.agentName, session.agentRole, ...(session.messages || []).map((item) => item.text)]
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    return sessions;
  }

  return {
    renderProviderRail,
    isProjectlessSession,
    sessionWorkspaceLabel,
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
  };
};
