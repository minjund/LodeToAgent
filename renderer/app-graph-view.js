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
    isControlRoomSession = isLiveSession,
    controlRoomStatus = session => session?.status,
    sessionRetentionMinutes = () => 0,
    subagentWorkState,
    subagentWorkLabel,
    latestWorkCopy,
    statusIcon,
    sortGraphNodes,
    graphChildren,
    agentExecutionMode,
    executionModeBadge,
    graphDescendantCount,
    sessionWorkspaceLabel,
    controlRoomProject = session => ({ key: String(session?.workspace || session?.id || "unknown"), label: sessionWorkspaceLabel(session) }),
    ensureProjectOrder = projectKeys => projectKeys,
  } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const statusLabel = (status) => ({
    starting: t("ui.preparing"), running: t("ui.working"), waiting: t("ui.waiting_for_review"), idle: t("ui.idle"),
    completed: t("ui.completed"), failed: t("ui.problem"), cancelled: t("ui.stopped"),
  })[status] || STATUS[status] || status;

  function graphNode(session, options = {}) {
    const provider = providerInfo(session.provider);
    const activity = currentActivity(session);
    const context = session.context || {};
    const usage = session.usage || {};
    const percent = Math.max(0, Math.min(100, Number(context.percent || 0)));
    const running = isLiveSession(session);
    const presentationStatus = controlRoomStatus(session);
    const retained = isControlRoomSession(session) && !running;
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
          <span class="status-pill ${statusClass(presentationStatus)}">${esc(statusLabel(presentationStatus))}</span>
        </span>
        <span class="agent-task-label">
          ${session.parentId ? t("graph.assigned_task", { source: delegation.assignmentSource === "protected"
            ? t("graph.assignment_protected_suffix")
            : (delegation.assignmentSource === "parent-narration" ? t("graph.main_ai_explanation_suffix") : "") }) : t("graph.current_goal")}
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
        <span>${session.parentId
          ? (cumulativeChildren ? t("graph.subagents_created", { count: cumulativeChildren }) : t("graph.helper_ai"))
          : t("project.origin_named", { name: sessionWorkspaceLabel(session) })}</span>
        ${retained ? `<button type="button" data-session-archive="${esc(session.id)}">${esc(t("control.move_to_history"))}</button>` : ""}
        <button type="button" data-open-session="${esc(session.id)}">${esc(t("graph.view_conversation"))} <b>↗</b>
        </button>
        </footer>
    </article>`;
  }

  function compactGraphNode(session, model, label = "") {
    const provider = providerInfo(session.provider);
    const usage = session.usage || {};
    const directChildren = graphChildren(session, model).length;
    const presentationStatus = controlRoomStatus(session);
    const identity = session.parentId
      ? t("graph.helper_ai_named", { name: session.agentName || agentRoleLabel(session.agentRole) })
      : t("project.origin_named", { name: sessionWorkspaceLabel(session) });
    const delegation = session.delegation || {};
    const taskName = delegation.taskName || session.taskName || "";
    const assignedWork = delegation.assignmentObserved && delegation.assignment ? delegation.assignment : taskName || session.title;
    const sharedGoal = delegation.sharedGoal || session.sharedGoal || "";
    const outcome = delegation.result || session.result || "";
    const outcomeText = outcome || latestWorkCopy(session);
    const assignedWorkPreview = readablePreview(assignedWork, session.parentId ? 110 : 104);
    const taskLabel = session.parentId ? `${label || agentRoleLabel(session.agentRole)}${taskName ? t("graph.assigned_name_suffix", { name: taskName }) : ""}` : label;
    const assignmentSourceNote = session.parentId && delegation.assignmentSource === "protected"
      ? `<span class="agent-flow-assignment-source">${esc(t("graph.assignment_source_protected"))}</span>`
      : session.parentId && delegation.assignmentSource === "parent-narration"
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
    return `<button type="button" class="agent-flow-row ${isLiveSession(session) ? "running" : ""} ${statusClass(presentationStatus)}"
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
      <span class="agent-flow-provider"><i>${esc(provider.mark)}</i><small>${esc(statusLabel(presentationStatus))}</small></span>
    </button>`;
  }

  function providerFlowLane(providerId, roots, model) {
    const provider = providerInfo(providerId);
    const ordered = sortGraphNodes(roots);
    const expanded = state.graphExpandedProviders.has(providerId);
    const shown = expanded ? ordered : ordered.slice(0, 6);
    const hidden = Math.max(0, ordered.length - shown.length);
    const helperIds = new Set();
    const queue = ordered.flatMap((root) => root.childIds || []);
    while (queue.length) {
      const id = queue.shift();
      if (!id || helperIds.has(id)) continue;
      const helper = model.byId.get(id);
      if (!helper) continue;
      helperIds.add(id);
      queue.push(...(helper.childIds || []));
    }
    const helpers = [...helperIds].map((id) => model.byId.get(id)).filter(Boolean);
    const activeHelpers = helpers.filter(isLiveSession).length;
    return `<section class="agent-flow-lane" style="${providerStyle(providerId)}">
      <header class="agent-flow-lane-head">
        <span class="provider-mark">${esc(provider.mark)}</span>
        <span><b>${esc(provider.label)}</b><small>${esc(t("graph.major_tasks_and_agents", { tasks: ordered.length, active: activeHelpers, records: helpers.length }))}</small></span>
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

  function controlRoomDescendants(root, model) {
    const found = [];
    const queue = [...(root.childIds || [])];
    const visited = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const child = model.byId.get(id);
      if (!child) continue;
      found.push(child);
      queue.push(...(child.childIds || []));
    }
    return sortGraphNodes(found);
  }

  function controlRoomIntent(value) {
    const text = String(value || "");
    const loopCommand = ["w", "c", "c", "-loop"].join("");
    const loop = text.match(new RegExp(`^/${loopCommand}\\s+--tick\\s+([^\\s]+)`, "i"));
    if (loop) return t("control.summary_automatic_run", { name: loop[1] });
    const rules = [
      [/(?:서브\s*에이전트|helper|subagent).*(?:직접|direct).*(?:전달|메시지|message|개입)|(?:직접|direct).*(?:서브\s*에이전트|helper|subagent)/i, "control.summary_direct_helper"],
      [/(?:메인|lead).*(?:서브\s*에이전트|helper|subagent).*(?:문구|요약|설명|summary)|(?:에이전트|agent).*(?:백그라운드|실행\s*작업|execution).*(?:문구|요약|설명|summary)/i, "control.summary_agent_work_copy"],
      [/(?:전체|모든).*(?:대화|기록|메시지).*(?:생략|전체|불러|표시)|(?:full|entire).*(?:conversation|history|messages)/i, "control.summary_full_history"],
      [/(?:관제|control\s*room|실행\s*구조|홈\s*화면).*(?:에이전트|agent|세션|session|흐름|flow)/i, "control.summary_control_room"],
      [/(?:requirements?|요구사항).*(?:phase|단계).*(?:complete|완료|조건|contract)|(?:phase|단계).*(?:complete|완료).*(?:requirements?|요구사항)/i, "control.summary_phase_requirements"],
      [/(?:build|package|빌드|패키징).*(?:restart|relaunch|다시\s*(?:실행|켜)|재실행)|(?:종료|stop).*(?:빌드|build).*(?:실행|start)/i, "control.summary_build_restart"],
      [/(?:agentMonitor|snapshot\.sessions|세션\s*데이터).*(?:summary|요약|입력|확인|inspect)/i, "control.summary_session_data"],
      [/(?:test|tests|testing|pytest|jest|vitest|테스트|회귀\s*검증).*(?:result|verify|pass|결과|확인|검증)|(?:검증|verify).*(?:기능|동작|화면|UI)/i, "control.work_test"],
      [/(?:UI|화면|카드|문구|표시).*(?:가독성|읽기|요약|축약|정리|개선)/i, "control.summary_readability"],
      [/(?:bug|error|failure|오류|버그|실패).*(?:fix|resolve|수정|해결|원인)/i, "control.summary_fix_problem"],
      [/(?:review|audit|검토|감사).*(?:code|UI|화면|구조|변경|코드)/i, "control.summary_review"],
      [/(?:read|inspect|analy[sz]e|search|확인|조사|분석|검색).*(?:file|code|config|log|파일|코드|설정|로그)/i, "control.work_inspect_code"],
    ];
    const matched = rules.find(([pattern]) => pattern.test(text));
    return matched ? t(matched[1]) : text;
  }

  function controlRoomSummary(value, maxCharacters = 64) {
    const cleaned = String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/^[\s>*#\-\d.)]+/, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/^(?:now\s+)?(?:i(?:'ll|\s+will)|let\s+me|next,?)\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return readablePreview(t("control.work_unknown"), maxCharacters);
    const intent = controlRoomIntent(cleaned);
    const sentence = intent === cleaned ? cleaned.match(/^(.{12,}?[.!?。！？])(?:\s|$)/)?.[1] || cleaned : intent;
    return readablePreview(sentence, maxCharacters);
  }

  function controlRoomAgentGoal(session, maxCharacters = 64) {
    const delegation = session.delegation || {};
    const messages = session.messages || [];
    const userGoal = [...messages].reverse().find(message => message.role === "user" && message.text && !/^\s*\/[\w-]+(?:\s|$)/.test(message.text));
    const title = String(session.title || "");
    const source = delegation.assignment || session.sharedGoal || title
      || userGoal?.text || delegation.taskName || session.taskName || latestWorkCopy(session);
    return controlRoomSummary(source, maxCharacters);
  }

  function looksLikeExecutionCommand(value) {
    const text = String(value || "").trim();
    return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun|npx|node|git|rg|grep|findstr|python|pytest|gradle|mvn|docker|curl|pwsh|powershell|cmd|start-process|get-content|select-string)\b/i.test(text)
      || /(?:--[\w-]+|\\[^\s]+|\/[\w.-]+\.[a-z0-9]{1,8})/i.test(text);
  }

  function inferredExecutionSummary(activity) {
    const command = String(activity.command || "").replace(/\s+/g, " ").trim();
    const searchable = `${activity.description || ""} ${activity.label || ""} ${command}`.toLowerCase();
    const patterns = [
      [/(?:electron-builder|\bdist(?::win)?\b|\bpackage\b|\bportable\b|\bnsis\b)/, "control.work_package_app"],
      [/(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|\bdev\s+server\b|개발\s*서버/, "control.work_dev_server"],
      [/\b(?:test|tests|pytest|jest|vitest|playwright|cypress)\b|테스트|회귀\s*검증/, "control.work_test"],
      [/\b(?:build|compile|tsc)\b|빌드|컴파일/, "control.work_build"],
      [/\b(?:install|npm\s+ci|pnpm\s+i)\b|패키지\s*설치|의존성/, "control.work_install"],
      [/\b(?:lint|eslint|stylelint)\b|정적\s*검사/, "control.work_lint"],
      [/\b(?:format|prettier)\b|코드\s*정리/, "control.work_format"],
      [/\bgit\s+(?:status|diff|show|log)\b|변경\s*(?:내용|사항).*확인/, "control.work_review_changes"],
      [/\bgit\s+commit\b|커밋/, "control.work_save_changes"],
      [/\bgit\s+push\b|업로드|배포/, "control.work_publish"],
      [/(?:\brg\b|grep|findstr|select-string|get-content|read-file|코드.*확인|파일.*확인)/, "control.work_inspect_code"],
      [/(?:start-process|loadtoagent\.exe|electron\s+\.)|프로그램\s*실행|앱\s*실행/, "control.work_launch_app"],
      [/(?:index|인덱스).*(?:refresh|update|갱신)/, "control.work_refresh_index"],
      [/(?:crawl|scrape|수집)/, "control.work_collect_data"],
    ];
    const matched = patterns.find(([pattern]) => pattern.test(searchable));
    if (matched) return controlRoomSummary(t(matched[1]), 58);
    const label = String(activity.description || activity.label || "").trim();
    const generic = /^(?:shell|셸\s*명령|background|백그라운드\s*(?:작업|명령|실행)|foreground|포그라운드\s*(?:작업|명령|실행)|일반\s*명령\s*실행)$/i.test(label);
    if (label && !generic && !looksLikeExecutionCommand(label)) return controlRoomSummary(label, 58);
    if (command) return controlRoomSummary(command.replace(/^[^\s]+\s+/, ""), 58);
    return controlRoomSummary(t("control.work_background"), 58);
  }

  function controlRoomChildNode(child) {
    const provider = providerInfo(child.provider);
    const delegation = child.delegation || {};
    const assignment = delegation.assignment || delegation.taskName || child.taskName || child.title;
    const current = controlRoomSummary(latestWorkCopy(child) || child.statusDetail || assignment, 72);
    const assignmentPreview = controlRoomAgentGoal(child, 58);
    const workState = subagentWorkState(child);
    return `<button type="button" class="control-room-node helper-node is-${esc(workState)} ${child.status === "starting" ? "is-spawning" : ""}"
      data-open-subagent-chat="${esc(child.id)}"
      data-control-summary="${esc(assignmentPreview.text)}"
      data-motion-key="control-helper:${esc(child.id)}"
      data-motion-value="${esc(child.status || "")}:${esc(child.updatedAt || "")}"
      style="${providerStyle(child.provider)}" aria-label="${esc(t("control.open_subagent", { task: assignment }))}">
      <span class="control-node-icon">${esc(provider.mark)}</span>
      <span class="control-node-copy"><small>${esc(t("control.subagent_work"))} · ${esc(provider.label)}</small><b title="${esc(assignmentPreview.full)}">${esc(assignmentPreview.text)}</b><em title="${esc(current.full)}">${esc(t("control.current_summary", { summary: current.text }))}</em></span>
      <span class="control-node-state"><i aria-hidden="true"></i><b>${esc(subagentWorkLabel(child))}</b></span>
    </button>`;
  }

  function controlRoomExecutionNode(item) {
    const { activity, owner } = item;
    const summary = inferredExecutionSummary(activity);
    const command = controlRoomSummary(activity.command || activity.description || activity.label || summary.full, 76);
    const runtime = activity.kind === "shell"
      ? activity.runtime || state.platform?.localShellLabel || activity.tool || "PowerShell"
      : activity.runtime || activity.tool || t("graph.background_task");
    const executionKind = activity.mode === "background" || activity.status === "running"
      ? t("control.background_work_kind")
      : t("control.command_work_kind");
    const executionLabel = t("control.runtime_work", { runtime, kind: executionKind });
    const ownerGoal = controlRoomAgentGoal(owner, 52);
    const running = activity.status === "running";
    const stateClass = running ? "is-running" : (activity.status === "unverified" ? "is-unverified" : "is-complete");
    return `<button type="button" class="control-room-node execution-node ${stateClass}"
      data-open-execution-owner="${esc(owner.id)}"
      data-open-execution-id="${esc(activity.id)}"
      data-control-summary="${esc(summary.text)}"
      data-motion-key="control-execution:${esc(activity.id)}"
      data-motion-value="${esc(activity.status || "")}:${esc(activity.updatedAt || activity.startedAt || "")}"
      aria-label="${esc(t("control.open_execution_detail", { task: summary.text }))}">
      <span class="control-node-icon">${activity.kind === "shell" ? "›_" : "◌"}</span>
      <span class="control-node-copy"><small title="${esc(runtime)}">${esc(executionLabel)}</small><b title="${esc(summary.full)}">${esc(summary.text)}</b><em title="${esc(command.full)}">${esc(t("control.execution_context", { task: ownerGoal.text }))}</em></span>
      <span class="control-node-state"><i aria-hidden="true"></i><b>${esc(executionActivityStatus(activity))}</b></span>
    </button>`;
  }

  function controlRoomSession(root, model) {
    const provider = providerInfo(root.provider);
    const presentationStatus = controlRoomStatus(root);
    const waiting = presentationStatus === "waiting";
    const retained = isControlRoomSession(root) && !isLiveSession(root);
    const descendants = controlRoomDescendants(root, model);
    const actors = [root, ...descendants];
    const executionItems = actors.flatMap(owner => (owner.executions || []).map(activity => ({ activity, owner })));
    const activeChildren = descendants.filter(child => ["starting", "running", "paused", "waiting"].includes(child.status) && !child.completionObserved);
    const completedChildren = descendants.filter(child => ["completed", "cancelled", "failed"].includes(child.status) || child.completionObserved);
    const activeExecutions = executionItems.filter(item => item.activity.status === "running");
    const completedExecutions = executionItems
      .filter(item => item.activity.status !== "running")
      .sort((a, b) => Date.parse(b.activity.updatedAt || b.activity.startedAt || 0) - Date.parse(a.activity.updatedAt || a.activity.startedAt || 0));
    const activeUnits = [...activeChildren.map(child => ({ kind: "child", child })), ...activeExecutions.map(item => ({ kind: "execution", item }))];
    const completedUnits = [
      ...completedChildren.map(child => ({ kind: "child", child, timestamp: child.completedAt || child.updatedAt })),
      ...completedExecutions.map(item => ({ kind: "execution", item, timestamp: item.activity.updatedAt || item.activity.startedAt })),
    ].sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0)).slice(0, 3);
    const current = controlRoomSummary(latestWorkCopy(root) || root.statusDetail || root.title, 74);
    const title = controlRoomAgentGoal(root, 64);
    const unitCount = activeUnits.length;
    const main = `<button type="button" class="control-room-main" data-open-session="${esc(root.id)}"
      data-control-summary="${esc(title.text)}"
      data-motion-key="control-main:${esc(root.id)}" data-motion-value="${esc(root.updatedAt || "")}:${esc(root.status || "")}"
      style="${providerStyle(root.provider)}">
      <span class="control-main-top"><span class="provider-mark">${esc(provider.mark)}</span><span><small>${esc(t("control.main_agent"))}</small><b>${esc(provider.label)} · ${esc(root.model || t("session.model_unknown"))}</b></span><em><i aria-hidden="true"></i>${esc(statusLabel(presentationStatus))}</em></span>
      <strong title="${esc(title.full)}">${esc(title.text)}</strong>
      <span class="control-main-now"><small>${esc(t("graph.current_work"))}</small><b title="${esc(current.full)}">${esc(current.text)}</b></span>
      <span class="control-main-meta"><small>${esc(t("control.unit_counts", { helpers: activeChildren.length, executions: activeExecutions.length }))}</small><b>${esc(t("graph.view_conversation"))} →</b></span>
    </button>`;
    const shownActiveUnits = activeUnits.slice(0, 6);
    const hiddenActiveUnits = Math.max(0, activeUnits.length - shownActiveUnits.length);
    const active = activeUnits.length
      ? `${shownActiveUnits.map(unit => unit.kind === "child" ? controlRoomChildNode(unit.child) : controlRoomExecutionNode(unit.item)).join("")}${hiddenActiveUnits ? `<button type="button" class="control-room-node overflow-node" data-graph-focus="${esc(root.id)}"><span class="control-node-icon">+${hiddenActiveUnits}</span><span class="control-node-copy"><small>${esc(t("control.more_live_units"))}</small><b>${esc(t("control.open_remaining_units", { count: hiddenActiveUnits }))}</b><em>${esc(t("control.open_full_flow"))}</em></span><span class="control-node-state"><b>→</b></span></button>` : ""}`
      : `<div class="control-room-running-empty"><span>○</span><small>${esc(t("control.running_empty"))}</small></div>`;
    const completed = completedUnits.length
      ? completedUnits.map(unit => unit.kind === "child" ? controlRoomChildNode(unit.child) : controlRoomExecutionNode(unit.item)).join("")
      : `<div class="control-room-complete-empty"><span>✓</span><small>${esc(t("control.completed_empty"))}</small></div>`;
    const waitingWithBackground = waiting && activeExecutions.some(item => item.activity.mode === "background" || item.activity.kind === "background");
    const sessionStateKey = waitingWithBackground
      ? "control.waiting_background_session"
      : (waiting ? "control.waiting_session" : (retained ? "control.recently_completed" : "control.live_session"));
    const retention = retained ? `<small class="control-session-retention">${esc(t("control.auto_history_in_minutes", { minutes: sessionRetentionMinutes(root) }))}</small>` : "";
    const archive = retained ? `<button type="button" class="control-session-archive" data-session-archive="${esc(root.id)}">${esc(t("control.move_to_history"))}</button>` : "";
    return `<article class="control-room-session ${waiting ? "is-waiting" : ""} ${waitingWithBackground ? "has-background-work" : ""}" data-control-session="${esc(root.id)}" data-session-sortable="${esc(root.id)}"
      style="${providerStyle(root.provider)}" role="group" tabindex="0" draggable="true" aria-grabbed="false"
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-label="${esc(t("session.drag_label", { title: title.text }))}" aria-describedby="sessionReorderHelp">
      <header><div><span class="control-session-live"><i></i>${esc(t(sessionStateKey))}</span><b>${esc(title.text)}</b>${retention}</div><span class="session-drag-handle" aria-hidden="true" title="${esc(t("session.reorder_hint"))}"></span>${archive}<button type="button" class="control-session-flow" data-graph-focus="${esc(root.id)}">${esc(t("control.open_full_flow"))} ↗</button></header>
      <div class="control-room-flow">
        <section class="control-room-column main-column"><span class="control-column-label">${esc(t("control.main_work_column"))}</span>${main}</section>
        <span class="control-flow-link live" aria-hidden="true"><i></i></span>
        <section class="control-room-column activity-column"><span class="control-column-label">${esc(t("control.running_work_column"))}<b>${unitCount}</b></span><div class="control-room-node-list">${active}</div></section>
        <span class="control-flow-link complete" aria-hidden="true"><i></i></span>
        <section class="control-room-column completed-column"><span class="control-column-label">${esc(t("control.completed_work_column"))}<b>${completedUnits.length}</b></span><div class="control-room-node-list completed-list">${completed}</div></section>
      </div>
    </article>`;
  }

  function runtimeSeparatedOverview(roots, model, allRoots = roots) {
    const projectDescriptor = (root) => {
      const project = controlRoomProject(root);
      return { key: project.key, name: project.label };
    };
    const allGroups = new Map();
    allRoots.forEach((root) => {
      const { key, name } = projectDescriptor(root);
      if (!allGroups.has(key)) allGroups.set(key, { name, roots: [] });
      allGroups.get(key).roots.push(root);
    });
    const groups = new Map();
    roots.forEach((root) => {
      const { key, name } = projectDescriptor(root);
      if (!groups.has(key)) groups.set(key, { name, roots: [] });
      groups.get(key).roots.push(root);
    });
    const defaultOrderedGroups = [...groups.entries()].sort(([leftKey], [rightKey]) =>
      Number(allGroups.get(rightKey)?.roots.length || 0) - Number(allGroups.get(leftKey)?.roots.length || 0));
    const projectOrder = ensureProjectOrder(defaultOrderedGroups.map(([key]) => key));
    const projectRank = new Map(projectOrder.map((key, index) => [key, index]));
    const orderedGroups = defaultOrderedGroups.sort(([leftKey], [rightKey]) =>
      Number(projectRank.get(leftKey) ?? Number.MAX_SAFE_INTEGER) - Number(projectRank.get(rightKey) ?? Number.MAX_SAFE_INTEGER));
    const projectGroups = orderedGroups.map(([key, { name, roots: projectRoots }], index) => {
      const projectTotals = allGroups.get(key)?.roots || projectRoots;
      const activeCount = projectTotals.filter((root) => isLiveSession(root)).length;
      const attentionCount = projectTotals.filter((root) =>
        !isLiveSession(root)
        && isControlRoomSession(root)
        && ["waiting", "failed", "paused"].includes(root.status)).length;
      const summary = attentionCount
        ? t("control.project_live_attention_summary", { active: activeCount, attention: attentionCount })
        : t("control.project_live_summary", { active: activeCount });
      const disclosureKey = `control-project:${key}`;
      const presentation = index === 0 ? "is-primary" : "is-secondary";
      const projectFocusId = projectRoots[0]?.id || "";
      return `<details class="control-room-project-group ${presentation}" data-control-project="${esc(name)}" data-project-sortable="${esc(key)}" data-disclosure-key="${esc(disclosureKey)}">
        <summary class="control-project-header" data-project-toggle="${esc(name)}" draggable="true" aria-grabbed="false"
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-label="${esc(t("project.drag_label", { name }))}" aria-describedby="projectReorderHelp">
          <span class="control-project-heading"><i aria-hidden="true">□</i><b>${esc(name)}</b><small>${esc(summary)}</small><em>${projectTotals.length}</em></span>
          <span class="control-project-handle" aria-hidden="true" title="${esc(t("project.reorder_hint"))}"></span>
        </summary>
        <button type="button" class="control-project-flow-link" data-graph-focus="${esc(projectFocusId)}"><span>${esc(t("control.open_full_flow"))} ↗</span></button>
        <div class="control-project-body">${projectRoots.map(root => controlRoomSession(root, model)).join("")}</div>
      </details>`;
    }).join("");
    return `<div class="control-room-overview" data-control-room-overview="true">
      ${projectGroups}
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
        const sourceLabel = event.assignmentSource === "protected"
          ? ` · ${t("graph.assignment_source_protected_short")}`
          : (event.assignmentSource === "parent-narration" ? ` · ${t("graph.main_ai_prestart_short")}` : "");
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

  function executionActivityLabel(activity) {
    if (activity.kind === "background") return t("graph.background_task");
    return activity.mode === "background" ? t("graph.shell_background") : t("graph.shell_foreground");
  }

  function executionActivityStatus(activity) {
    return ({
      running: t("graph.execution_running"),
      completed: t("graph.execution_completed"),
      failed: t("graph.execution_failed"),
      unverified: t("graph.execution_unverified"),
      cancelled: t("ui.stopped"),
    })[activity.status] || activity.status;
  }

  function executionActivityCard(activity, ownerId = "") {
    const label = executionActivityLabel(activity);
    const command = readablePreview(activity.command || activity.label || label, 150);
    const handle = activity.backgroundId
      ? `${activity.backgroundIdType || t("graph.execution_handle")} · ${activity.backgroundId}`
      : "";
    const runtime = activity.runtime || activity.tool || t("graph.runtime_unknown");
    return `<details class="execution-activity-card ${esc(activity.kind || "background")} ${esc(activity.mode || "foreground")} ${esc(activity.status || "completed")}"
      data-disclosure-key="${esc(`graph:execution:${ownerId}:${activity.id}`)}"
      data-execution-activity="${esc(activity.id)}"
      data-execution-kind="${esc(activity.kind || "")}" data-execution-mode="${esc(activity.mode || "")}" data-execution-status="${esc(activity.status || "")}">
      <summary>
        <span class="execution-activity-icon" aria-hidden="true">${activity.kind === "shell" ? "›_" : "◌"}</span>
        <span class="execution-activity-copy">
          <span class="execution-activity-kicker"><b>${esc(label)}</b><small>${esc(runtime)}</small></span>
          <strong title="${esc(command.full)}">${esc(activity.label || command.text)}</strong>
          ${activity.command ? `<code title="${esc(activity.command)}">${esc(command.text)}</code>` : ""}
          <span class="execution-activity-meta">
            ${activity.cwd ? `<small title="${esc(activity.cwd)}">${esc(t("graph.execution_workdir"))} · ${esc(activity.cwd)}</small>` : ""}
            ${handle ? `<small>${esc(handle)}</small>` : ""}
          </span>
        </span>
        <span class="execution-activity-state"><span><i aria-hidden="true"></i><b>${esc(executionActivityStatus(activity))}</b></span><small>${esc(activity.statusDetail || timeAgo(activity.updatedAt || activity.startedAt))}</small><span class="execution-activity-disclosure"><b class="open-label">${esc(t("graph.execution_details"))}</b><b class="close-label">${esc(t("graph.execution_details_close"))}</b><i aria-hidden="true">⌄</i></span></span>
      </summary>
      <div class="execution-activity-detail">
        <div class="execution-detail-command"><header><span>${esc(t("graph.execution_command"))}</span><button type="button" data-copy-text="${esc(activity.command || activity.label || command.full)}">${esc(t("graph.copy_command"))}</button></header><code>${esc(activity.command || activity.label || command.full)}</code></div>
        <dl>
          <div><dt>${esc(t("graph.execution_status_label"))}</dt><dd>${esc(executionActivityStatus(activity))}${activity.statusDetail ? ` · ${esc(activity.statusDetail)}` : ""}</dd></div>
          <div><dt>${esc(t("graph.execution_runtime"))}</dt><dd>${esc(runtime)}</dd></div>
          ${activity.cwd ? `<div><dt>${esc(t("graph.execution_workdir"))}</dt><dd title="${esc(activity.cwd)}">${esc(activity.cwd)}</dd></div>` : ""}
          ${handle ? `<div><dt>${esc(t("graph.execution_handle"))}</dt><dd>${esc(handle)}</dd></div>` : ""}
          ${activity.startedAt ? `<div><dt>${esc(t("graph.execution_started"))}</dt><dd title="${esc(activity.startedAt)}">${esc(timeAgo(activity.startedAt))}</dd></div>` : ""}
          ${activity.updatedAt ? `<div><dt>${esc(t("graph.execution_updated"))}</dt><dd title="${esc(activity.updatedAt)}">${esc(timeAgo(activity.updatedAt))}</dd></div>` : ""}
        </dl>
        <div class="execution-detail-output"><header><span>${esc(t("graph.execution_output"))}</span>${activity.output ? `<button type="button" data-copy-text="${esc(activity.output)}">${esc(t("graph.copy_output"))}</button>` : ""}</header>${activity.output ? `<pre>${esc(activity.output)}</pre>` : `<p>${esc(t("graph.execution_output_unavailable"))}</p>`}</div>
      </div>
    </details>`;
  }

  function executionActivityPanel(session) {
    const activities = [...(session.executions || [])].sort((a, b) => {
      const activeA = a.status === "running" ? 1 : 0;
      const activeB = b.status === "running" ? 1 : 0;
      return activeB - activeA || Date.parse(b.updatedAt || b.startedAt || 0) - Date.parse(a.updatedAt || a.startedAt || 0);
    });
    if (!activities.length) return "";
    const running = activities.filter((activity) => activity.status === "running");
    const completed = activities.filter((activity) => activity.status !== "running");
    const expanded = state.expandedExecutionSessions.has(session.id);
    const shown = expanded ? activities : [...running, ...completed.slice(0, Math.max(0, 6 - running.length))];
    return `<section class="execution-activity-panel" data-execution-activities="${activities.length}" data-running-executions="${running.length}">
      <header>
        <span><b>${esc(t("graph.execution_activity"))}</b><small>${esc(t("graph.execution_activity_description"))}</small></span>
        <em>${esc(t("graph.execution_activity_summary", { running: running.length, total: activities.length }))}</em>
      </header>
      <div class="execution-activity-list">${shown.map(activity => executionActivityCard(activity, session.id)).join("")}</div>
      ${shown.length < activities.length
        ? `<button type="button" class="execution-activity-retained" data-execution-history-toggle="${esc(session.id)}" aria-expanded="false">${esc(t("graph.execution_show_older", { count: activities.length - shown.length }))}</button>`
        : expanded && activities.length > 6
          ? `<button type="button" class="execution-activity-retained" data-execution-history-toggle="${esc(session.id)}" aria-expanded="true">${esc(t("graph.execution_collapse_older"))}</button>`
          : ""}
    </section>`;
  }

  function focusedGraph(focus, model, motionKind = "refresh") {
    const parent = focus.parentId ? model.byId.get(focus.parentId) : null;
    const children = graphChildren(focus, model);
    const executionCount = (focus.executions || []).length;
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
        : executionCount
          ? ""
          : `<div class="agent-workflow-empty">${esc(t("graph.no_delegated_tasks"))}</div>`;
    const completedRows = completedExpanded
      ? `<div class="completed-subagent-list" data-completed-subagent-list>
          ${completed.map((child) => workflowCompactNode(child, model, "downstream", agentRoleLabel(child.agentRole))).join("")}
        </div>`
      : "";
    const downstream = `${ongoingRows}${completedSubagentDisclosure(focus.id, completed, completedExpanded)}${completedRows}`;
    const connectMotion = ["focus", "focus-back", "view"].includes(motionKind) ? "motion-connect" : "";
    const childGroupPort = shownChildren.length || executionCount
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
            ${shownChildren.length || executionCount ? '<span class="agent-workflow-port output" data-workflow-port="focus-output" aria-hidden="true"></span>' : ""}
          </div>
        </section>
        <section class="agent-workflow-column downstream-column"
          data-workflow-child-count="${children.length}" data-workflow-visible-child-count="${shownChildren.length}">
          ${childGroupPort}
          <header><b>${esc(t("graph.observed_execution_units"))}</b>
            <span>${esc(t("graph.execution_unit_summary", { subagents: children.length, executions: executionCount }))}</span>
          </header>
          ${executionActivityPanel(focus)}
          ${children.length ? `<div class="subagent-execution-heading"><b>${esc(t("graph.subagent_sessions"))}</b><span>${esc(t("graph.subagent_visibility_summary", { ongoing: ongoing.length, completed: completed.length }))}</span></div>` : ""}
          ${workflowChildrenSummary(focus, children)}
          <div class="agent-workflow-stack downstream-stack ${shownChildren.length > 3 ? "density-many" : ""}">${downstream}</div>
        </section>
      </div>
      ${workflowCommunicationPanel(focus, parent, model)}
    </div>`;
  }

  return {
    graphNode, compactGraphNode, providerFlowLane, workflowCompactNode, liveTmuxEntries, liveTmuxPaneCard, runtimeSeparatedOverview,
    controlRoomIntent, controlRoomSummary, controlRoomAgentGoal, inferredExecutionSummary,
    workflowMetrics, workflowChildrenSummary, splitSubagents, completedSubagentDisclosure, agentPathTaskName, communicationEndpoint,
    workflowCommunicationPanel, executionActivityLabel, executionActivityStatus, executionActivityCard, executionActivityPanel, focusedGraph,
  };
};
