"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createTmuxRenderer = function createTmuxRenderer(context = {}) {
  const t = (key, params) => window.WhiteboxI18n.t(key, params);
  const absoluteTime = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t("memory.time_unknown");
    const locale = window.WhiteboxI18n.getLocaleTag();
    return new Intl.DateTimeFormat(locale, {
      year: "numeric", month: "long", day: "numeric",
      hour: locale.startsWith("ko") ? "2-digit" : "numeric",
      minute: "2-digit",
      ...(locale.startsWith("ko") ? { hourCycle: "h23" } : {}),
    }).format(date);
  };
  const {
    $,
    esc,
    state,
    compact,
    providerInfo,
    providerStyle,
    agentRoleLabel,
    subagentWorkState,
    subagentWorkLabel,
    latestWorkCopy,
    readablePreview,
    timeAgo,
    visibleTmux = () => state.snapshot && state.snapshot.tmux,
    visibleSessions = () => ((state.snapshot && state.snapshot.sessions) || []),
  } = context;

  function tmuxEntities(tmux) {
    const distros = new Map();
    const sessions = new Map();
    const windows = new Map();
    const panes = new Map();
    for (const distro of (tmux && tmux.distros) || []) {
      distros.set(distro.id, distro);
      for (const tmuxSession of distro.sessions || []) {
        sessions.set(tmuxSession.id, { item: tmuxSession, distro });
        for (const window of tmuxSession.windows || []) {
          windows.set(window.id, { item: window, session: tmuxSession, distro });
          for (const pane of window.panes || []) panes.set(pane.id, { item: pane, window, session: tmuxSession, distro });
        }
      }
    }
    return { distros, sessions, windows, panes };
  }

  function distroLabel(distro) {
    if (distro?.kind === "local") return t("tmux.local_environment");
    return String(distro?.name || distro?.displayName || t("tmux.name_unknown"));
  }

  function distroPanes(distro) {
    return (distro?.sessions || []).flatMap((session) =>
      (session.windows || []).flatMap((window) => window.panes || []));
  }

  function tmuxFocusPath(index) {
    const focus = state.tmuxFocus;
    if (!focus) return [];
    if (focus.type === "distro") {
      const distro = index.distros.get(focus.id);
      return distro ? [{ type: "distro", id: distro.id, label: distro.displayName || distro.name }] : [];
    }
    if (focus.type === "session") {
      const found = index.sessions.get(focus.id);
      return found
        ? [
            { type: "distro", id: found.distro.id, label: found.distro.displayName || found.distro.name },
            { type: "session", id: found.item.id, label: found.item.displayName || found.item.name },
          ]
        : [];
    }
    if (focus.type === "window") {
      const found = index.windows.get(focus.id);
      return found
        ? [
            { type: "distro", id: found.distro.id, label: found.distro.displayName || found.distro.name },
            { type: "session", id: found.session.id, label: found.session.displayName || found.session.name },
            { type: "window", id: found.item.id, label: `${found.item.index}:${found.item.displayName || found.item.name}` },
          ]
        : [];
    }
    const found = index.panes.get(focus.id);
    return found
      ? [
          { type: "distro", id: found.distro.id, label: found.distro.displayName || found.distro.name },
          { type: "session", id: found.session.id, label: found.session.displayName || found.session.name },
          { type: "window", id: found.window.id, label: `${found.window.index}:${found.window.displayName || found.window.name}` },
          { type: "pane", id: found.item.id, label: t('tmux.pane_label', { name: found.item.displayName || found.item.title || t("tmux.default_work_name", { index: found.item.index + 1 }) }) },
        ]
      : [];
  }

  function linkedTmuxSubagents(agent) {
    if (!agent || !agent.linkedSessionId) return [];
    const sessions = visibleSessions();
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const root = byId.get(agent.linkedSessionId);
    const queue = (root && root.childIds || agent.childIds || []).map((id) => ({ id, depth: 1 }));
    const seen = new Set(root ? [root.id] : []);
    const children = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const item = queue[cursor];
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const child = byId.get(item.id);
      if (!child) continue;
      children.push({ session: child, depth: item.depth });
      for (const childId of child.childIds || []) queue.push({ id: childId, depth: item.depth + 1 });
    }
    return children;
  }

  function readablePaneCommand(command, agent) {
    if (agent) return t("tmux.agent_work_running", { provider: providerInfo(agent.provider).label });
    const raw = String(command || "").trim().toLowerCase();
    if (/^(node|npm|npx|pnpm|yarn|bun)(\.exe)?(?:\s|$)/.test(raw)) return t("tmux.program_running");
    if (/^(bash|sh|zsh|fish|pwsh|powershell|cmd|shell)(\.exe)?(?:\s|$)/.test(raw)) return t("tmux.regular_command_window");
    return raw ? t("tmux.command_running") : t("tmux.regular_command_window");
  }

  function readableFolder(cwd) {
    const value = String(cwd || "").trim().replace(/[\\/]+$/, "");
    if (!value) return t("terminal.path_unreported");
    const parts = value.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || value;
  }

  function friendlyWorkName(value, index = 0) {
    const raw = String(value || "").trim();
    if (!raw) return t("tmux.default_work_name", { index: Number(index) + 1 });
    if (/board[-_\s]*migration/i.test(raw)) return t("tmux.friendly_work.board_migration");
    if (/cms[-_\s]*web/i.test(raw)) return t("tmux.friendly_work.cms_web");
    if (/브[런랜]치|branch/i.test(raw)) return t("tmux.friendly_work.branch");
    if (/^(main|master)$/i.test(raw)) return t("tmux.friendly_work.default_branch");
    if (/^(bash|sh|zsh|fish|pwsh|powershell|cmd)$/i.test(raw)) return t("tmux.friendly_work.computer");
    if (/^[A-Z0-9_-]+$/.test(raw) || /[-_]/.test(raw)) return t("tmux.default_work_name", { index: Number(index) + 1 });
    return raw;
  }

  function tmuxSubagentPanel(pane, agent) {
    const children = linkedTmuxSubagents(agent);
    if (!children.length) return "";
    const expanded = state.expandedTmuxSubagents.has(pane.id);
    const listId = `tmux-subagents-list-${encodeURIComponent(pane.id)}`;
    const working = children.filter(({ session }) => subagentWorkState(session) === "working").length;
    const attention = children.filter(({ session }) => subagentWorkState(session) === "attention").length;
    const statusSummary = t('tmux.subagents.status_summary', { total: working + attention, working, attention });
    const rows = children
      .map(({ session, depth }) => {
        const provider = providerInfo(session.provider);
        const role = session.agentName || agentRoleLabel(session.agentRole);
        const assigned = session.delegation && session.delegation.assignment || session.taskName || session.title || t('tmux.subagents.checking_assignment');
        const work = readablePreview(latestWorkCopy(session) || window.WhiteboxI18n.observedText(session.statusDetail) || t('tmux.subagents.checking_status'), 96);
        const workState = subagentWorkState(session);
        return `<article class="tmux-subagent-row work-${workState}" data-tmux-subagent-id="${esc(session.id)}"
          style="${providerStyle(session.provider)};--tmux-subagent-depth:${Math.min(2, Math.max(0, depth - 1))}">
          <span class="provider-mark" aria-hidden="true">${esc(provider.mark)}</span>
          <span class="tmux-subagent-copy">
            <span><b>${esc(role)}</b><i>${esc(subagentWorkLabel(session))}</i><small>${esc(absoluteTime(session.updatedAt))}</small></span>
            <strong>${esc(assigned)}</strong>
            <em title="${esc(work.full)}">${esc(work.text)}</em>
          </span>
          <button type="button" data-open-subagent-chat="${esc(session.id)}" aria-label="${esc(t('tmux.subagents.view_conversation_aria', { role, assignment: assigned }))}">${t('tmux.subagents.view_conversation')}</button>
        </article>`;
      })
      .join("");
    return `<section class="tmux-subagents ${expanded ? "expanded" : ""}" data-tmux-subagents="${esc(pane.id)}">
      <button type="button" class="tmux-subagents-toggle" data-tmux-subagents-toggle="${esc(pane.id)}" aria-expanded="${expanded}" aria-controls="${esc(listId)}">
        <span><b>${t('tmux.subagents.connected_count', { count: children.length, shown: expanded ? children.length : 0 })}</b><small>${statusSummary}</small></span>
        <i aria-hidden="true">${t(expanded ? "tmux.subagents.collapse" : "tmux.subagents.expand")}</i>
      </button>
      <div id="${esc(listId)}" class="tmux-subagent-list ${expanded ? "" : "hidden"}">${rows}</div>
    </section>`;
  }

  function paneAgentStatus(agent, provider) {
    const status = String(agent?.status || "").toLowerCase();
    if (["running", "starting", "active", "working"].includes(status)) return t("tmux.agent_status.working", { provider });
    if (["completed", "done", "ended"].includes(status)) return t("tmux.agent_status.completed", { provider });
    if (["failed", "error"].includes(status)) return t("tmux.agent_status.failed", { provider });
    return t("tmux.agent_status.waiting", { provider });
  }

  function paneNeedsReview(pane) {
    const status = String(pane?.agent?.status || "").toLowerCase();
    return Boolean(pane?.agent && !pane.dead
      && !["running", "starting", "active", "working", "completed", "done", "ended", "failed", "error"].includes(status));
  }

  function paneIsWorking(pane) {
    return Boolean(pane?.agent && !pane.dead
      && ["running", "starting", "active", "working"].includes(String(pane.agent.status || "").toLowerCase()));
  }

  function tmuxPaneCard(pane) {
    const agent = pane.agent;
    const provider = agent && providerInfo(agent.provider);
    const workName = friendlyWorkName(pane.displayName || pane.title, pane.index);
    const context = (agent && agent.context) || {};
    const usage = (agent && agent.usage) || {};
    const connectedConversationCount = Number(agent?.collaboration?.metrics?.retainedCount)
      || (agent?.childIds || []).length;
    const expandedConversationCount = state.expandedTmuxSubagents.has(pane.id)
      ? linkedTmuxSubagents(agent).length
      : 0;
    const percent = Math.max(0, Math.min(100, Number(context.percent || 0)));
    return `<article class="tmux-pane-node ${paneNeedsReview(pane) ? "needs-review" : ""} ${pane.active ? "active" : ""} ${pane.dead ? "dead" : ""} ${agent ? "has-agent" : ""}"
      ${agent ? `style="${providerStyle(agent.provider)}"` : ""}>
      <button type="button" class="tmux-pane-main" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}" aria-pressed="${state.tmuxFocus?.type === "pane" && state.tmuxFocus?.id === pane.id ? "true" : "false"}">
        ${state.tmuxFocus?.type === "pane" && state.tmuxFocus?.id === pane.id ? `<span class="tmux-selection-badge">✓ ${t("tmux.selected")}</span>` : ""}
        <span class="tmux-pane-head">
          <b>${paneNeedsReview(pane) ? t("tmux.review_required_count", { count: 1 }) : esc(workName)}</b>${agent ? "" : `<span>${t('tmux.process_number', { pid: pane.pid || "--" })}</span>`}
          <i>${pane.dead ? t('tmux.state.ended') : agent ? paneAgentStatus(agent, provider.label) : (pane.active ? t('tmux.state.active') : t('tmux.state.background'))}</i>
        </span>
        ${agent ? "" : `<strong class="tmux-pane-command">${esc(readablePaneCommand(pane.command, agent))}</strong>`}
        <span class="tmux-pane-cwd" title="${esc(pane.cwd)}">${esc(pane.displayFolder || readableFolder(pane.cwd))}</span>
        ${
          agent
            ? `<span class="tmux-agent-block">
          <span class="provider-mark">${esc(provider.mark)}</span>
          <span>
          <small>${esc(t("tmux.ai_state", { state: paneAgentStatus(agent, provider.label) }))}</small>
          <strong>${esc(t("tmux.ai_work_name", { title: friendlyWorkName(agent.title, pane.index) }))}</strong>
          <em>${esc(t("tmux.latest_progress", { progress: friendlyWorkName(window.WhiteboxI18n.observedText(agent.statusDetail), pane.index) }))}</em>
          </span>
          </span>
          <span class="tmux-agent-metrics">
            <span title="${esc(t('tmux.context_usage_help'))}">
            <small>${t('tmux.context_usage')}</small>
            <b>${context.window ? t("tmux.percent_used", { value: percent.toFixed(1) }) : "--"}</b>
            </span>
            <span title="${esc(t('tmux.text_usage_help'))}">
            <small>${t('tmux.text_usage')}</small>
            <b>${t('tmux.approx_usage', { value: Number(usage.total || 0).toLocaleString("ko-KR") })}</b>
            </span>
            <span>
            <small>${t('tmux.helper_ai', { count: connectedConversationCount })}</small>
            <b>${t("tmux.expanded_conversation_count", { count: expandedConversationCount })}</b>
            </span>
            </span>
          <span class="tmux-context-track"><i style="width:${percent}%"></i></span>`
            : `<span class="tmux-shell-note">${t('tmux.regular_terminal_note')}</span>`
        }
      </button>
      ${tmuxSubagentPanel(pane, agent)}
      <footer>
        <span>${agent
          ? paneNeedsReview(pane)
            ? esc(t("tmux.work_name", { name: workName }))
            : esc(t("tmux.current_stage", { stage: friendlyWorkName(agent.statusDetail || agent.title, pane.index) }))
          : esc(pane.title || t('terminal.type.terminal'))}</span>
        <span class="tmux-pane-actions">
        <button type="button" data-control-tmux="${esc(pane.id)}">${esc(paneNeedsReview(pane) ? t("tmux.action.review_work", { name: workName }) : paneIsWorking(pane) ? t("tmux.action.view_progress") : t("tmux.action.view_work", { name: workName }))}</button>
        ${agent && agent.linkedSessionId ? `<button type="button" class="tmux-secondary-conversation" data-open-session="${esc(agent.linkedSessionId)}">${t('tmux.view_conversation', { count: connectedConversationCount })}</button>` : ""}
        </span>
        </footer>
    </article>`;
  }

  function tmuxWindowTree(window) {
    return `<div class="tmux-window-tree">
      <button type="button" class="tmux-window-node ${window.active ? "active" : ""}" data-tmux-type="window" data-tmux-id="${esc(window.id)}" aria-pressed="${state.tmuxFocus?.type === "window" && state.tmuxFocus?.id === window.id ? "true" : "false"}">
      ${window.active || state.tmuxFocus?.type === "window" && state.tmuxFocus?.id === window.id ? `<i class="tmux-selection-badge">✓ ${t("tmux.selected")}</i>` : ""}
      <strong>${t('tmux.open_window')} ${Number(window.index || 0) + 1}</strong>
      <span>${t('tmux.split_count', { count: window.panes.length })}</span>
      </button>
      <div class="tmux-link-line" aria-hidden="true">
      <i>
      </i>
      </div>
      <div class="tmux-pane-stack">${[...window.panes].sort((a, b) => Number(paneNeedsReview(b)) - Number(paneNeedsReview(a))).map(tmuxPaneCard).join("")}</div>
      </div>`;
  }

  function tmuxSessionTree(tmuxSession) {
    return `<div class="tmux-session-tree">
      <div class="tmux-window-stack">${tmuxSession.windows.map(tmuxWindowTree).join("")}</div>
      </div>`;
  }

  function filteredTmuxDistros(tmux, index) {
    if (!state.tmuxFocus) return tmux.distros || [];
    const path = tmuxFocusPath(index);
    if (!path.length) {
      state.tmuxFocus = null;
      return tmux.distros || [];
    }
    const distroId = path[0].id;
    return (tmux.distros || [])
      .filter((distro) => distro.id === distroId)
      .map((distro) => ({
        ...distro,
        sessions: (distro.sessions || [])
          .filter((tmuxSession) => {
            const target = path.find((item) => item.type === "session");
            return !target || tmuxSession.id === target.id;
          })
          .map((tmuxSession) => ({
            ...tmuxSession,
            windows: (tmuxSession.windows || [])
              .filter((window) => {
                const target = path.find((item) => item.type === "window");
                return !target || window.id === target.id;
              })
              .map((window) => ({
                ...window,
                panes: (window.panes || []).filter((pane) => {
                  const target = path.find((item) => item.type === "pane");
                  return !target || pane.id === target.id;
                }),
              })),
          })),
      }));
  }

  function renderTmuxMap() {
    const tmux = visibleTmux() || { available: false, status: t('tmux.status.checking'), distros: [], summary: {} };
    const summary = tmux.summary || {};
    const index = tmuxEntities(tmux);
    const path = tmuxFocusPath(index);
    const distros = filteredTmuxDistros(tmux, index);
    const panes = distros.flatMap(distroPanes).filter((pane) => !pane.dead);
    const workingPanes = panes.filter((pane) =>
      pane.agent && !pane.dead && ["running", "starting", "active", "working"].includes(String(pane.agent.status || "").toLowerCase())).length;
    const reviewPanes = panes.filter(paneNeedsReview).length;
    const environmentLabel = distros.length === 1
      ? distroLabel(distros[0])
      : t("tmux.environment_count", { count: distros.length });
    const selectedComputerTitle = $("#tmuxSelectedComputerTitle");
    if (selectedComputerTitle) selectedComputerTitle.textContent = t("tmux.selected_computer_title", { name: environmentLabel, count: panes.length });
    const selectedComputerDescription = $("#tmuxSelectedComputerDescription");
    if (selectedComputerDescription) {
      selectedComputerDescription.textContent = t("tmux.selected_computer_description");
    }
    $("#tmuxStats").innerHTML = `<div class="tmux-simple-summary ${reviewPanes ? "needs-review" : ""}">
      <strong>${esc(t("tmux.environment_summary", { name: environmentLabel, working: workingPanes, review: reviewPanes }))}</strong>
      <small>${t(reviewPanes ? "tmux.review_hint" : "tmux.no_review_results")}</small>
    </div>`;
    $("#tmuxBreadcrumbs").innerHTML = path.length
      ? `<button type="button" data-tmux-reset tabindex="-1">${t('tmux.full_list')}</button>${path
          .map(
            (item) => `<i aria-hidden="true">›</i>
      <button type="button"
        class="${item.type === state.tmuxFocus.type && item.id === state.tmuxFocus.id ? "current" : ""}"
        ${item.type === state.tmuxFocus.type && item.id === state.tmuxFocus.id ? 'aria-current="location" tabindex="0"' : 'tabindex="-1"'}
        data-tmux-type="${item.type}" data-tmux-id="${esc(item.id)}">
        ${esc(item.label)}
      </button>`,
          )
          .join("")}`
      : `<span class="map-hint">${t("tmux.map_instruction")}</span>`;
    $("#tmuxResetBtn").classList.toggle("hidden", !path.length);
    if (!distros.length || !Number(summary.sessions || 0)) {
      $("#tmuxMap").innerHTML = `<div class="tmux-empty">
        <span>▦</span>
        <h3>${t('tmux.empty.title')}</h3>
        <p>${esc(window.WhiteboxI18n.observedText(tmux.status || t('tmux.empty.checking_linux')))}</p>
        <small>${t('tmux.empty.description')}</small>
        </div>`;
      return;
    }
    $("#tmuxMap").innerHTML = distros
      .map(
        (distro) => {
          const environmentName = distroLabel(distro);
          const environmentPanes = distroPanes(distro).filter((pane) => !pane.dead);
          return `<section class="tmux-distro-group">
      <button type="button" class="tmux-distro-node" data-tmux-type="distro" data-tmux-id="${esc(distro.id)}" aria-pressed="${state.tmuxFocus?.type === "distro" && state.tmuxFocus?.id === distro.id ? "true" : "false"}">
      ${path.some(item => item.type === "distro" && item.id === distro.id) ? `<i class="tmux-selection-badge">✓ ${t("tmux.selected")}</i>` : ""}
      <span>${esc(t("tmux.environment_work_label", { name: environmentName }))}</span>
      <div>
      <strong>${esc(t("tmux.environment_work_count", { name: environmentName, count: environmentPanes.length }))}</strong>
      <em>${t("tmux.environment_sort_hint")}</em>
      </div>
      <b>${t("tmux.total_count", { count: environmentPanes.length })}</b>
      </button>
      <div class="tmux-distro-line" aria-hidden="true">
      </div>
      <div class="tmux-session-stack">${distro.sessions.map(tmuxSessionTree).join("")}</div>
      </section>`;
        },
      )
      .join("");
    const mapNodes = Array.from($("#tmuxMap").querySelectorAll("[data-tmux-type][data-tmux-id]"));
    const focusedNode = mapNodes.find((node) => node.dataset.tmuxType === state.tmuxFocus?.type && node.dataset.tmuxId === state.tmuxFocus?.id) || mapNodes[0];
    mapNodes.forEach((node) => { node.tabIndex = node === focusedNode ? 0 : -1; });
  }

  return { tmuxEntities, tmuxFocusPath, linkedTmuxSubagents, tmuxPaneCard, tmuxWindowTree, tmuxSessionTree, filteredTmuxDistros, renderTmuxMap };
};
