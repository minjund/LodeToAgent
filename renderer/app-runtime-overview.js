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

  function activeRootLoops() {
    return visibleSessions()
      .filter(isRuntimeLoopSession)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

  function visibleAutomations() {
    return ((state.snapshot && state.snapshot.automations) || [])
      .filter((item) => isProviderVisible(item.provider || "codex"))
      .sort((a, b) => Date.parse(a.nextRunAt || 0) - Date.parse(b.nextRunAt || 0));
  }

  function automationSession(item) {
    if (!item || !item.targetThreadId) return null;
    return visibleSessions().find((session) => session.externalId === item.targetThreadId || session.id === item.targetThreadId) || null;
  }

  function scheduleTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("runtime.not_scheduled");
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = Math.round((target.getTime() - start.getTime()) / 86_400_000);
    const time = date.toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" });
    if (day === 0) return t("runtime.today_at", { time });
    if (day === 1) return t("runtime.tomorrow_at", { time });
    return date.toLocaleString(uiLocale(), { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  }

  function scheduleRule(value) {
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
    if (rule.BYDAY) {
      const weekdayDates = { SU: 4, MO: 5, TU: 6, WE: 7, TH: 8, FR: 9, SA: 10 };
      const days = rule.BYDAY.split(",")
        .map((day) => weekdayDates[day])
        .filter(Boolean)
        .map((day) => new Intl.DateTimeFormat(uiLocale(), { weekday: "short" }).format(new Date(2026, 0, day)));
      if (days.length) details.push(days.join("·"));
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

  function elapsedSince(value) {
    if (!value) return t("runtime.just_started");
    const elapsed = Date.now() - Date.parse(value || 0);
    if (!Number.isFinite(elapsed) || elapsed < 60_000) return t("runtime.just_started");
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 60) return t("runtime.elapsed_minutes", { count: minutes });
    return t("runtime.elapsed_hours", { count: Math.floor(minutes / 60) });
  }

  function scheduleCard(item) {
    const session = automationSession(item);
    const cwd = (item.cwds || [])[0] || "";
    const workspace = String(cwd).replace(/\\/g, "/").split("/").filter(Boolean).pop();
    const location = workspace || (item.environment?.kind === "wsl" && item.sourceLabel) || t("runtime.workspace_unspecified");
    const body = `<span class="runtime-schedule-time" ${item.enabled ? `data-runtime-next-run-at="${esc(item.nextRunAt || "")}"` : ""}>${esc(item.enabled ? scheduleTime(item.nextRunAt) : t("runtime.paused"))}</span>
      <strong>${esc(item.name)}</strong>
      <small>${esc(scheduleRule(item.rrule))} · ${esc(location)}</small>`;
    return session
      ? `<button type="button" class="runtime-schedule-card ${item.enabled ? "" : "paused"}" data-automation-id="${esc(item.id)}" data-automation-enabled="${item.enabled ? "true" : "false"}" data-automation-session="${esc(session.id)}">${body}<i aria-hidden="true">↗</i></button>`
      : `<article class="runtime-schedule-card ${item.enabled ? "" : "paused"}" data-automation-id="${esc(item.id)}" data-automation-enabled="${item.enabled ? "true" : "false"}">${body}<i aria-hidden="true">${item.enabled ? "●" : "Ⅱ"}</i></article>`;
  }

  function emptySchedules() {
    return `<div class="runtime-schedule-empty"><span aria-hidden="true">＋</span><div><b>${esc(t("runtime.no_schedules"))}</b><small>${esc(t("runtime.no_schedules_detail"))}</small></div></div>`;
  }

  function loopSelector(loop, selected) {
    const provider = providerInfo(loop.provider);
    return `<button type="button" class="runtime-loop-tab ${selected ? "selected" : ""}" data-loop-select="${esc(loop.id)}"
      style="${providerStyle(loop.provider)}" aria-pressed="${selected ? "true" : "false"}">
      <span class="runtime-loop-tab-mark">${esc(provider.mark)}</span>
      <span><b>${esc(loop.title)}</b><small>${esc(provider.label)} · <span data-runtime-started-at="${esc(loop.startedAt || "")}">${esc(elapsedSince(loop.startedAt))}</span></small></span>
      <i aria-hidden="true"></i>
    </button>`;
  }

  function loopDiagram(session) {
    const phases = loopPhases(session);
    const activeIndex = Math.max(0, phases.findIndex((phase) => phase.state === "active"));
    const activePhase = phases[activeIndex];
    return `<div class="runtime-loop-cycle" role="img" aria-label="${esc(t("runtime.loop_flow_state", { phase: activePhase.label }))}" style="--loop-progress:${activeIndex / Math.max(1, phases.length - 1) * 100}%">
      <div class="runtime-loop-spine" aria-hidden="true"><span></span></div>
      ${phases.map((phase, index) => `<div class="runtime-loop-phase ${phase.state}" data-loop-phase="${phase.key}">
        <span class="runtime-loop-phase-index">0${index + 1}</span>
        <i aria-hidden="true">${phase.state === "done" ? "✓" : phase.state === "active" ? "●" : "·"}</i>
        <b>${esc(phase.label)}</b>
        <small>${esc(phase.detail)}</small>
      </div>`).join("")}
      <div class="runtime-loop-return" aria-hidden="true"><span>↺</span><b>${esc(t("runtime.phase_repeat"))}</b></div>
    </div>`;
  }

  function loopDetail(session) {
    const provider = providerInfo(session.provider);
    const activity = currentActivity(session);
    const children = (session.childIds || []).map((id) => visibleSessions().find((item) => item.id === id)).filter(Boolean);
    const runningChildren = children.filter((item) => ["running", "starting"].includes(item.status)).length;
    const iteration = Number(session.loop && session.loop.iteration || 0);
    const iterationLabel = iteration > 0
      ? t("runtime.iteration_value", { count: iteration })
      : session.loop ? t("runtime.iteration_observed") : t("runtime.iteration_scheduled");
    return `<article class="runtime-loop-detail" style="${providerStyle(session.provider)}" data-motion-key="runtime-loop:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || "")}">
      <header>
        <div><span class="runtime-loop-kicker"><i></i>${esc(t("runtime.active_loop"))}</span><h3>${esc(session.title)}</h3><p>${esc(provider.label)} · ${esc(session.model || t("session.model_unknown"))}</p></div>
        <button type="button" class="runtime-open-task" data-loop-open="${esc(session.id)}">${esc(t("runtime.open_task"))}<span aria-hidden="true">↗</span></button>
      </header>
      ${loopDiagram(session)}
      <footer class="runtime-loop-footer">
        <div class="runtime-current-signal"><span aria-hidden="true">⌁</span><div><small>${esc(t("runtime.latest_signal"))}</small><b>${esc(window.LoadToAgentI18n.observedText(activity.title))}</b><p>${esc(window.LoadToAgentI18n.observedText(activity.detail || session.statusDetail || ""))}</p></div></div>
        <dl>
          <div><dt>${esc(t("runtime.running_time"))}</dt><dd data-runtime-started-at="${esc(session.startedAt || "")}">${esc(elapsedSince(session.startedAt))}</dd></div>
          <div><dt>${esc(t("runtime.iteration"))}</dt><dd>${esc(iterationLabel)}</dd></div>
          <div><dt>${esc(t("runtime.subagents"))}</dt><dd>${runningChildren ? esc(t("runtime.subagents_running", { running: runningChildren, total: children.length })) : esc(t("runtime.subagents_total", { count: children.length }))}</dd></div>
        </dl>
      </footer>
    </article>`;
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
    const previousSelectedId = section.querySelector(".runtime-loop-tab.selected")?.dataset.loopSelect || "";
    const scheduleScrollTop = previousScheduleList?.scrollTop || 0;
    const loopScrollLeft = previousLoopTabs?.scrollLeft || 0;
    const restoreScheduleFocus = document.activeElement === previousScheduleList;
    const focusedAutomationId = document.activeElement?.closest?.("[data-automation-id]")?.dataset.automationId || "";
    const focusedLoopId = document.activeElement?.closest?.("[data-loop-select]")?.dataset.loopSelect || "";
    const automations = visibleAutomations();
    const loops = activeRootLoops();
    const enabled = automations.filter((item) => item.enabled);
    const paused = automations.filter((item) => !item.enabled);
    if (!loops.some((loop) => loop.id === state.selectedRuntimeLoopId)) state.selectedRuntimeLoopId = loops[0] && loops[0].id || null;
    const selected = loops.find((loop) => loop.id === state.selectedRuntimeLoopId) || loops[0] || null;
    const selectedId = selected?.id || "";
    section.innerHTML = `<header class="runtime-overview-head">
      <div class="runtime-overview-title"><span class="runtime-overview-emblem" aria-hidden="true"><i></i><b>↻</b></span><div><p>${esc(t("runtime.eyebrow"))}</p><h2>${esc(t("runtime.status_summary"))}</h2></div></div>
      <div class="runtime-overview-counts"><span><i></i>${esc(t("runtime.schedules_count", { count: enabled.length }))}</span>${paused.length ? `<span class="paused"><i></i>${esc(t("runtime.paused_count", { count: paused.length }))}</span>` : ""}<span><i></i>${esc(t("runtime.loops_count", { count: loops.length }))}</span><b><i></i>LIVE</b></div>
    </header>
    <div class="runtime-overview-grid">
      <aside class="runtime-schedule-lane">
        <header><div><span>${esc(t("runtime.schedule_lane"))}</span><b>${esc(t("runtime.schedule_list"))}</b></div><em>${String(automations.length).padStart(2, "0")}</em></header>
        <div class="runtime-schedule-list" role="region" tabindex="0" aria-label="${esc(t("runtime.schedule_list_label"))}">${automations.length ? automations.map(scheduleCard).join("") : emptySchedules()}</div>
      </aside>
      <section class="runtime-loop-lane" aria-label="${esc(t("runtime.loop_lane"))}">
        <header class="runtime-loop-lane-head"><div><span>${esc(t("runtime.loop_lane"))}</span><b>${esc(t("runtime.loop_system"))}</b><small>${esc(t("runtime.inferred_phase"))}</small></div>${loops.length > 1 ? `<div class="runtime-loop-tabs" aria-label="${esc(t("runtime.choose_loop"))}">${loops.map((loop) => loopSelector(loop, loop.id === selectedId)).join("")}</div>` : ""}</header>
        ${selected ? loopDetail(selected) : noActiveLoop()}
      </section>
    </div>`;
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
      const focusTarget = restoreScheduleFocus
        ? scheduleList
        : focusedAutomationId ? section.querySelector(`[data-automation-id="${CSS.escape(focusedAutomationId)}"]`)
          : focusedLoopId ? section.querySelector(`[data-loop-select="${CSS.escape(focusedLoopId)}"]`) : null;
      focusTarget?.focus({ preventScroll: true });
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
