"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createRuntimeOverview = function createRuntimeOverview(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $,
    esc,
    uiLocale,
    state,
    providerInfo,
    providerStyle,
    currentActivity,
    visibleSessions = () => ((state.snapshot && state.snapshot.sessions) || []),
    isProviderVisible = () => true,
    isRuntimeLoopSession = () => false,
  } = context;

  let runtimeTicker = 0;
  let runtimeRenderVersion = 0;
  let pendingRuntimeFocus = null;

  function activeRootLoops() {
    return visibleSessions()
      .filter(isRuntimeLoopSession)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

  function visibleAutomations() {
    return ((state.snapshot && state.snapshot.automations) || [])
      .filter((item) => isProviderVisible(item.provider || "codex"))
      .sort((a, b) => Date.parse(a.nextRunAt || 0) - Date.parse(b.nextRunAt || 0)
        || Number(b.enabled) - Number(a.enabled));
  }

  function automationSession(item) {
    if (!item || !item.targetThreadId) return null;
    return visibleSessions().find((session) => session.externalId === item.targetThreadId || session.id === item.targetThreadId) || null;
  }

  function localComputerName() {
    if (state.platform?.id === "win32") return "내 Windows 컴퓨터";
    if (state.platform?.id === "darwin") return "내 Mac";
    return "이 컴퓨터";
  }

  function automationComputer(item) {
    if (item?.environment?.kind === "wsl") {
      const name = item.environment.distro || item.sourceLabel;
      return name ? `다른 Linux 컴퓨터 (${name})` : t("runtime.location_separated");
    }
    return localComputerName();
  }

  function koreanClock(hours, minutes = 0) {
    const normalizedHour = Number(hours) || 0;
    const normalizedMinute = Number(minutes) || 0;
    return `${String(normalizedHour).padStart(2, "0")}:${String(normalizedMinute).padStart(2, "0")}`;
  }

  function scheduleTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("runtime.not_scheduled");
    const korean = String(uiLocale()).toLowerCase().startsWith("ko");
    const time = korean
      ? koreanClock(date.getHours(), date.getMinutes())
      : date.toLocaleTimeString(uiLocale(), { hour: "numeric", minute: "2-digit" });
    if (korean) {
      const dateLabel = `${date.getMonth() + 1}/${date.getDate()}`;
      return t("runtime.today_at", { date: dateLabel, time });
    }
    return date.toLocaleString(uiLocale(), { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  }

  function scheduleRule(value, nextRunAt = "") {
    const rule = Object.fromEntries(String(value || "").split(";").map((pair) => pair.split("=", 2)).filter((pair) => pair.length === 2));
    const interval = Math.max(1, Number.parseInt(rule.INTERVAL || "1", 10) || 1);
    const frequencyKeys = {
      DAILY: "runtime.every_day",
      WEEKLY: "runtime.every_week",
      HOURLY: "runtime.every_hour",
      MINUTELY: "runtime.every_minute",
    };
    const intervalKeys = {
      DAILY: "runtime.every_n_days",
      WEEKLY: "runtime.every_n_weeks",
      HOURLY: "runtime.every_n_hours",
      MINUTELY: "runtime.every_n_minutes",
    };
    const base = interval > 1 && intervalKeys[rule.FREQ]
      ? t(intervalKeys[rule.FREQ], { count: interval })
      : frequencyKeys[rule.FREQ] ? t(frequencyKeys[rule.FREQ]) : t("runtime.recurring");
    const details = [];
    let dayLabels = [];
    if (rule.BYDAY) {
      const weekdayDates = { SU: 4, MO: 5, TU: 6, WE: 7, TH: 8, FR: 9, SA: 10 };
      dayLabels = rule.BYDAY.split(",")
        .map((day) => weekdayDates[day])
        .filter(Boolean)
        .map((day) => new Intl.DateTimeFormat(uiLocale(), { weekday: "short" }).format(new Date(2026, 0, day)));
      if (dayLabels.length) details.push(dayLabels.join("·"));
    }
    if (String(uiLocale()).toLowerCase().startsWith("ko")) {
      const minute = Number.parseInt(rule.BYMINUTE || "0", 10) || 0;
      if (rule.FREQ === "HOURLY") {
        const next = new Date(nextRunAt);
        const nextClock = Number.isNaN(next.getTime()) ? "" : koreanClock(next.getHours(), next.getMinutes());
        return nextClock ? `오늘 ${nextClock}부터 중지할 때까지 ${base} 반복` : `중지할 때까지 ${base} 반복`;
      }
      if (rule.FREQ === "MINUTELY") return `${base} 실행`;
      if (rule.BYHOUR) {
        const clock = koreanClock(Number.parseInt(rule.BYHOUR, 10) || 0, minute);
        return [base, dayLabels.join("·"), `${clock}에 실행`].filter(Boolean).join(" ");
      }
      return `${base} 실행`;
    }
    if (rule.BYHOUR) {
      const hour = String(rule.BYHOUR).padStart(2, "0");
      const minute = String(rule.BYMINUTE || "0").padStart(2, "0");
      details.push(`${hour}:${minute}`);
    } else if (rule.FREQ === "HOURLY" && rule.BYMINUTE) {
      details.push(t("runtime.at_minute", { minute: Number.parseInt(rule.BYMINUTE, 10) || 0 }));
    }
    return [base, ...details].join(" · ");
  }

  function loopPhase(session) {
    const explicitPhase = String(session.loop && session.loop.phase || "").toLowerCase();
    const explicitIndex = { input: 0, decide: 1, decision: 1, act: 2, action: 2, observe: 3, observation: 3 }[explicitPhase];
    if (Number.isInteger(explicitIndex)) return explicitIndex;
    const event = [...(session.lifecycle || [])].reverse().find((item) => item.status === "running")
      || (session.lifecycle || [])[session.lifecycle.length - 1]
      || {};
    const signal = `${event.type || ""} ${event.label || ""}`.toLowerCase();
    if (/result|output|wait|complete|observe|검수|확인/.test(signal)) return 3;
    if (/tool|collaboration|command|exec|실행|도구/.test(signal)) return 2;
    if (/reason|think|decid|추론|판단/.test(signal)) return 1;
    return 0;
  }

  function loopPhases(session) {
    const active = loopPhase(session);
    const definitions = [
      ["input", "runtime.phase_input", "runtime.phase_input_detail"],
      ["decide", "runtime.phase_decide", "runtime.phase_decide_detail"],
      ["act", "runtime.phase_act", "runtime.phase_act_detail"],
      ["observe", "runtime.phase_observe", "runtime.phase_observe_detail"],
    ];
    return definitions.map(([key, label, detail], index) => ({
      key,
      label: t(label),
      detail: t(detail),
      state: index < active ? "done" : index === active ? "active" : "queued",
    }));
  }

  function loopPhaseDisplay(session, phase) {
    if (!phase || phase.key !== "observe") return phase?.label || "";
    return "결과 확인 필요";
  }

  function phaseStatusLabel(stateValue) {
    return t({ done: "runtime.phase_done", active: "runtime.phase_active", queued: "runtime.phase_queued" }[stateValue] || "runtime.phase_queued");
  }

  function elapsedSince(value) {
    if (!value) return t("runtime.just_started");
    const elapsed = Date.now() - Date.parse(value || 0);
    if (!Number.isFinite(elapsed) || elapsed < 60_000) return t("runtime.just_started");
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 60) return t("runtime.elapsed_minutes", { count: minutes });
    return t("runtime.elapsed_hours", { count: Math.floor(minutes / 60) });
  }

  function activityAge(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t("memory.time_unknown");
    const locale = uiLocale();
    return new Intl.DateTimeFormat(locale, {
      year: "numeric", month: "long", day: "numeric",
      hour: String(locale).toLowerCase().startsWith("ko") ? "2-digit" : "numeric",
      minute: "2-digit",
      ...(String(locale).toLowerCase().startsWith("ko") ? { hourCycle: "h23" } : {}),
    }).format(date);
  }

  function scheduleCard(item) {
    const session = automationSession(item);
    const scheduleProvider = providerInfo(item.provider || "codex");
    const cwd = (item.cwds || [])[0] || "";
    const savedWorkspace = (state.workspaces || []).find((item) => String(item.path || "").toLowerCase() === String(cwd).toLowerCase());
    const folderName = String(cwd).replace(/\\/g, "/").split("/").filter(Boolean).pop();
    const location = savedWorkspace?.name || folderName || (item.environment?.kind === "wsl" && item.sourceLabel) || t("runtime.workspace_unspecified");
    const locationMissing = location === t("runtime.workspace_unspecified");
    const scheduleReady = Boolean(item.enabled && !locationMissing);
    const localPlatformName = ({ win32: "Windows", darwin: "macOS", linux: "Linux" })[state.platform?.id]
      || state.platform?.label
      || "이 컴퓨터";
    const executionLocation = item.environment?.kind === "wsl"
      ? automationComputer(item)
      : t("runtime.location_this_computer", { computer: localComputerName(), platform: localPlatformName });
    const selected = Boolean(session && session.id === state.selectedRuntimeLoopId);
    const body = `<span class="runtime-schedule-time" ${scheduleReady ? `data-runtime-next-run-at="${esc(item.nextRunAt || "")}"` : ""}>${esc(item.enabled
      ? locationMissing ? t("runtime.location_needed_before_next") : scheduleTime(item.nextRunAt)
      : t("runtime.paused"))}</span>
      <strong>${esc(item.name)}</strong>
      <small>${esc(locationMissing
        ? t("runtime.choose_location_action")
        : t(item.environment?.kind === "wsl" ? "runtime.schedule_meta_separated" : "runtime.schedule_meta_local", {
            rule: scheduleRule(item.rrule, item.nextRunAt),
            location: executionLocation,
            folder: location,
          }))}</small>
      <em class="runtime-schedule-provider">담당 AI: ${esc(scheduleProvider.label)} · 이 일정을 바꾸려면 ${esc(scheduleProvider.label)} 앱을 여세요.</em>
      ${locationMissing ? `<span class="runtime-schedule-action">${esc(t("runtime.choose_location_button"))}</span>` : ""}`;
    const badge = locationMissing
      ? t("runtime.incomplete_badge")
      : scheduleReady ? t("runtime.enabled_badge") : t("runtime.paused_badge");
    const cardStateClass = locationMissing ? "incomplete" : scheduleReady ? "" : "paused";
    const card = session
      ? `<button type="button" class="runtime-schedule-card ${cardStateClass} ${selected ? "selected" : ""}" data-automation-id="${esc(item.id)}" data-automation-enabled="${scheduleReady ? "true" : "false"}" data-automation-state="${locationMissing ? "incomplete" : scheduleReady ? "enabled" : "paused"}" data-automation-session="${esc(session.id)}">${body}<i>담당 AI 열기 →</i></button>`
      : `<article class="runtime-schedule-card ${cardStateClass}" data-automation-id="${esc(item.id)}" data-automation-enabled="${scheduleReady ? "true" : "false"}" data-automation-state="${locationMissing ? "incomplete" : scheduleReady ? "enabled" : "paused"}">${body}<i>${esc(badge)}</i></article>`;
    return `<div class="runtime-schedule-item" role="listitem">${card}</div>`;
  }

  function emptySchedules() {
    return `<div class="runtime-schedule-empty"><span aria-hidden="true">＋</span><div><b>${esc(t("runtime.no_schedules"))}</b><small>${esc(t("runtime.no_schedules_detail"))}</small></div></div>`;
  }

  function loopSelector(loop, selected) {
    const provider = providerInfo(loop.provider);
    const activePhase = loopPhases(loop).find((phase) => phase.state === "active") || loopPhases(loop)[0];
    const phaseLabel = loopPhaseDisplay(loop, activePhase);
    const linkedSchedule = visibleAutomations().find((item) => automationSession(item)?.id === loop.id);
    const scheduleName = linkedSchedule?.name || loop.loop?.scheduleName || t("runtime.linked_schedule_unknown");
    const workName = loop.shortTitle || loop.displayName || loop.title;
    return `<button type="button" class="runtime-loop-tab ${selected ? "selected" : ""}" data-loop-select="${esc(loop.id)}"
      id="runtime-loop-tab-${esc(loop.id)}" role="tab" aria-controls="runtime-loop-panel-${esc(loop.id)}"
      style="${providerStyle(loop.provider)}" aria-selected="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}">
      <span class="runtime-loop-tab-mark">${esc(provider.mark)}</span>
      <span><b>${esc(t("runtime.loop_work_name", { name: workName }))}</b><small><span>${esc(t("runtime.phase_value", { phase: phaseLabel }))}</span><span>${esc(t("runtime.working_ai", { provider: provider.label }))}</span><span>${esc(t("runtime.loop_started_schedule", { name: scheduleName }))}</span></small></span>
      <i>${esc(t(selected ? "runtime.details_shown_below" : "runtime.view_details"))}</i>
    </button>`;
  }

  function loopDiagram(session) {
    const phases = loopPhases(session);
    const activeIndex = Math.max(0, phases.findIndex((phase) => phase.state === "active"));
    const activePhase = phases[activeIndex];
    return `<div class="runtime-loop-cycle" role="img" aria-label="${esc(t("runtime.loop_flow_state", { phase: activePhase.label }))}" style="--loop-progress:${activeIndex / Math.max(1, phases.length - 1) * 100}%">
      <div class="runtime-loop-spine" aria-hidden="true"><span></span></div>
      ${phases.map((phase, index) => `<div class="runtime-loop-phase ${phase.state}" data-loop-phase="${phase.key}">
        <span class="runtime-loop-phase-index">${index + 1}단계<em>${esc(phaseStatusLabel(phase.state))}</em></span>
        <i aria-hidden="true">${phase.state === "done" ? "✓" : phase.state === "active" ? "●" : "·"}</i>
        <b>${esc(phase.label)}</b>
        <small>${esc(phase.detail)}</small>
      </div>`).join("")}
      <div class="runtime-loop-return" aria-hidden="true"><span>↺</span><b>${esc(t("runtime.phase_repeat"))}</b></div>
    </div>`;
  }

  function loopDetail(session, labelledByTab = false) {
    const provider = providerInfo(session.provider);
    const activity = currentActivity(session);
    const children = (session.childIds || []).map((id) => visibleSessions().find((item) => item.id === id)).filter(Boolean);
    const runningChildren = children.filter((item) => ["running", "starting"].includes(item.status)).length;
    const iteration = Number(session.loop && session.loop.iteration || 0);
    const iterationLabel = iteration > 0
      ? t("runtime.iteration_value", { count: iteration })
      : session.loop ? t("runtime.iteration_observed") : t("runtime.iteration_scheduled");
    const iterationTitle = iteration > 0 || session.loop ? t("runtime.iteration") : t("runtime.start_method");
    const activePhase = loopPhases(session).find((phase) => phase.state === "active") || loopPhases(session)[0];
    const phaseKind = session.loop && typeof session.loop === "object" && String(session.loop.phase || "").trim()
      ? "runtime.current_phase"
      : "runtime.expected_phase";
    const resultNeedsReview = /결과|확인/.test(String(activePhase.label || ""));
    const activityTitle = resultNeedsReview
      ? "AI 작업이 끝났습니다. 결과를 확인해 주세요."
      : window.LoadToAgentI18n.observedText(activity.title);
    const activityDetail = resultNeedsReview
      ? "결과 화면을 열어보기만 해도 작업이 멈추거나 확인 완료로 바뀌지 않습니다."
      : window.LoadToAgentI18n.observedText(activity.detail || session.statusDetail || "");
    const linkedAutomation = visibleAutomations().find((item) => automationSession(item)?.id === session.id);
    const linkedAutomationName = linkedAutomation?.name || t("runtime.linked_schedule_unknown");
    const panelSemantics = labelledByTab
      ? ` role="tabpanel" aria-labelledby="runtime-loop-tab-${esc(session.id)}"`
      : "";
    return `<article id="runtime-loop-panel-${esc(session.id)}" class="runtime-loop-detail"${panelSemantics} style="${providerStyle(session.provider)}" data-motion-key="runtime-loop:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || "")}">
      <header>
        <div><span class="runtime-loop-kicker"><i></i>${esc(t("runtime.active_loop"))}</span><h3>${esc(session.displayName || session.title)}</h3><p>${esc(t("runtime.linked_schedule", { name: linkedAutomationName, started: activityAge(session.startedAt || session.updatedAt) }))}</p></div>
        <div class="runtime-loop-header-actions"><span class="runtime-active-phase"><small>${esc(t(phaseKind, { provider: provider.label }))}</small><b>${esc(activePhase.label)}</b><em>${esc(t("runtime.working_ai", { provider: provider.label }))}</em></span></div>
      </header>
      <section class="runtime-now-strip" aria-label="${esc(t("runtime.now_working"))}">
        <span class="runtime-now-mark" aria-hidden="true">현재</span>
        <div><small>${esc(t("runtime.now_working"))}</small><b title="${esc(activityTitle)}">${esc(activityTitle)}</b><p title="${esc(activityDetail)}">${esc(t("runtime.detail_work", { detail: activityDetail }))}</p></div>
        <time data-runtime-provider="${esc(provider.label)}" data-runtime-updated-at="${esc(session.updatedAt || session.startedAt || "")}">${esc(t("runtime.last_signal_time", { provider: provider.label, time: activityAge(session.updatedAt || session.startedAt) }))}</time>
      </section>
      <div class="runtime-open-action runtime-result-next"><button type="button" class="runtime-open-task" data-loop-open="${esc(session.id)}">완료된 결과 열어 확인하기 →</button><small>결과를 본 뒤 <b>‘확인 완료’</b>를 누르면 이 작업이 확인 완료로 바뀝니다.</small></div>
      ${loopDiagram(session)}
      <footer class="runtime-loop-footer">
        <dl>
          <div><dt>${esc(t("runtime.running_time"))}</dt><dd data-runtime-started-at="${esc(session.startedAt || "")}">${esc(elapsedSince(session.startedAt))}</dd></div>
          <div><dt>${esc(iterationTitle)}</dt><dd>${esc(iterationLabel)}</dd></div>
          <div><dt>${esc(t("runtime.subagents"))}</dt><dd>${runningChildren ? esc(t("runtime.subagents_running", { running: runningChildren, total: children.length })) : esc(t("runtime.subagents_total", { count: children.length }))}</dd></div>
        </dl>
      </footer>
    </article>`;
  }

  function hiddenLoopPanel(session) {
    return `<div id="runtime-loop-panel-${esc(session.id)}" class="runtime-loop-panel-shell" role="tabpanel" aria-labelledby="runtime-loop-tab-${esc(session.id)}" hidden></div>`;
  }

  function noActiveLoop() {
    return `<div class="runtime-loop-empty"><span class="runtime-loop-empty-orbit" aria-hidden="true"><i></i></span><div><b>${esc(t("runtime.no_active_loop"))}</b><p>${esc(t("runtime.no_active_loop_detail"))}</p></div></div>`;
  }

  function refreshRuntimeTimes(section = $("#automationOverview")) {
    if (!section || section.classList.contains("hidden")) return;
    section.querySelectorAll("[data-runtime-next-run-at]").forEach((element) => {
      element.textContent = scheduleTime(element.dataset.runtimeNextRunAt);
    });
    section.querySelectorAll("[data-runtime-started-at]").forEach((element) => {
      element.textContent = elapsedSince(element.dataset.runtimeStartedAt);
    });
    section.querySelectorAll("[data-runtime-updated-at]").forEach((element) => {
      element.textContent = t("runtime.last_signal_time", { provider: element.dataset.runtimeProvider || "AI", time: activityAge(element.dataset.runtimeUpdatedAt) });
    });
  }

  function ensureRuntimeTicker() {
    if (runtimeTicker) return;
    runtimeTicker = window.setInterval(() => refreshRuntimeTimes(), 30_000);
  }

  function renderRuntimeOverview() {
    const renderVersion = ++runtimeRenderVersion;
    const section = $("#automationOverview");
    const previousScheduleList = section.querySelector(".runtime-schedule-list");
    const previousLoopTabs = section.querySelector(".runtime-loop-tabs");
    const otherWorkOpen = Boolean(section.querySelector(".runtime-other-work")?.open);
    const scheduleLaneOpen = Boolean(section.querySelector(".runtime-schedule-lane")?.open);
    const previousSelectedId = section.querySelector(".runtime-loop-tab.selected")?.dataset.loopSelect || "";
    const scheduleScrollTop = previousScheduleList?.scrollTop || 0;
    const loopScrollLeft = previousLoopTabs?.scrollLeft || 0;
    const restoreScheduleFocus = document.activeElement === previousScheduleList;
    const focusedAutomationId = document.activeElement?.closest?.("[data-automation-id]")?.dataset.automationId || "";
    const focusedLoopId = document.activeElement?.closest?.("[data-loop-select]")?.dataset.loopSelect || "";
    const detectedFocus = restoreScheduleFocus
      ? { type: "schedule-list", id: "" }
      : focusedAutomationId ? { type: "automation", id: focusedAutomationId }
        : focusedLoopId ? { type: "loop", id: focusedLoopId } : null;
    if (detectedFocus) pendingRuntimeFocus = detectedFocus;
    const focusIntent = detectedFocus || pendingRuntimeFocus;
    const automations = visibleAutomations();
    const interactiveScheduleCount = automations.filter((item) => automationSession(item)).length;
    const scheduleListFocusable = automations.length > 0 && interactiveScheduleCount === 0;
    const scheduleListLabel = scheduleListFocusable
      ? t("runtime.schedule_list_scroll_label")
      : interactiveScheduleCount > 0 ? t("runtime.schedule_list_action_label") : t("runtime.schedule_list_label");
    const loops = activeRootLoops();
    const hasLocation = (item) => Boolean((item.cwds || [])[0] || (item.environment?.kind === "wsl" && item.sourceLabel));
    const enabled = automations.filter((item) => item.enabled && hasLocation(item));
    const inactiveScheduleCount = Math.max(0, automations.length - enabled.length);
    if (!loops.some((loop) => loop.id === state.selectedRuntimeLoopId)) state.selectedRuntimeLoopId = loops[0] && loops[0].id || null;
    const selected = loops.find((loop) => loop.id === state.selectedRuntimeLoopId) || loops[0] || null;
    const selectedActivePhase = selected
      ? (loopPhases(selected).find((phase) => phase.state === "active") || loopPhases(selected)[0])
      : null;
    const resultReviewCount = selectedActivePhase && /결과|확인/.test(String(selectedActivePhase.label || "")) ? 1 : 0;
    const runningLoopCount = Math.max(0, loops.length - resultReviewCount);
    const selectedId = selected?.id || "";
    const hasLoopTabs = loops.length > 1;
    const loopPanels = selected
      ? loops.map(loop => loop.id === selectedId ? loopDetail(loop, hasLoopTabs) : hiddenLoopPanel(loop)).join("")
      : noActiveLoop();
    const selectedAutomation = selected
      ? automations.find((item) => automationSession(item)?.id === selected.id)
      : null;
    const displayedAutomations = selectedAutomation
      ? [selectedAutomation, ...automations.filter((item) => item.id !== selectedAutomation.id)]
      : automations;
    const primaryAutomation = displayedAutomations[0] || null;
    const secondaryAutomations = displayedAutomations.slice(1);
    const selectedComputer = selectedAutomation ? automationComputer(selectedAutomation) : localComputerName();
    const selectedScheduleName = selectedAutomation?.name || t("runtime.linked_schedule_unknown");
    section.innerHTML = `<header class="runtime-overview-head">
      <div class="runtime-overview-title"><span class="runtime-overview-emblem" aria-hidden="true"><i></i><b>↻</b></span><div><p>${esc(t("runtime.eyebrow"))}</p><h2>${esc(t("runtime.status_summary"))}</h2></div></div>
      <div class="runtime-overview-counts">
        <span class="runtime-schedule-count"><b>반복 일정 ${automations.length}개</b><small>작동 중 ${enabled.length}개 · 일시 중지 ${inactiveScheduleCount}개</small></span>
        <span class="runtime-work-count"><b>오늘 실행 ${loops.length}건</b><small>처리 중 ${runningLoopCount}건 · 확인 대기 ${resultReviewCount}건</small></span>
        <p>반복 일정 1개가 하루에 여러 번 실행될 수 있어 일정 수와 실행 건수는 다를 수 있습니다.</p>
      </div>
    </header>
    <div class="runtime-overview-grid">
      <section class="runtime-loop-lane" aria-label="${esc(t("runtime.loop_lane", { count: loops.length }))}">
        ${loopPanels}
        ${hasLoopTabs ? `<details class="runtime-loop-lane-head runtime-other-work"${otherWorkOpen ? " open" : ""}><summary>지금 실행 중인 작업 ${loops.length - 1}건 보기 <i aria-hidden="true">⌄</i></summary><div class="runtime-loop-tabs" role="tablist" aria-orientation="horizontal" aria-label="${esc(t("runtime.choose_loop"))}">${loops.map(loop => loopSelector(loop, loop.id === selectedId)).join("")}</div></details>` : ""}
      </section>
      <details class="runtime-schedule-lane"${scheduleLaneOpen ? " open" : ""}>
        <summary>반복 일정과 담당 AI 보기·변경하기 <i aria-hidden="true">⌄</i></summary>
        <div class="runtime-schedule-list" role="list" tabindex="${scheduleListFocusable ? "0" : "-1"}" aria-label="${esc(scheduleListLabel)}">${displayedAutomations.length ? displayedAutomations.map(scheduleCard).join("") : emptySchedules()}</div>
      </details>
    </div>`;
    // Restore scroll synchronously before another snapshot render can replace
    // this freshly-created DOM and accidentally capture zero as its position.
    const immediateScheduleList = section.querySelector(".runtime-schedule-list");
    const immediateSelectedTab = section.querySelector(".runtime-loop-tab.selected");
    const immediateTabList = immediateSelectedTab?.closest(".runtime-loop-tabs");
    if (immediateScheduleList) immediateScheduleList.scrollTop = scheduleScrollTop;
    if (immediateTabList) immediateTabList.scrollLeft = loopScrollLeft;
    requestAnimationFrame(() => {
      if (renderVersion !== runtimeRenderVersion) return;
      const scheduleList = section.querySelector(".runtime-schedule-list");
      const selectedTab = section.querySelector(".runtime-loop-tab.selected");
      const tabList = selectedTab && selectedTab.closest(".runtime-loop-tabs");
      if (scheduleList) scheduleList.scrollTop = scheduleScrollTop;
      if (tabList) tabList.scrollLeft = loopScrollLeft;
      if (selectedTab && tabList && (!previousLoopTabs || previousSelectedId !== selectedId)) {
        const item = selectedTab.getBoundingClientRect();
        const list = tabList.getBoundingClientRect();
        if (item.left < list.left || item.right > list.right) selectedTab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      const focusTarget = focusIntent?.type === "schedule-list"
        ? scheduleList
        : focusIntent?.type === "automation" ? section.querySelector(`[data-automation-id="${CSS.escape(focusIntent.id)}"]`)
          : focusIntent?.type === "loop" ? section.querySelector(`[data-loop-select="${CSS.escape(focusIntent.id)}"]`) : null;
      focusTarget?.focus({ preventScroll: true });
      if (focusTarget && document.activeElement === focusTarget) pendingRuntimeFocus = null;
      if (scheduleList) scheduleList.scrollTop = scheduleScrollTop;
      if (tabList && previousLoopTabs && previousSelectedId === selectedId) tabList.scrollLeft = loopScrollLeft;
    });
    ensureRuntimeTicker();
    return automations.length + loops.length;
  }

  return {
    activeRootLoops,
    visibleAutomations,
    scheduleTime,
    scheduleRule,
    loopPhases,
    refreshRuntimeTimes,
    renderRuntimeOverview,
  };
};
