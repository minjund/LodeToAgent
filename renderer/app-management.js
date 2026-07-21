"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createManagement = function createManagement(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const { $, esc, state, providerInfo, timeAgo, readablePreview = value => ({ text: String(value || "") }) } = context;

  const attentionLabel = kind => t(`management.attention.${kind || "response"}`);
  const healthLabel = level => t(`management.health.${level || "unknown"}`);
  const signalLabel = code => t(`management.signal.${code || "low-confidence"}`);
  const evidenceLabel = value => t(`management.evidence.${value || "unverified"}`);
  const prioritySummary = value => {
    const lines = String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .split(/\r?\n/)
      .map(line => {
        let heading = /^\s{0,3}#{1,6}\s+/.test(line);
        let text = line
          .replace(/`([^`]*)`/g, "$1")
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
          .replace(/\*\*|__|~~/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const inlineOrderedItem = heading ? text.match(/(?:^|\s)\d+[.)]\s+(.+)$/) : null;
        if (inlineOrderedItem) {
          text = inlineOrderedItem[1].trim();
          heading = false;
        }
        return { heading, text };
      })
      .filter(line => line.text);
    const plain = (lines.find(line => !line.heading) || lines[0])?.text || "";
    const firstSentence = plain.match(/^.*?(?:[.!?。！？](?=\s|$)|$)/)?.[0]?.trim() || plain;
    return readablePreview(firstSentence || t("management.signal_unavailable"), 104).text;
  };

  function managementBucket(session) {
    if (session.health?.level === "critical") return "critical";
    if (session.health?.level === "warning") return "warning";
    if (session.attention?.required) return "attention";
    if (!session.health || session.health.level === "unknown") return "unknown";
    return session.health.level === "healthy" ? "healthy" : "unknown";
  }

  function progressHtml(session, compactView = false) {
    const progress = session.progress || { percent: 0, checkpoints: [] };
    const checkpoints = compactView ? [] : (progress.checkpoints || []).slice(-8);
    return `<section class="management-progress" data-progress-stage="${esc(progress.stage || "idle")}">
      <header><span>${esc(t("management.progress"))}</span><b>${esc(t("management.progress_steps", {
        completed: progress.completedSteps || 0, total: progress.totalSteps || 0,
      }))}</b><strong>${Number(progress.percent || 0)}%</strong></header>
      <div class="management-progress-track" role="progressbar" aria-label="${esc(t("management.progress"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Number(progress.percent || 0)}"><i style="width:${Math.max(0, Math.min(100, Number(progress.percent || 0)))}%"></i></div>
      <p><b>${esc(progress.currentStep || t("management.no_current_step"))}</b><span>${esc(progress.lastActivityAt ? t("management.last_signal", { time: timeAgo(progress.lastActivityAt) }) : t("management.signal_unavailable"))}</span></p>
      ${progress.blocker ? `<aside><span>${esc(t("management.blocker"))}</span><b>${esc(progress.blocker)}</b></aside>` : ""}
      ${checkpoints.length ? `<ol class="management-checkpoints">${checkpoints.map(row => `<li class="${esc(row.status)}"><i></i><div><b>${esc(row.label)}</b>${row.detail ? `<small>${esc(row.detail)}</small>` : ""}</div><span>${esc(row.timestamp ? timeAgo(row.timestamp) : "")}</span></li>`).join("")}</ol>` : ""}
    </section>`;
  }

  function healthHtml(session, compactView = false) {
    const health = session.health || { level: "unknown", signals: [] };
    const signals = health.signals || [];
    return `<section class="management-health ${esc(health.level || "unknown")}">
      <header><span>${esc(t("management.health_title"))}</span><b>${esc(healthLabel(health.level))}</b><strong>${Number(health.score == null ? 0 : health.score)}</strong></header>
      ${signals.length
        ? `<ul>${signals.slice(0, compactView ? 2 : 8).map(signal => `<li class="${esc(signal.severity)}"><i></i><b>${esc(signalLabel(signal.code))}</b>${signal.detail ? `<span title="${esc(signal.detail)}">${esc(signal.detail)}</span>` : ""}</li>`).join("")}</ul>`
        : `<p>${esc(t("management.no_health_signals"))}</p>`}
    </section>`;
  }

  function controlButtonsHtml(session) {
    const controls = session.controlCapabilities || {};
    const canReassign = controls.reassign && (context.visibleProviders?.() || state.providers)
      .some(provider => provider.id !== session.provider && state.availability[provider.id]);
    const busy = action => state.runControlRequests.has(`${session.runId || session.id}:${action}`);
    const button = (action, label, tone = "") => controls[action]
      ? `<button type="button" class="${tone}" data-managed-run-action="${action}" data-management-session-id="${esc(session.id)}" ${busy(action) ? 'disabled aria-busy="true"' : ""}>${esc(t(label))}</button>`
      : "";
    return `<div class="management-control-buttons" aria-label="${esc(t("management.controls"))}">
      ${button("pause", "management.pause")}
      ${session.status === "paused" ? button("resume", "management.resume") : ""}
      ${button("retry", "management.retry")}
      ${canReassign ? `<button type="button" data-reassign-session="${esc(session.id)}">${esc(t("management.reassign"))}</button>` : ""}
      ${button("stop", "management.stop", "danger")}
    </div>`;
  }

  function quickActionsHtml(session) {
    const attention = session.attention || {};
    if (!attention.required) return "";
    const controls = session.controlCapabilities || {};
    const buttons = [];
    if (controls.sendInstruction && ["approval", "decision"].includes(attention.kind)) {
      buttons.push(`<button type="button" class="approve" data-attention-session-id="${esc(session.id)}" data-attention-quick="${esc(t("management.quick.approve_text"))}">${esc(t("management.approve"))}</button>`);
      buttons.push(`<button type="button" data-attention-session-id="${esc(session.id)}" data-attention-quick="${esc(t("management.quick.deny_text"))}">${esc(t("management.deny"))}</button>`);
    }
    buttons.push(`<button type="button" data-open-session="${esc(session.id)}">${esc(t("management.review_detail"))}</button>`);
    return `<div class="management-quick-actions">${buttons.join("")}</div>`;
  }

  function attentionCardHtml(session) {
    const provider = providerInfo(session.provider);
    const attention = session.attention || {};
    const evidence = session.evidence || {};
    return `<article class="attention-card ${esc(attention.kind || "response")}" data-management-session="${esc(session.id)}" style="--management-provider:${provider.accent}">
      <header><span class="provider-mark">${esc(provider.mark)}</span><div><small>${esc(provider.label)} · ${esc(attentionLabel(attention.kind))}</small><h3>${esc(session.title)}</h3></div><em class="confidence ${esc(evidence.confidence || "low")}">${esc(evidenceLabel(evidence.confidence))}</em></header>
      <div class="attention-reason"><span>${esc(t("management.requested_action"))}</span><p>${esc(attention.summary || session.statusDetail || t("management.response_needed"))}</p><small>${esc(attention.requestedAt ? timeAgo(attention.requestedAt) : t("management.signal_unavailable"))}</small></div>
      ${progressHtml(session, true)}
      ${healthHtml(session, true)}
      ${quickActionsHtml(session)}
      ${session.controlCapabilities?.sendInstruction ? context.agentCommandComposer(session) : ""}
      ${controlButtonsHtml(session)}
    </article>`;
  }

  function renderAttentionInbox() {
    const section = $("#attentionInbox");
    if (!section) return 0;
    const reviewSessions = context.filteredSessions().filter(session => managementBucket(session) !== "healthy");
    const filter = ["critical", "warning", "attention", "unknown"].includes(state.managementFilter) ? state.managementFilter : "all";
    const sessions = filter === "all" ? reviewSessions : reviewSessions.filter(session => managementBucket(session) === filter);
    const counts = reviewSessions.reduce((output, session) => {
      const key = managementBucket(session);
      output[key] = (output[key] || 0) + 1;
      return output;
    }, { critical: 0, warning: 0, attention: 0, unknown: 0 });
    const filterButton = (value, label, count) => `<button type="button" data-management-inbox-filter="${value}" aria-pressed="${filter === value ? "true" : "false"}"><i></i><span>${esc(label)}</span><b>${count}</b></button>`;
    section.innerHTML = `<header class="attention-inbox-head"><div><p>${esc(t("management.inbox_eyebrow"))}</p><h2>${esc(t("management.inbox_title"))}</h2><span>${esc(t("management.inbox_description"))}</span></div><strong>${sessions.length}</strong></header>
      <div class="attention-inbox-summary" role="toolbar" aria-label="${esc(t("management.operations_severity_buckets"))}">
        ${filterButton("all", t("management.filter_all"), reviewSessions.length)}
        ${filterButton("critical", t("management.health.critical"), counts.critical)}
        ${filterButton("warning", t("management.health.warning"), counts.warning)}
        ${filterButton("attention", t("management.health.attention"), counts.attention)}
        ${filterButton("unknown", t("management.health.unknown"), counts.unknown)}
      </div>
      <div class="attention-card-list">${sessions.length ? sessions.map(attentionCardHtml).join("") : `<div class="management-empty"><b>${esc(t("management.inbox_empty"))}</b><span>${esc(t("management.inbox_empty_detail"))}</span></div>`}</div>`;
    return sessions.length;
  }

  function renderOperationsOverview() {
    const section = $("#operationsOverview");
    if (!section) return;
    const sessions = typeof context.graphFilteredSessions === "function"
      ? context.graphFilteredSessions()
      : (state.snapshot?.sessions || []);
    const critical = sessions.filter(session => session.health?.level === "critical");
    const warning = sessions.filter(session => session.health?.level === "warning");
    const attention = sessions.filter(session => session.attention?.required);
    const flaggedIds = new Set([...critical, ...warning].map(session => session.id));
    const attentionOnly = attention.filter(session => !flaggedIds.has(session.id));
    attentionOnly.forEach(session => flaggedIds.add(session.id));
    const unknown = sessions.filter(session => !flaggedIds.has(session.id) && (!session.health || session.health.level === "unknown" || !["healthy", "critical", "warning"].includes(session.health.level)));
    unknown.forEach(session => flaggedIds.add(session.id));
    const healthy = sessions.filter(session => !flaggedIds.has(session.id) && session.health?.level === "healthy");
    const priority = [...new Map([...critical, ...warning, ...attentionOnly, ...unknown].map(session => [session.id, session])).values()].slice(0, 4);
    const reviewCount = critical.length + warning.length + attentionOnly.length + unknown.length;
    section.innerHTML = `<header>
      <div class="operations-heading">
        <span class="operations-signal" aria-hidden="true">!</span>
        <div class="operations-heading-copy"><p>${esc(t("management.operations_eyebrow"))}</p><h2>${esc(t("management.operations_title"))}</h2><span>${esc(t("management.operations_description"))}</span></div>
      </div>
      <div class="operations-review-total"><strong>${reviewCount}</strong><span>${esc(t("management.operations_review_count"))}</span></div>
      </header>
      <div class="operations-metrics" aria-label="${esc(t("management.operations_severity_buckets"))}">
        <button type="button" data-management-filter="critical"><span>${esc(t("management.health.critical"))}</span><b>${critical.length}</b></button>
        <button type="button" data-management-filter="warning"><span>${esc(t("management.health.warning"))}</span><b>${warning.length}</b></button>
        <button type="button" data-management-filter="attention"><span>${esc(t("management.health.attention"))}</span><b>${attentionOnly.length}</b></button>
        <button type="button" data-management-filter="unknown"><span>${esc(t("management.health.unknown"))}</span><b>${unknown.length}</b></button>
        <div><span>${esc(t("management.health.healthy"))}</span><b>${healthy.length}</b></div>
      </div>
      ${priority.length ? `<div class="operations-priority">${priority.map(session => {
        const health = session.health || {};
        const summary = prioritySummary((health.signals || []).map(signal => signalLabel(signal.code)).join(" · ")
          || session.attention?.summary
          || t("management.signal_unavailable"));
        return `<button type="button" data-open-session="${esc(session.id)}"><i class="${esc(managementBucket(session))}"></i><span><b>${esc(session.title)}</b><small>${esc(summary)}</small></span><em>${esc(timeAgo(health.lastActivityAt || session.updatedAt))}</em></button>`;
      }).join("")}</div>${reviewCount > priority.length ? `<div class="operations-more"><button type="button" data-management-filter="all"><span>${esc(t("management.operations_view_all"))}</span><b>${reviewCount}</b><i aria-hidden="true">→</i></button></div>` : ""}` : `<p class="operations-clear">${esc(t("management.operations_clear"))}</p>`}`;
  }

  function outcomeHtml(session) {
    const outcome = session.outcome || { artifacts: [], checks: [] };
    const evidence = session.evidence || { sources: [] };
    const controls = session.controlCapabilities || {};
    return `<div class="management-detail">
      <section class="management-outcome ${esc(outcome.status || "in-progress")}">
        <header><div><span>${esc(t("management.outcome"))}</span><h3>${esc(t(`management.outcome.${outcome.status || "in-progress"}`))}</h3></div><em class="${outcome.verified ? "verified" : "unverified"}">${esc(outcome.verified ? t("management.verified") : t("management.unverified"))}</em></header>
        <p>${esc(outcome.summary || t("management.outcome_pending"))}</p>
      </section>
      ${session.attention?.required ? `<section class="management-attention-detail"><header><span>${esc(attentionLabel(session.attention.kind))}</span><b>${esc(session.attention.summary)}</b></header>${quickActionsHtml(session)}${controls.sendInstruction ? context.agentCommandComposer(session) : ""}</section>` : ""}
      ${progressHtml(session)}
      ${healthHtml(session)}
      <section class="management-artifacts"><header><span>${esc(t("management.artifacts"))}</span><b>${esc(t("common.items", { count: (outcome.artifacts || []).length }))}</b></header>${outcome.artifacts?.length ? `<ul>${outcome.artifacts.map(item => `<li><i>${esc(item.kind)}</i><b title="${esc(item.value)}">${esc(item.value)}</b><span>${esc(item.verified ? t("management.verified") : t("management.detected"))}</span></li>`).join("")}</ul>` : `<p>${esc(t("management.no_artifacts"))}</p>`}</section>
      <section class="management-checks"><header><span>${esc(t("management.verification_checks"))}</span><b>${esc(t("common.items", { count: (outcome.checks || []).length }))}</b></header>${outcome.checks?.length ? `<ul>${outcome.checks.map(check => `<li class="${esc(check.status)}"><i></i><b>${esc(check.label)}</b><span>${esc(t(`management.check.${check.status}`))}</span></li>`).join("")}</ul>` : `<p>${esc(t("management.no_checks"))}</p>`}</section>
      <section class="management-evidence"><header><span>${esc(t("management.evidence_title"))}</span><b>${esc(evidenceLabel(evidence.confidence))}</b></header><dl><div><dt>${esc(t("management.evidence_status"))}</dt><dd>${esc(evidenceLabel(evidence.status))}</dd></div><div><dt>${esc(t("management.evidence_hierarchy"))}</dt><dd>${esc(evidenceLabel(evidence.hierarchy))}</dd></div><div><dt>${esc(t("management.evidence_completion"))}</dt><dd>${esc(evidenceLabel(evidence.completion))}</dd></div></dl><p>${esc((evidence.sources || []).join(" · ") || t("management.signal_unavailable"))}</p></section>
      <section class="management-controls"><header><span>${esc(t("management.controls"))}</span><b>${esc(t("management.controls_description"))}</b></header>${controlButtonsHtml(session)}</section>
    </div>`;
  }

  return {
    managementBucket,
    attentionCardHtml,
    controlButtonsHtml,
    healthHtml,
    outcomeHtml,
    progressHtml,
    renderAttentionInbox,
    renderOperationsOverview,
  };
};
