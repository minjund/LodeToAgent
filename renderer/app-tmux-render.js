"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createTmuxRenderer = function createTmuxRenderer(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
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

  function tmuxFocusPath(index) {
    const focus = state.tmuxFocus;
    if (!focus) return [];
    if (focus.type === "distro") {
      const distro = index.distros.get(focus.id);
      return distro ? [{ type: "distro", id: distro.id, label: distro.name }] : [];
    }
    if (focus.type === "session") {
      const found = index.sessions.get(focus.id);
      return found
        ? [
            { type: "distro", id: found.distro.id, label: found.distro.name },
            { type: "session", id: found.item.id, label: found.item.name },
          ]
        : [];
    }
    if (focus.type === "window") {
      const found = index.windows.get(focus.id);
      return found
        ? [
            { type: "distro", id: found.distro.id, label: found.distro.name },
            { type: "session", id: found.session.id, label: found.session.name },
            { type: "window", id: found.item.id, label: `${found.item.index}:${found.item.name}` },
          ]
        : [];
    }
    const found = index.panes.get(focus.id);
    return found
      ? [
          { type: "distro", id: found.distro.id, label: found.distro.name },
          { type: "session", id: found.session.id, label: found.session.name },
          { type: "window", id: found.window.id, label: `${found.window.index}:${found.window.name}` },
          { type: "pane", id: found.item.id, label: t('tmux.pane_label', { index: found.item.index }) },
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

  function tmuxSubagentPanel(pane, agent) {
    const children = linkedTmuxSubagents(agent);
    if (!children.length) return "";
    const expanded = state.expandedTmuxSubagents.has(pane.id);
    const listId = `tmux-subagents-list-${encodeURIComponent(pane.id)}`;
    const working = children.filter(({ session }) => subagentWorkState(session) === "working").length;
    const attention = children.filter(({ session }) => subagentWorkState(session) === "attention").length;
    const statusSummary = [
      working ? t('tmux.subagents.working_count', { count: working }) : "",
      attention ? t('tmux.subagents.attention_count', { count: attention }) : "",
    ].filter(Boolean).join(" · ") || t('tmux.subagents.all_idle');
    const rows = children
      .map(({ session, depth }) => {
        const provider = providerInfo(session.provider);
        const role = session.agentName || agentRoleLabel(session.agentRole);
        const assigned = session.delegation && session.delegation.assignment || session.taskName || session.title || t('tmux.subagents.checking_assignment');
        const work = readablePreview(latestWorkCopy(session) || window.LoadToAgentI18n.observedText(session.statusDetail) || t('tmux.subagents.checking_status'), 96);
        const workState = subagentWorkState(session);
        return `<article class="tmux-subagent-row work-${workState}" data-tmux-subagent-id="${esc(session.id)}"
          style="${providerStyle(session.provider)};--tmux-subagent-depth:${Math.min(2, Math.max(0, depth - 1))}">
          <span class="provider-mark" aria-hidden="true">${esc(provider.mark)}</span>
          <span class="tmux-subagent-copy">
            <span><b>${esc(role)}</b><i>${esc(subagentWorkLabel(session))}</i><small>${esc(timeAgo(session.updatedAt))}</small></span>
            <strong>${esc(assigned)}</strong>
            <em title="${esc(work.full)}">${esc(work.text)}</em>
          </span>
          <button type="button" data-open-subagent-chat="${esc(session.id)}" aria-label="${esc(t('tmux.subagents.view_conversation_aria', { role, assignment: assigned }))}">${t('tmux.subagents.view_conversation')}</button>
        </article>`;
      })
      .join("");
    return `<section class="tmux-subagents ${expanded ? "expanded" : ""}" data-tmux-subagents="${esc(pane.id)}">
      <button type="button" class="tmux-subagents-toggle" data-tmux-subagents-toggle="${esc(pane.id)}" aria-expanded="${expanded}" aria-controls="${esc(listId)}">
        <span><b>${t('tmux.subagents.connected_count', { count: children.length })}</b><small>${statusSummary} · ${t('tmux.subagents.main_session_basis')}</small></span>
        <i aria-hidden="true">↓</i>
      </button>
      <div id="${esc(listId)}" class="tmux-subagent-list ${expanded ? "" : "hidden"}">${rows}</div>
    </section>`;
  }

  function tmuxPaneCard(pane) {
    const agent = pane.agent;
    const provider = agent && providerInfo(agent.provider);
    const context = (agent && agent.context) || {};
    const usage = (agent && agent.usage) || {};
    const percent = Math.max(0, Math.min(100, Number(context.percent || 0)));
    return `<article class="tmux-pane-node ${pane.active ? "active" : ""} ${pane.dead ? "dead" : ""} ${agent ? "has-agent" : ""}"
      ${agent ? `style="${providerStyle(agent.provider)}"` : ""}>
      <button type="button" class="tmux-pane-main" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}">
        <span class="tmux-pane-head">
          <b>${t('tmux.split_pane_number', { number: pane.index + 1 })}</b><span>${t('tmux.process_number', { pid: pane.pid || "--" })}</span>
          <i>${pane.dead ? t('tmux.state.ended') : pane.active ? t('tmux.state.active') : t('tmux.state.background')}</i>
        </span>
        <strong class="tmux-pane-command">${esc(pane.command || "shell")}</strong>
        <span class="tmux-pane-cwd" title="${esc(pane.cwd)}">${esc(pane.cwd || t('terminal.path_unreported'))}</span>
        ${
          agent
            ? `<span class="tmux-agent-block">
          <span class="provider-mark">${esc(provider.mark)}</span>
          <span>
          <small>${esc(provider.label)} · ${t('tmux.process_number', { pid: agent.pid })}</small>
          <strong>${esc(agent.title)}</strong>
          <em>${esc(window.LoadToAgentI18n.observedText(agent.statusDetail))}</em>
          </span>
          </span>
          <span class="tmux-agent-metrics">
            <span>
            <small>${t('tmux.context_usage')}</small>
            <b>${context.window ? `${percent.toFixed(1)}%` : "--"}</b>
            </span>
            <span>
            <small>${window.LoadToAgentI18n.t("ui.tokens_used_2")}</small>
            <b>${compact(usage.total)}</b>
            </span>
            <span>
            <small>${t('tmux.helper_ai')}</small>
            <b>${(agent.childIds || []).length}</b>
            </span>
            </span>
          <span class="tmux-context-track"><i style="width:${percent}%"></i></span>`
            : `<span class="tmux-shell-note">${t('tmux.regular_terminal_note')}</span>`
        }
      </button>
      ${tmuxSubagentPanel(pane, agent)}
      <footer>
        <span>${agent ? (agent.linkedSessionId ? t('tmux.linked_to_history') : t('tmux.ai_detected')) : pane.title || t('terminal.type.terminal')}</span>
        <span class="tmux-pane-actions">
        <button type="button" data-control-tmux="${esc(pane.id)}">${t('tmux.control_pane')}</button>
        ${agent && agent.linkedSessionId ? `<button type="button" data-open-session="${esc(agent.linkedSessionId)}">${t('tmux.view_conversation')}</button>` : ""}
        </span>
        </footer>
    </article>`;
  }

  function tmuxWindowTree(window) {
    return `<div class="tmux-window-tree">
      <button type="button" class="tmux-window-node ${window.active ? "active" : ""}" data-tmux-type="window" data-tmux-id="${esc(window.id)}">
      <small>${t('tmux.open_window')}</small>
      <strong>${window.index + 1}. ${esc(window.name)}</strong>
      <span>${t('tmux.split_count', { count: window.panes.length })}</span>
      </button>
      <div class="tmux-link-line" aria-hidden="true">
      <i>
      </i>
      </div>
      <div class="tmux-pane-stack">${window.panes.map(tmuxPaneCard).join("")}</div>
      </div>`;
  }

  function tmuxSessionTree(tmuxSession) {
    return `<div class="tmux-session-tree">
      <button type="button" class="tmux-session-node ${tmuxSession.attached ? "attached" : ""}" data-tmux-type="session" data-tmux-id="${esc(tmuxSession.id)}">
      <small>${t('tmux.workspace')}</small>
      <strong>${esc(tmuxSession.name)}</strong>
      <span>${tmuxSession.attached ? t('terminal.tmux.attached') : t('terminal.tmux.running_background')} · ${t('tmux.open_window_count', { count: tmuxSession.windows.length })}</span>
      </button>
      <div class="tmux-link-line session-link" aria-hidden="true">
      <i>
      </i>
      </div>
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
    $("#tmuxStats").innerHTML = [
      [t('tmux.stats.linux_environments'), summary.distros || 0, t('ui.items')],
      [t('tmux.workspace'), summary.sessions || 0, t('ui.items')],
      [t('tmux.open_window'), summary.windows || 0, t('ui.items')],
      [t('tmux.stats.split_panes'), summary.panes || 0, t('ui.items')],
      [t('tmux.stats.ai_panes'), summary.aiPanes || 0, t('ui.items')],
      [t('tmux.stats.linked_history'), summary.linked || 0, t('ui.items')],
    ]
      .map(
        ([label, value, unit], index) => `<div class="${index >= 4 ? "accent" : ""}">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${unit}</small>
      </div>`,
      )
      .join("");
    const index = tmuxEntities(tmux);
    const path = tmuxFocusPath(index);
    $("#tmuxBreadcrumbs").innerHTML = path.length
      ? `<button type="button" data-tmux-reset>${t('tmux.full_list')}</button>${path
          .map(
            (item) => `<i>›</i>
      <button type="button"
        class="${item.type === state.tmuxFocus.type && item.id === state.tmuxFocus.id ? "current" : ""}"
        data-tmux-type="${item.type}" data-tmux-id="${esc(item.id)}">
        ${esc(item.label)}
      </button>`,
          )
          .join("")}`
      : `<span class="map-hint">
      ${t('tmux.summary', { sessions: `<b>${summary.sessions || 0}</b>`, panes: `<b>${summary.aiPanes || 0}</b>` })}</span>`;
    $("#tmuxResetBtn").classList.toggle("hidden", !path.length);
    const distros = filteredTmuxDistros(tmux, index);
    if (!distros.length || !Number(summary.sessions || 0)) {
      $("#tmuxMap").innerHTML = `<div class="tmux-empty">
        <span>▦</span>
        <h3>${t('tmux.empty.title')}</h3>
        <p>${esc(window.LoadToAgentI18n.observedText(tmux.status || t('tmux.empty.checking_linux')))}</p>
        <small>${t('tmux.empty.description')}</small>
        </div>`;
      return;
    }
    $("#tmuxMap").innerHTML = distros
      .map(
        (distro) => `<section class="tmux-distro-group">
      <button type="button" class="tmux-distro-node" data-tmux-type="distro" data-tmux-id="${esc(distro.id)}">
      <span>Linux</span>
      <div>
      <small>${t('tmux.runtime_environment')}</small>
      <strong>${esc(distro.name)}</strong>
      <em>${esc(distro.tmuxVersion || "tmux")}</em>
      </div>
      <b>${t('terminal.tmux.workspace_count', { count: distro.sessions.length })}</b>
      </button>
      <div class="tmux-distro-line" aria-hidden="true">
      </div>
      <div class="tmux-session-stack">${distro.sessions.map(tmuxSessionTree).join("")}</div>
      </section>`,
      )
      .join("");
  }

  return { tmuxEntities, tmuxFocusPath, linkedTmuxSubagents, tmuxPaneCard, tmuxWindowTree, tmuxSessionTree, filteredTmuxDistros, renderTmuxMap };
};
