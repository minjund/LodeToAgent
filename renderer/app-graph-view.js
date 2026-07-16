"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createGraphView = function createGraphView(context = {}) {
  const {
    $,
    esc,
    state,
    STATUS,
    readablePreview,
    compact,
    timeAgo,
    timeOnly,
    providerInfo,
    providerStyle,
    isProviderVisible = () => true,
    visibleProviders = () => state.providers,
    agentRoleLabel,
    statusClass,
    currentActivity,
    isLiveSession,
    subagentWorkState,
    subagentWorkLabel,
    latestWorkCopy,
    statusIcon,
    sortGraphNodes,
    graphChildren,
    agentExecutionMode,
    executionModeBadge,
    graphDescendantCount,
  } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const statusLabel = (status) => ({
    starting: t("ui.preparing"), running: t("ui.working"), waiting: t("app.nav.needs_review"), idle: t("ui.idle"),
    completed: t("ui.completed"), failed: t("ui.problem"), cancelled: t("ui.stopped"),
  })[status] || STATUS[status] || status;

  function graphNode(session, options = {}) {
    const provider = providerInfo(session.provider);
    const activity = currentActivity(session);
    const context = session.context || {};
    const usage = session.usage || {};
    const percent = Math.max(0, Math.min(100, Number(context.percent || 0)));
    const running = isLiveSession(session);
    const childCount = (session.childIds || []).length;
    const childMetrics = session.collaboration && session.collaboration.metrics;
    const cumulativeChildren = childMetrics ? childMetrics.cumulativeCreated : childCount;
    const delegation = session.delegation || {};
    const displayedTask =
      session.parentId && delegation.assignmentObserved && delegation.assignment
        ? delegation.assignment
        : session.parentId && (delegation.taskName || session.taskName)
          ? delegation.taskName || session.taskName
          : session.title;
    const goalPreview = readablePreview(displayedTask, options.focus ? 118 : 96);
    const currentWork = latestWorkCopy(session);
    const currentPreview = readablePreview(currentWork, options.focus ? 132 : 108);
    const role = session.parentId
      ? t("graph.helper_ai_identity", {
          name: session.agentName ? ` · ${session.agentName}` : "",
          role: session.agentRole ? ` / ${agentRoleLabel(session.agentRole)}` : "",
        })
      : t("graph.assigned_ai");
    return `<article class="agent-node ${running ? "running" : ""} ${session.parentId ? "child-agent" : "root-agent"} ${options.focus ? "is-focus" : ""}"
      data-motion-key="agent:${esc(session.id)}"
      data-motion-value="${esc(session.updatedAt || "")}:${usage.total || 0}:${esc(session.status || "")}"
      style="${providerStyle(session.provider)}">
      <button class="agent-node-main" type="button" data-graph-focus="${esc(session.id)}" aria-label="${esc(t("graph.focus_relationships", { role }))}">
        <span class="agent-node-top">
          <span class="provider-mark">${esc(provider.mark)}</span>
          <span class="agent-identity"><b>${esc(role)}</b><small>${esc(provider.label)} · ${esc(session.model || t("graph.model_unknown"))}</small></span>
          ${executionModeBadge(session, true)}
          <span class="status-pill ${statusClass(session.status)}">${esc(statusLabel(session.status))}</span>
        </span>
        <span class="agent-task-label">
          ${session.parentId ? t("graph.assigned_task", { source: delegation.assignmentSource === "parent-narration" ? t("graph.main_ai_explanation_suffix") : "" }) : t("graph.current_goal")}
        </span>
        <strong class="agent-task" title="${esc(goalPreview.full)}">${esc(goalPreview.text)}</strong>
        ${goalPreview.truncated ? `<span class="agent-goal-note">${esc(t("graph.summary_shown"))}</span>` : ""}
        <span class="agent-current">
          <span><i>${statusIcon(activity.type)}</i><b>${esc(t("graph.current_work"))}</b></span>
          <strong title="${esc(currentPreview.full)}">${esc(currentPreview.text)}</strong>
        </span>
        <span class="agent-node-metrics">
          <span>
          <small>${esc(t("graph.memory_usage"))}</small>
          <b>${context.window ? `${percent.toFixed(1)}%` : "--"}</b>
          </span>
          <span>
          <small>${window.LoadToAgentI18n.t("ui.tokens_used_2")}</small>
          <b>${compact(usage.total)}</b>
          </span>
          <span>
          <small>${esc(t("graph.last_activity"))}</small>
          <b>${esc(timeAgo(session.updatedAt))}</b>
          </span>
          </span>
        <span class="agent-node-gauge"><i style="width:${percent}%"></i></span>
      </button>
      <footer class="agent-node-footer">
        <span>${cumulativeChildren ? t("graph.subagents_created", { count: cumulativeChildren }) : session.parentId ? t("graph.helper_ai") : t("graph.central_ai")}</span>
        <button type="button" data-open-session="${esc(session.id)}">${esc(t("graph.view_conversation"))} <b>↗</b>
        </button>
        </footer>
    </article>`;
  }

  function compactGraphNode(session, model, label = "") {
    const provider = providerInfo(session.provider);
    const usage = session.usage || {};
    const directChildren = graphChildren(session, model).length;
    const identity = session.parentId ? t("graph.helper_ai_named", { name: session.agentName || agentRoleLabel(session.agentRole) }) : session.workspace || t("graph.central_task");
    const delegation = session.delegation || {};
    const taskName = delegation.taskName || session.taskName || "";
    const assignedWork = delegation.assignmentObserved && delegation.assignment ? delegation.assignment : taskName || session.title;
    const sharedGoal = delegation.sharedGoal || session.sharedGoal || "";
    const outcome = delegation.result || session.result || "";
    const outcomeText = outcome || latestWorkCopy(session);
    const assignedWorkPreview = readablePreview(assignedWork, session.parentId ? 110 : 104);
    const taskLabel = session.parentId ? `${label || agentRoleLabel(session.agentRole)}${taskName ? t("graph.assigned_name_suffix", { name: taskName }) : ""}` : label;
    const assignmentSourceNote =
      session.parentId && delegation.assignmentSource === "parent-narration"
        ? `<span class="agent-flow-assignment-source">${esc(t("graph.main_ai_prestart_explanation"))}</span>`
        : "";
    const sharedGoalCopy =
      session.parentId && sharedGoal && sharedGoal !== assignedWork ? `<span class="agent-flow-shared">${esc(t("graph.shared_goal"))} · ${esc(sharedGoal)}</span>` : "";
    const outcomeCopy = session.parentId
      ? `<span class="agent-flow-outcome ${session.status === "completed" ? "done" : ""}">
        <b>${esc(session.status === "completed" ? t("graph.completed_result") : t("graph.current_work"))}</b>
        <span class="agent-flow-outcome-copy" title="${esc(outcomeText)}">${esc(outcomeText)}</span>
        </span>`
      : "";
    if (session.parentId) {
      const primaryTask = taskName || assignedWork || session.title;
      const assignmentCopy =
        assignedWork && assignedWork !== primaryTask
          ? `<span class="agent-flow-assignment"><small>${esc(t("graph.assignment_details"))}</small><strong title="${esc(assignedWork)}">${esc(assignedWork)}</strong></span>`
          : "";
      const workState = subagentWorkState(session);
      const interaction = directChildren
        ? `data-graph-focus="${esc(session.id)}" aria-label="${esc(t("graph.view_child_flow", { task: primaryTask }))}"`
        : `data-open-subagent-chat="${esc(session.id)}" aria-label="${esc(t("graph.view_main_ai_conversation_for_task", { task: primaryTask }))}"`;
      const action = directChildren ? t("graph.view_child_subagents", { count: directChildren }) : t("graph.view_main_ai_conversation");
      return `<button type="button" class="agent-flow-row child-session work-${workState} ${statusClass(session.status)}"
        ${interaction}
        data-motion-key="agent:${esc(session.id)}"
        data-motion-value="${esc(session.updatedAt || "")}:${usage.total || 0}:${esc(session.status || "")}"
        style="${providerStyle(session.provider)}">
        <span class="agent-flow-state" aria-hidden="true"></span>
        <span class="agent-flow-copy">
          <span class="agent-flow-kicker">
            <small>${esc(t("graph.named_session", { name: label || agentRoleLabel(session.agentRole) }))}</small>
            <time>${esc(timeAgo(session.updatedAt))}</time>
          </span>
          <b class="agent-flow-session-title" title="${esc(primaryTask)}">${esc(primaryTask)}</b>
          <span class="agent-flow-agent">
            <i>${esc(provider.mark)}</i>
            <strong>${esc(session.agentName || t("graph.name_unknown"))}</strong>
            <small>${esc(provider.label)}${session.model ? ` · ${esc(session.model)}` : ""}</small>
            </span>
          ${assignmentCopy}${assignmentSourceNote}${outcomeCopy}<span class="agent-flow-child-action">${esc(action)}</span>
        </span>
        <span class="agent-flow-provider">
          ${executionModeBadge(session, true)}
          <small class="status-pill work-${workState}">${esc(subagentWorkLabel(session))}</small>
          ${session.status === "completed" ? `<em>${esc(t("graph.recent_work_completed"))}</em>` : ""}
        </span>
      </button>`;
    }
    return `<button type="button" class="agent-flow-row ${isLiveSession(session) ? "running" : ""} ${statusClass(session.status)}"
      data-graph-focus="${esc(session.id)}"
      data-motion-key="agent:${esc(session.id)}"
      data-motion-value="${esc(session.updatedAt || "")}:${usage.total || 0}:${esc(session.status || "")}"
      style="${providerStyle(session.provider)}">
      <span class="agent-flow-state" aria-hidden="true"></span>
      <span class="agent-flow-copy">
        ${taskLabel ? `<small>${esc(taskLabel)}</small>` : ""}
        <b title="${esc(assignedWorkPreview.full)}">${esc(assignedWorkPreview.text)}</b>
        <em>${esc(identity)} · ${directChildren ? `${t("graph.helper_ai_count", { count: directChildren })} · ` : ""}${esc(timeAgo(session.updatedAt))}</em>
        ${assignmentSourceNote}${sharedGoalCopy}${outcomeCopy}
      </span>
      <span class="agent-flow-provider"><i>${esc(provider.mark)}</i><small>${esc(statusLabel(session.status))}</small></span>
    </button>`;
  }

  function providerFlowLane(providerId, roots, model) {
    const provider = providerInfo(providerId);
    const ordered = sortGraphNodes(roots);
    const expanded = state.graphExpandedProviders.has(providerId);
    const shown = expanded ? ordered : ordered.slice(0, 6);
    const hidden = Math.max(0, ordered.length - shown.length);
    const agents = ordered.reduce((total, root) => total + 1 + graphDescendantCount(root, model), 0);
    return `<section class="agent-flow-lane" style="${providerStyle(providerId)}">
      <header class="agent-flow-lane-head">
        <span class="provider-mark">${esc(provider.mark)}</span>
        <span><b>${esc(provider.label)}</b><small>${esc(t("graph.major_tasks_and_agents", { tasks: ordered.length, agents }))}</small></span>
        <em>${esc(t("graph.running_count", { count: ordered.filter(isLiveSession).length }))}</em>
      </header>
      <div class="agent-flow-list">${shown.map((root) => compactGraphNode(root, model)).join("")}</div>
      ${
        hidden
          ? `<button type="button" class="agent-flow-more" data-graph-provider-more="${esc(providerId)}">${esc(t("graph.show_remaining_tasks", { count: hidden }))}</button>`
          : expanded && ordered.length > 6
            ? `<button type="button" class="agent-flow-more" data-graph-provider-less="${esc(providerId)}">${esc(t("graph.show_compact"))}</button>`
            : ""
      }
    </section>`;
  }

  function workflowCompactNode(session, model, side, label) {
    const port = side === "upstream" ? '<span class="agent-workflow-port output" data-workflow-port="upstream-output" aria-hidden="true"></span>' : "";
    return `<div class="agent-workflow-node ${side}" data-workflow-node="${esc(session.id)}">${port}${compactGraphNode(session, model, label)}</div>`;
  }

  function liveTmuxEntries(tmux = state.snapshot && state.snapshot.tmux) {
    const entries = [];
    for (const distro of (tmux && tmux.distros) || []) {
      for (const tmuxSession of distro.sessions || []) {
        for (const window of tmuxSession.windows || []) {
          for (const pane of window.panes || []) {
            if (!pane.agent || pane.dead || !isProviderVisible(pane.agent.provider)) continue;
            entries.push({ distro, tmuxSession, window, pane, agent: pane.agent });
          }
        }
      }
    }
    return entries.sort(
      (a, b) =>
        Number(b.pane.active) - Number(a.pane.active) ||
        Number(a.pane.dead) - Number(b.pane.dead) ||
        String(a.tmuxSession.name).localeCompare(String(b.tmuxSession.name)),
    );
  }

  function liveTmuxPaneCard(entry) {
    const { distro, tmuxSession, window, pane, agent } = entry;
    const provider = providerInfo(agent.provider);
    const linked = agent.linkedSessionId ? (state.snapshot?.sessions || []).find((session) => session.id === agent.linkedSessionId) || null : null;
    const title = linked ? linked.title : pane.title || t("graph.tmux_task", { provider: provider.label });
    const stateLabel = pane.dead ? t("graph.ended") : pane.active ? t("graph.selected_pane") : t("graph.background_running");
    return `<article class="live-tmux-card ${pane.active ? "active" : ""} ${pane.dead ? "dead" : ""}"
      style="${providerStyle(agent.provider)}"
      data-motion-key="live-tmux:${esc(pane.id)}"
      data-motion-value="${esc(agent.updatedAt || "")}:${pane.pid || 0}">
      <button type="button" class="live-tmux-pane" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}" aria-label="${esc(t("graph.open_tmux_pane", { session: tmuxSession.name }))}">
        <span class="live-tmux-card-head">
          <span class="live-tmux-symbol">▦</span><span><small>${esc(t("graph.tmux_session"))}</small><b>${esc(tmuxSession.name)}</b></span>
          <em>${esc(stateLabel)}</em>
        </span>
        <strong class="live-tmux-title">${esc(title)}</strong>
        <span class="live-tmux-agent">
          <i>${esc(provider.mark)}</i><b>${esc(provider.label)}</b>
          <small>${esc(agent.command || pane.command || "AI")}</small>
        </span>
        <span class="live-tmux-location">
          <b>${esc(distro.name)}</b>
          <i>›</i>
          <span>${esc(window.name || t("graph.window_number", { number: window.index + 1 }))}</span>
          <i>›</i>
          <span>${esc(t("graph.pane_number", { number: pane.index + 1 }))} · ${esc(pane.nativeId || pane.id)}</span>
          </span>
        <span class="live-tmux-cwd" title="${esc(pane.cwd || "")}">${esc(pane.cwd || t("graph.workspace_unknown"))}</span>
      </button>
      <footer>
        <span>${esc(linked ? t("graph.linked_to_conversation") : t("graph.detected_from_tmux"))}</span>
        <span>
          ${linked ? `<button type="button" data-graph-focus="${esc(linked.id)}">${esc(t("graph.view_ai_flow"))}</button>` : ""}
          <button type="button" class="live-tmux-pane" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}">${esc(t("graph.open_in_tmux"))}</button>
        </span>
        </footer>
    </article>`;
  }

  function runtimeSeparatedOverview(roots, model) {
    const tmux = (state.snapshot && state.snapshot.tmux) || { distros: [], summary: {} };
    const tmuxEntries = liveTmuxEntries(tmux);
    const tmuxLinkedIds = new Set(tmuxEntries.map((entry) => entry.agent.linkedSessionId).filter(Boolean));
    const tmuxRoots = roots.filter((root) => agentExecutionMode(root).kind === "tmux");
    const standardRoots = roots.filter((root) => agentExecutionMode(root).kind !== "tmux" && !tmuxLinkedIds.has(root.id));
    const providerOrder = [...new Set([...visibleProviders().map((item) => item.id), ...roots.map((item) => item.provider).filter(isProviderVisible)])];
    const lanesFor = (items) =>
      providerOrder.map((providerId) => ({ providerId, roots: items.filter((root) => root.provider === providerId) })).filter((item) => item.roots.length);
    const standardLanes = lanesFor(standardRoots);
    const fallbackTmuxRoots = tmuxRoots.filter((root) => !tmuxLinkedIds.has(root.id));
    const fallbackTmuxLanes = lanesFor(fallbackTmuxRoots);
    const tmuxDisplayCount = tmuxEntries.length + fallbackTmuxRoots.length;
    const standardHtml = standardLanes.length
      ? `<div class="agent-flow-overview">${standardLanes.map((item) => providerFlowLane(item.providerId, item.roots, model)).join("")}</div>`
      : `<div class="runtime-segment-empty"><b>${esc(t("graph.no_standard_ai"))}</b><span>${esc(t("graph.all_detected_in_tmux"))}</span></div>`;
    const tmuxHtml = `${tmuxEntries.length ? `<div class="live-tmux-grid">${tmuxEntries.map(liveTmuxPaneCard).join("")}</div>` : ""}
          ${
            fallbackTmuxLanes.length
              ? `<div class="agent-flow-overview live-tmux-fallback">
                  ${fallbackTmuxLanes.map((item) => providerFlowLane(item.providerId, item.roots, model)).join("")}
                </div>`
              : ""
          }`;
    const tmuxSection = tmuxDisplayCount
      ? `<section class="runtime-segment tmux-runtime" data-runtime-segment="tmux">
        <header>
          <span class="runtime-segment-icon">▦</span>
          <span><small>${esc(t("graph.tmux_only"))}</small><b>${esc(t("graph.tmux_sessions"))}</b><em>${esc(t("graph.tmux_runtime_description"))}</em></span>
          <strong>${esc(t("common.count", { count: tmuxDisplayCount }))}</strong>
          <button type="button" class="live-tmux-overview-open">${esc(t("graph.open_tmux_overview"))}</button>
        </header>
        ${tmuxHtml}
      </section>`
      : "";
    return `<div class="agent-runtime-split" data-runtime-split="true">
      ${tmuxSection}
      <section class="runtime-segment standard-runtime" data-runtime-segment="standard">
        <header>
          <span class="runtime-segment-icon">›_</span>
          <span><small>${esc(t("graph.without_tmux"))}</small><b>${esc(t("graph.standard_sessions"))}</b><em>${esc(t("graph.standard_runtime_description"))}</em></span>
          <strong>${esc(t("common.count", { count: standardRoots.length }))}</strong>
        </header>
        ${standardHtml}
      </section>
    </div>`;
  }

  function workflowMetrics(session, children) {
    const observed = session.collaboration && session.collaboration.metrics;
    return (
      observed || {
        cumulativeCreated: children.length,
        simultaneousCapacity: 0,
        currentlyRunning: children.filter(isLiveSession).length,
        completedRecords: children.filter((child) => child.status === "completed").length,
        retainedCount: null,
        capacitySource: "unknown",
        cumulativeSource: "child-sessions",
      }
    );
  }

  function workflowChildrenSummary(session, children) {
    if (!children.length && !(session.collaboration && session.collaboration.metrics)) return "";
    const counts = new Map();
    for (const child of children) counts.set(child.provider, (counts.get(child.provider) || 0) + 1);
    const providers = [...counts.entries()]
      .map(([providerId, count]) => {
        const provider = providerInfo(providerId);
        return `<span class="workflow-summary-chip" style="${providerStyle(providerId)}">
        <i>${esc(provider.mark)}</i>
        <b>${esc(provider.label)}</b>
        <em>${count}</em>
        </span>`;
      })
      .join("");
    const metrics = workflowMetrics(session, children);
    const capacity = metrics.simultaneousCapacity > 0 ? metrics.simultaneousCapacity : "--";
    const retained = metrics.retainedCount == null ? t("graph.retained_count_unobserved") : t("graph.retained_count", { count: metrics.retainedCount });
    const source = metrics.capacitySource === "runtime-instruction" ? t("graph.session_runtime_limit") : t("graph.capacity_source_unknown");
    return `<div class="agent-workflow-summary" data-collaboration-summary="true">
      <div class="workflow-metric-grid">
        <span data-collaboration-metric="created">
          <small>${esc(t("graph.created_in_task"))}</small><b>${esc(metrics.cumulativeCreated)}</b><em>${window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
        <span data-collaboration-metric="capacity">
          <small>${esc(t("graph.simultaneous_capacity"))}</small><b>${esc(capacity)}</b><em>${capacity === "--" ? "" : window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
        <span data-collaboration-metric="running">
          <small>${esc(t("graph.currently_running"))}</small><b>${esc(metrics.currentlyRunning)}</b><em>${window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
        <span data-collaboration-metric="completed">
          <small>${esc(t("graph.completed_records"))}</small><b>${esc(metrics.completedRecords)}</b><em>${window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
      </div>
      <div class="workflow-summary-evidence"><span>${esc(retained)} · ${esc(t("graph.completed_records_collapsed"))}</span><small>${esc(source)} · ${esc(t("graph.event_basis"))}</small></div>
      <div class="workflow-summary-providers">${providers}</div>
    </div>`;
  }

  function splitSubagents(children) {
    return children.reduce(
      (out, session) => {
        if (session.status === "completed" || session.completionObserved) out.completed.push(session);
        else out.ongoing.push(session);
        return out;
      },
      { ongoing: [], completed: [] },
    );
  }

  function completedSubagentDisclosure(ownerId, completed, expanded) {
    if (!completed.length) return "";
    return `<div class="completed-subagent-disclosure ${expanded ? "expanded" : ""}" data-completed-subagent-section>
      <button type="button" data-subagent-completed-toggle="${esc(ownerId)}" aria-expanded="${expanded ? "true" : "false"}">
        <span class="completed-disclosure-icon">✓</span>
        <span><b>${esc(t("graph.completed_subagents", { count: completed.length }))}</b>
          <small>${esc(expanded ? t("graph.completed_expanded") : t("graph.completed_collapsed_hint"))}</small>
        </span>
        <i>${esc(expanded ? t("graph.collapse") : t("graph.expand"))}</i>
      </button>
    </div>`;
  }

  function agentPathTaskName(value) {
    return (
      String(value || "")
        .replace(/\\/g, "/")
        .replace(/\/$/, "")
        .split("/")
        .filter(Boolean)
        .pop() || ""
    );
  }

  function communicationEndpoint(value, owner, model) {
    const path = String(value || "");
    if (!path) return t("graph.target_unknown");
    if (path === "Codex 런타임") return t("graph.codex_runtime");
    if (path === "/root" || path === owner.agentPath || (!owner.agentPath && path === owner.id)) return t("graph.main_ai");
    const taskName = agentPathTaskName(path);
    const session = model.nodes.find((node) => node.agentPath === path || node.taskName === taskName);
    if (session) return `${session.agentName || t("graph.sub_ai")}${taskName ? ` · ${taskName}` : ""}`;
    return taskName || path;
  }

  function workflowCommunicationPanel(focus, parent, model) {
    const owner = focus;
    const all = (owner.collaboration && owner.collaboration.communications) || [];
    const relevant = all.filter((event) => ["assignment", "started", "followup", "message", "result", "interrupt"].includes(event.kind));
    const events = relevant.slice(-60);
    if (!events.length) {
      return `<section class="agent-communication-panel empty" data-collaboration-communications="0">
        <header>
        <span>
        <b>${esc(t("graph.communication_title"))}</b>
        <small>${esc(t("graph.communication_short_description"))}</small>
        </span>
        </header>
        <p>${esc(t("graph.no_communication_events"))}</p>
        </section>`;
    }
    const rows = events
      .map((event) => {
        const text =
          event.text ||
          (event.protected
            ? t("graph.assigned_to_subagent", { task: event.taskName || t("graph.this_task") })
            : event.kind === "started"
              ? t("graph.runtime_start_confirmed")
              : t("graph.status_only_recorded"));
        const sourceLabel = event.assignmentSource === "parent-narration" ? ` · ${t("graph.main_ai_prestart_short")}` : "";
        return `<article class="agent-communication-event ${esc(event.kind)}" data-communication-kind="${esc(event.kind)}">
        <span class="communication-route">
          <b>${esc(communicationEndpoint(event.from, owner, model))}</b><i>→</i>
          <b>${esc(communicationEndpoint(event.to, owner, model))}</b>
        </span>
        <span class="communication-copy">
          <small>${esc(window.LoadToAgentI18n.observedText(event.label))}${event.taskName ? ` · ${esc(event.taskName)}` : ""}${sourceLabel}</small>
          <strong>${esc(text)}</strong>
          </span>
        <time>${esc(timeOnly(event.timestamp))}</time>
      </article>`;
      })
      .join("");
    const countLabel = relevant.length > events.length
      ? t("graph.recent_of_total_events", { recent: events.length, total: relevant.length })
      : t("common.events", { count: events.length });
    return `<section class="agent-communication-panel"
      data-collaboration-communications="${events.length}"
      data-collaboration-communications-total="${relevant.length}">
      <header>
      <span>
      <b>${esc(t("graph.communication_title"))}</b>
      <small>${esc(t("graph.communication_description"))}</small>
      </span>
      <em>${countLabel}</em>
      </header>
      <div class="agent-communication-list">${rows}</div>
      </section>`;
  }

  function focusedGraph(focus, model, motionKind = "refresh") {
    const parent = focus.parentId ? model.byId.get(focus.parentId) : null;
    const children = graphChildren(focus, model);
    const { ongoing, completed } = splitSubagents(children);
    const completedExpanded = state.expandedCompletedSubagents.has(focus.id);
    const shownChildren = completedExpanded ? [...ongoing, ...completed] : ongoing;
    const metrics = workflowMetrics(focus, children);
    const upstream = parent
      ? workflowCompactNode(parent, model, "upstream", parent.parentId ? t("graph.back_to_previous_ai") : t("graph.back_to_main_ai"))
      : `<div class="agent-workflow-origin">
        <span class="workflow-origin-icon">◎</span>
        <span>
        <b>${esc(t("graph.user_request"))}</b>
        <small>${esc(t("graph.task_origin"))}</small>
        </span>
        <span class="agent-workflow-port output" data-workflow-port="upstream-output" aria-hidden="true">
        </span>
        </div>`;
    const ongoingRows = ongoing.length
      ? ongoing.map((child) => workflowCompactNode(child, model, "downstream", agentRoleLabel(child.agentRole))).join("")
      : children.length
        ? `<div class="agent-workflow-empty current-clear"><b>${esc(t("graph.no_active_subagents"))}</b><span>${esc(t("graph.completed_available_below"))}</span></div>`
        : `<div class="agent-workflow-empty">${esc(t("graph.no_delegated_tasks"))}</div>`;
    const completedRows = completedExpanded
      ? `<div class="completed-subagent-list" data-completed-subagent-list>
          ${completed.map((child) => workflowCompactNode(child, model, "downstream", agentRoleLabel(child.agentRole))).join("")}
        </div>`
      : "";
    const downstream = `${ongoingRows}${completedSubagentDisclosure(focus.id, completed, completedExpanded)}${completedRows}`;
    const connectMotion = ["focus", "focus-back", "view"].includes(motionKind) ? "motion-connect" : "";
    const childGroupPort = shownChildren.length
      ? '<span class="agent-workflow-port input group-input" data-workflow-port="children-group-input" aria-hidden="true"></span>'
      : "";
    return `<div class="agent-workflow-canvas ${connectMotion}" data-workflow-focus="${esc(focus.id)}">
      <svg class="agent-workflow-edges" role="img" aria-label="${esc(t("graph.workflow_aria"))}">
        <title>${esc(t("graph.workflow_title"))}</title>
        <desc>${esc(t("graph.workflow_description"))}</desc>
        <defs><marker id="workflowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"></path>
        </marker></defs>
        <g data-workflow-paths></g>
      </svg>
      <div class="agent-workflow-grid">
        <section class="agent-workflow-column upstream-column">
          <header><b>${esc(parent ? t("graph.assigning_ai") : t("graph.starting_point"))}</b>
            <span>${esc(parent ? t("graph.click_left_to_go_back") : t("graph.initial_user_task"))}</span>
          </header>
          <div class="agent-workflow-stack">${upstream}</div>
        </section>
        <section class="agent-workflow-column selected-column">
          <header><b>${esc(t("graph.selected_ai"))}</b><span>${esc(focus.parentId ? t("graph.delegated_helper_ai") : t("graph.main_ai_in_charge"))}</span></header>
          <div class="agent-workflow-selected-stack">
            <div class="agent-workflow-selected">
              <span class="agent-workflow-port input" data-workflow-port="focus-input" aria-hidden="true"></span>
              ${graphNode(focus, { focus: true })}
            </div>
            ${context.agentCommandComposer(focus)}
            ${shownChildren.length ? '<span class="agent-workflow-port output" data-workflow-port="focus-output" aria-hidden="true"></span>' : ""}
          </div>
        </section>
        <section class="agent-workflow-column downstream-column"
          data-workflow-child-count="${children.length}" data-workflow-visible-child-count="${shownChildren.length}">
          ${childGroupPort}
          <header><b>${esc(t("graph.subagent_sessions"))}</b>
            <span>${esc(t("graph.subagent_visibility_summary", { ongoing: ongoing.length, completed: completed.length }))}</span>
          </header>
          ${workflowChildrenSummary(focus, children)}
          <div class="agent-workflow-stack downstream-stack ${shownChildren.length > 3 ? "density-many" : ""}">${downstream}</div>
        </section>
      </div>
      ${workflowCommunicationPanel(focus, parent, model)}
    </div>`;
  }

  return {
    graphNode, compactGraphNode, providerFlowLane, workflowCompactNode, liveTmuxEntries, liveTmuxPaneCard, runtimeSeparatedOverview,
    workflowMetrics, workflowChildrenSummary, splitSubagents, completedSubagentDisclosure, agentPathTaskName, communicationEndpoint,
    workflowCommunicationPanel, focusedGraph,
  };
};
