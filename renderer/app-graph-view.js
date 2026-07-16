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
      ? `도움 AI${session.agentName ? ` · ${session.agentName}` : ""}${session.agentRole ? ` / ${agentRoleLabel(session.agentRole)}` : ""}`
      : "일을 맡은 AI";
    return `<article class="agent-node ${running ? "running" : ""} ${session.parentId ? "child-agent" : "root-agent"} ${options.focus ? "is-focus" : ""}"
      data-motion-key="agent:${esc(session.id)}"
      data-motion-value="${esc(session.updatedAt || "")}:${usage.total || 0}:${esc(session.status || "")}"
      style="${providerStyle(session.provider)}">
      <button class="agent-node-main" type="button" data-graph-focus="${esc(session.id)}" aria-label="${esc(role)} 관계 중심으로 보기">
        <span class="agent-node-top">
          <span class="provider-mark">${esc(provider.mark)}</span>
          <span class="agent-identity"><b>${esc(role)}</b><small>${esc(provider.label)} · ${esc(session.model || "모델 정보 없음")}</small></span>
          ${executionModeBadge(session, true)}
          <span class="status-pill ${statusClass(session.status)}">${esc(STATUS[session.status] || session.status)}</span>
        </span>
        <span class="agent-task-label">
          ${session.parentId ? `담당 작업${delegation.assignmentSource === "parent-narration" ? " · 메인 AI 설명 기반" : ""}` : "지금 목표"}
        </span>
        <strong class="agent-task" title="${esc(goalPreview.full)}">${esc(goalPreview.text)}</strong>
        ${goalPreview.truncated ? '<span class="agent-goal-note">요약 표시 · 전체 내용은 대화 상세에서 확인</span>' : ""}
        <span class="agent-current">
          <span><i>${statusIcon(activity.type)}</i><b>지금 하는 일</b></span>
          <strong title="${esc(currentPreview.full)}">${esc(currentPreview.text)}</strong>
        </span>
        <span class="agent-node-metrics">
          <span>
          <small>기억 공간 사용</small>
          <b>${context.window ? `${percent.toFixed(1)}%` : "--"}</b>
          </span>
          <span>
          <small>${window.LoadToAgentI18n.t("ui.tokens_used_2")}</small>
          <b>${compact(usage.total)}</b>
          </span>
          <span>
          <small>마지막 활동</small>
          <b>${esc(timeAgo(session.updatedAt))}</b>
          </span>
          </span>
        <span class="agent-node-gauge"><i style="width:${percent}%"></i></span>
      </button>
      <footer class="agent-node-footer">
        <span>${cumulativeChildren ? `서브에이전트 ${cumulativeChildren}개 누적 생성` : session.parentId ? "도움을 맡은 AI" : "이 작업의 중심 AI"}</span>
        <button type="button" data-open-session="${esc(session.id)}">대화 내용 보기 <b>↗</b>
        </button>
        </footer>
    </article>`;
  }

  function compactGraphNode(session, model, label = "") {
    const provider = providerInfo(session.provider);
    const usage = session.usage || {};
    const directChildren = graphChildren(session, model).length;
    const identity = session.parentId ? `도움 AI ${session.agentName || agentRoleLabel(session.agentRole)}` : session.workspace || "중심 작업";
    const delegation = session.delegation || {};
    const taskName = delegation.taskName || session.taskName || "";
    const assignedWork = delegation.assignmentObserved && delegation.assignment ? delegation.assignment : taskName || session.title;
    const sharedGoal = delegation.sharedGoal || session.sharedGoal || "";
    const outcome = delegation.result || session.result || "";
    const outcomeText = outcome || latestWorkCopy(session);
    const assignedWorkPreview = readablePreview(assignedWork, session.parentId ? 110 : 104);
    const taskLabel = session.parentId ? `${label || agentRoleLabel(session.agentRole)}${taskName ? ` · 담당 ${taskName}` : ""}` : label;
    const assignmentSourceNote =
      session.parentId && delegation.assignmentSource === "parent-narration"
        ? '<span class="agent-flow-assignment-source">메인 AI가 작업 시작 직전에 설명한 내용</span>'
        : "";
    const sharedGoalCopy =
      session.parentId && sharedGoal && sharedGoal !== assignedWork ? `<span class="agent-flow-shared">공유 목표 · ${esc(sharedGoal)}</span>` : "";
    const outcomeCopy = session.parentId
      ? `<span class="agent-flow-outcome ${session.status === "completed" ? "done" : ""}">
        <b>${session.status === "completed" ? "완료 결과" : "현재 작업"}</b>
        <span class="agent-flow-outcome-copy" title="${esc(outcomeText)}">${esc(outcomeText)}</span>
        </span>`
      : "";
    if (session.parentId) {
      const primaryTask = taskName || assignedWork || session.title;
      const assignmentCopy =
        assignedWork && assignedWork !== primaryTask
          ? `<span class="agent-flow-assignment"><small>담당 내용</small><strong title="${esc(assignedWork)}">${esc(assignedWork)}</strong></span>`
          : "";
      const workState = subagentWorkState(session);
      const interaction = directChildren
        ? `data-graph-focus="${esc(session.id)}" aria-label="${esc(primaryTask)}의 하위 서브에이전트 흐름 보기"`
        : `data-open-subagent-chat="${esc(session.id)}" aria-label="${esc(primaryTask)}와 메인 AI의 대화 보기"`;
      const action = directChildren ? `하위 서브에이전트 ${directChildren}개 보기 →` : "메인 AI와의 대화 보기 →";
      return `<button type="button" class="agent-flow-row child-session work-${workState} ${statusClass(session.status)}"
        ${interaction}
        data-motion-key="agent:${esc(session.id)}"
        data-motion-value="${esc(session.updatedAt || "")}:${usage.total || 0}:${esc(session.status || "")}"
        style="${providerStyle(session.provider)}">
        <span class="agent-flow-state" aria-hidden="true"></span>
        <span class="agent-flow-copy">
          <span class="agent-flow-kicker">
            <small>${esc(label || agentRoleLabel(session.agentRole))} 세션</small>
            <time>${esc(timeAgo(session.updatedAt))}</time>
          </span>
          <b class="agent-flow-session-title" title="${esc(primaryTask)}">${esc(primaryTask)}</b>
          <span class="agent-flow-agent">
            <i>${esc(provider.mark)}</i>
            <strong>${esc(session.agentName || "이름 미확인")}</strong>
            <small>${esc(provider.label)}${session.model ? ` · ${esc(session.model)}` : ""}</small>
            </span>
          ${assignmentCopy}${assignmentSourceNote}${outcomeCopy}<span class="agent-flow-child-action">${esc(action)}</span>
        </span>
        <span class="agent-flow-provider">
          ${executionModeBadge(session, true)}
          <small class="status-pill work-${workState}">${esc(subagentWorkLabel(session))}</small>
          ${session.status === "completed" ? "<em>최근 작업 완료</em>" : ""}
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
        <em>${esc(identity)} · ${directChildren ? `도움 AI ${directChildren}명 · ` : ""}${esc(timeAgo(session.updatedAt))}</em>
        ${assignmentSourceNote}${sharedGoalCopy}${outcomeCopy}
      </span>
      <span class="agent-flow-provider"><i>${esc(provider.mark)}</i><small>${esc(STATUS[session.status] || session.status)}</small></span>
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
        <span><b>${esc(provider.label)}</b><small>${ordered.length}개 큰 일 · 참여 AI ${agents}명</small></span>
        <em>${ordered.filter(isLiveSession).length}개 진행 중</em>
      </header>
      <div class="agent-flow-list">${shown.map((root) => compactGraphNode(root, model)).join("")}</div>
      ${
        hidden
          ? `<button type="button" class="agent-flow-more" data-graph-provider-more="${esc(providerId)}">나머지 ${hidden}개 일도 보기</button>`
          : expanded && ordered.length > 6
            ? `<button type="button" class="agent-flow-more" data-graph-provider-less="${esc(providerId)}">간단히 보기</button>`
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
            if (!pane.agent || pane.dead) continue;
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
    const title = linked ? linked.title : pane.title || `${provider.label} TMUX 작업`;
    const stateLabel = pane.dead ? "종료됨" : pane.active ? "현재 선택된 칸" : "백그라운드 실행";
    return `<article class="live-tmux-card ${pane.active ? "active" : ""} ${pane.dead ? "dead" : ""}"
      style="${providerStyle(agent.provider)}"
      data-motion-key="live-tmux:${esc(pane.id)}"
      data-motion-value="${esc(agent.updatedAt || "")}:${pane.pid || 0}">
      <button type="button" class="live-tmux-pane" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}" aria-label="${esc(tmuxSession.name)} TMUX 칸 열기">
        <span class="live-tmux-card-head">
          <span class="live-tmux-symbol">▦</span><span><small>TMUX 세션</small><b>${esc(tmuxSession.name)}</b></span>
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
          <span>${esc(window.name || `창 ${window.index + 1}`)}</span>
          <i>›</i>
          <span>칸 ${pane.index + 1} · ${esc(pane.nativeId || pane.id)}</span>
          </span>
        <span class="live-tmux-cwd" title="${esc(pane.cwd || "")}">${esc(pane.cwd || "작업 폴더 미확인")}</span>
      </button>
      <footer>
        <span>${linked ? "대화 기록과 연결됨" : "TMUX 프로세스에서 직접 감지"}</span>
        <span>
          ${linked ? `<button type="button" data-graph-focus="${esc(linked.id)}">AI 흐름 보기</button>` : ""}
          <button type="button" class="live-tmux-pane" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}">TMUX에서 열기 →</button>
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
    const providerOrder = [...new Set([...state.providers.map((item) => item.id), ...roots.map((item) => item.provider)])];
    const lanesFor = (items) =>
      providerOrder.map((providerId) => ({ providerId, roots: items.filter((root) => root.provider === providerId) })).filter((item) => item.roots.length);
    const standardLanes = lanesFor(standardRoots);
    const fallbackTmuxRoots = tmuxRoots.filter((root) => !tmuxLinkedIds.has(root.id));
    const fallbackTmuxLanes = lanesFor(fallbackTmuxRoots);
    const tmuxDisplayCount = tmuxEntries.length + fallbackTmuxRoots.length;
    const standardHtml = standardLanes.length
      ? `<div class="agent-flow-overview">${standardLanes.map((item) => providerFlowLane(item.providerId, item.roots, model)).join("")}</div>`
      : '<div class="runtime-segment-empty"><b>일반 실행 AI가 없습니다</b><span>현재 감지된 작업은 모두 TMUX에서 실행 중입니다.</span></div>';
    const tmuxHtml =
      tmuxEntries.length || fallbackTmuxLanes.length
        ? `${tmuxEntries.length ? `<div class="live-tmux-grid">${tmuxEntries.map(liveTmuxPaneCard).join("")}</div>` : ""}
          ${
            fallbackTmuxLanes.length
              ? `<div class="agent-flow-overview live-tmux-fallback">
                  ${fallbackTmuxLanes.map((item) => providerFlowLane(item.providerId, item.roots, model)).join("")}
                </div>`
              : ""
          }`
        : '<div class="runtime-segment-empty tmux"><b>TMUX에서 실행 중인 AI가 없습니다</b><span>TMUX AI 프로세스가 감지되면 일반 실행과 분리해 여기에 표시합니다.</span></div>';
    return `<div class="agent-runtime-split" data-runtime-split="true">
      <section class="runtime-segment tmux-runtime" data-runtime-segment="tmux">
        <header>
          <span class="runtime-segment-icon">▦</span>
          <span><small>TMUX 전용</small><b>TMUX 세션</b><em>Linux 작업 묶음·창·분할 칸을 유지해서 실행 중인 AI</em></span>
          <strong>${tmuxDisplayCount}개</strong>
          <button type="button" class="live-tmux-overview-open">TMUX 전체 화면 →</button>
        </header>
        ${tmuxHtml}
      </section>
      <section class="runtime-segment standard-runtime" data-runtime-segment="standard">
        <header>
          <span class="runtime-segment-icon">›_</span>
          <span><small>TMUX 미사용</small><b>일반 실행 세션</b><em>Codex 앱·외부 터미널에서 실행 중인 메인 AI</em></span>
          <strong>${standardRoots.length}개</strong>
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
    const retained = metrics.retainedCount == null ? "현재 목록 유지 수는 관측되지 않음" : `현재 런타임 목록에는 ${metrics.retainedCount}개 유지`;
    const source = metrics.capacitySource === "runtime-instruction" ? "세션 런타임 한도" : "동시 한도 출처 미확인";
    return `<div class="agent-workflow-summary" data-collaboration-summary="true">
      <div class="workflow-metric-grid">
        <span data-collaboration-metric="created">
          <small>이 작업에서 누적 생성</small><b>${esc(metrics.cumulativeCreated)}</b><em>${window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
        <span data-collaboration-metric="capacity">
          <small>동시에 유지 가능</small><b>${esc(capacity)}</b><em>${capacity === "--" ? "" : window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
        <span data-collaboration-metric="running">
          <small>현재 실행 중</small><b>${esc(metrics.currentlyRunning)}</b><em>${window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
        <span data-collaboration-metric="completed">
          <small>작업 완료 기록</small><b>${esc(metrics.completedRecords)}</b><em>${window.LoadToAgentI18n.t("ui.items")}</em>
        </span>
      </div>
      <div class="workflow-summary-evidence"><span>${esc(retained)} · 완료 기록은 삭제하지 않고 기본으로 접어 보관</span><small>${esc(source)} · spawn/완료 이벤트 기준</small></div>
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
        <span><b>완료된 서브에이전트 ${completed.length}개</b>
          <small>${expanded ? "완료 기록을 펼쳐 보는 중" : "작업 중인 AI에 집중할 수 있도록 기본으로 접어둡니다"}</small>
        </span>
        <i>${expanded ? "접기 ↑" : "펼쳐 보기 ↓"}</i>
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
    if (!path) return "대상 미상";
    if (path === "Codex 런타임") return path;
    if (path === "/root" || path === owner.agentPath || (!owner.agentPath && path === owner.id)) return "메인 AI";
    const taskName = agentPathTaskName(path);
    const session = model.nodes.find((node) => node.agentPath === path || node.taskName === taskName);
    if (session) return `${session.agentName || "서브 AI"}${taskName ? ` · ${taskName}` : ""}`;
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
        <b>메인 AI ↔ 서브에이전트 소통</b>
        <small>배정·추가 지시·결과 반환 기록</small>
        </span>
        </header>
        <p>이 세션 로그에서는 에이전트 간 통신 이벤트가 확인되지 않았습니다.</p>
        </section>`;
    }
    const rows = events
      .map((event) => {
        const text =
          event.text ||
          (event.protected
            ? `${event.taskName || "이 작업"}을 서브에이전트에게 배정했습니다.`
            : event.kind === "started"
              ? "런타임에서 실행 시작을 확인했습니다."
              : "내용 없이 상태만 기록되었습니다.");
        const sourceLabel = event.assignmentSource === "parent-narration" ? " · 작업 시작 직전 메인 AI 설명" : "";
        return `<article class="agent-communication-event ${esc(event.kind)}" data-communication-kind="${esc(event.kind)}">
        <span class="communication-route">
          <b>${esc(communicationEndpoint(event.from, owner, model))}</b><i>→</i>
          <b>${esc(communicationEndpoint(event.to, owner, model))}</b>
        </span>
        <span class="communication-copy">
          <small>${esc(event.label)}${event.taskName ? ` · ${esc(event.taskName)}` : ""}${sourceLabel}</small>
          <strong>${esc(text)}</strong>
          </span>
        <time>${esc(timeOnly(event.timestamp))}</time>
      </article>`;
      })
      .join("");
    const countLabel = relevant.length > events.length ? `최근 ${events.length} / 전체 ${relevant.length}건` : `${events.length}건`;
    return `<section class="agent-communication-panel"
      data-collaboration-communications="${events.length}"
      data-collaboration-communications-total="${relevant.length}">
      <header>
      <span>
      <b>메인 AI ↔ 서브에이전트 소통</b>
      <small>누가 일을 맡겼고, 언제 시작했으며, 어떤 결과를 돌려줬는지 시간순으로 표시</small>
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
      ? workflowCompactNode(parent, model, "upstream", parent.parentId ? "이전 AI로 돌아가기" : "메인 AI로 돌아가기")
      : `<div class="agent-workflow-origin">
        <span class="workflow-origin-icon">◎</span>
        <span>
        <b>사용자 요청</b>
        <small>이 작업이 시작된 곳</small>
        </span>
        <span class="agent-workflow-port output" data-workflow-port="upstream-output" aria-hidden="true">
        </span>
        </div>`;
    const ongoingRows = ongoing.length
      ? ongoing.map((child) => workflowCompactNode(child, model, "downstream", agentRoleLabel(child.agentRole))).join("")
      : children.length
        ? '<div class="agent-workflow-empty current-clear"><b>현재 작업 중인 서브에이전트가 없습니다</b><span>완료된 기록은 아래에서 필요할 때만 펼쳐볼 수 있습니다.</span></div>'
        : '<div class="agent-workflow-empty">아직 다른 AI에게 나눠 맡긴 일이 없습니다.</div>';
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
      <svg class="agent-workflow-edges" role="img" aria-label="일을 맡긴 AI에서 선택한 AI를 거쳐 도움 AI로 이어지는 연결">
        <title>AI 작업 연결</title>
        <desc>왼쪽은 일을 맡긴 곳, 가운데는 선택한 AI, 오른쪽은 나눠 맡긴 AI입니다.</desc>
        <defs><marker id="workflowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"></path>
        </marker></defs>
        <g data-workflow-paths></g>
      </svg>
      <div class="agent-workflow-grid">
        <section class="agent-workflow-column upstream-column">
          <header><b>${parent ? "이 일을 맡긴 AI" : "작업 시작점"}</b>
            <span>${parent ? "왼쪽을 눌러 이전으로 돌아가요" : "사용자가 처음 맡긴 일"}</span>
          </header>
          <div class="agent-workflow-stack">${upstream}</div>
        </section>
        <section class="agent-workflow-column selected-column">
          <header><b>지금 선택한 AI</b><span>${focus.parentId ? "도움을 나눠 맡은 AI" : "전체 일을 맡은 메인 AI"}</span></header>
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
          <header><b>서브에이전트 세션</b>
            <span>진행·대기 ${ongoing.length}개 바로 표시 · 완료 ${completed.length}개 기본 숨김</span>
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
