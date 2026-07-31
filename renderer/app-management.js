"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createManagement = function createManagement(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, esc, state, providerInfo, timeAgo,
    rememberDisclosureStates = () => {},
    restoreDisclosureStates = () => {},
    readablePreview = value => ({ text: String(value || "") }),
    currentActivity = session => ({ title: session.statusDetail || "", detail: "" }),
    latestWorkCopy = session => session.statusDetail || "",
    isLiveSession = session => ["starting", "running"].includes(session && session.status),
    isResultReviewComplete = () => false,
    resultReviewTargets = () => [],
    agentRoleLabel = value => String(value || ""),
    renderGlobalStats = () => {},
  } = context;

  const attentionLabel = kind => t(`management.attention.${kind || "response"}`);
  const healthLabel = level => t(`management.health.${level || "unknown"}`);
  const signalLabel = code => t(`management.signal.${code || "low-confidence"}`);
  const evidenceLabel = value => t(`management.evidence.${value || "unverified"}`);
  const absoluteTime = value => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t("memory.time_unknown");
    const localeTag = window.LoadToAgentI18n.getLocaleTag();
    return new Intl.DateTimeFormat(localeTag, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: localeTag.startsWith("ko") ? "2-digit" : "numeric",
      minute: "2-digit",
      ...(localeTag.startsWith("ko") ? { hourCycle: "h23" } : {}),
    }).format(date);
  };
  const RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const ALWAYS_VISIBLE_STATUSES = new Set(["starting", "running"]);
  const CURRENT_RISK_STATUSES = new Set(["starting", "running", "waiting", "paused", "failed"]);
  const RESPONSE_ATTENTION_KINDS = new Set(["approval", "decision", "input", "response"]);
  const ACTIONABLE_RISK_SIGNALS = new Set(["run-failed", "run-paused", "stalled", "waiting-too-long", "repeated-failures"]);
  const needsUserResponse = session => Boolean(
    (session.attention?.category === "required" || (!session.attention?.category && session.attention?.required))
    && RESPONSE_ATTENTION_KINDS.has(session.attention.kind),
  );
  const hasOptionalFollowup = session => Boolean(
    session.attention?.category === "optional" || session.attention?.kind === "optional",
  );
  const sessionActivityTimestamp = session => Math.max(0, ...[
    session.health?.lastActivityAt,
    session.attention?.requestedAt,
    session.updatedAt,
    session.completedAt,
    session.startedAt,
  ].map(value => Date.parse(value || 0)).filter(Number.isFinite));
  const isRecentSession = (session, now = Date.now()) => {
    if (ALWAYS_VISIBLE_STATUSES.has(session.status)) return true;
    const activityAt = sessionActivityTimestamp(session);
    return Boolean(activityAt && Math.max(0, Number(now) - activityAt) <= RECENT_SESSION_WINDOW_MS);
  };
  const actionableRiskLevel = session => {
    const signals = (session.health?.signals || []).filter(signal => ACTIONABLE_RISK_SIGNALS.has(signal.code));
    const severities = signals.map(signal => signal.severity || session.health?.level || "");
    if (severities.includes("critical")) return "critical";
    if (severities.includes("warning")) return "warning";
    return "";
  };
  const hasCurrentRisk = (session, now = Date.now()) => Boolean(
    isRecentSession(session, now)
    && CURRENT_RISK_STATUSES.has(session.status)
    && actionableRiskLevel(session),
  );
  const needsManagementReview = (session, now = Date.now()) => Boolean(
    !isResultReviewComplete(session)
    && isRecentSession(session, now)
    && (needsUserResponse(session) || hasCurrentRisk(session, now)),
  );
  const needsManagementInbox = (session, now = Date.now()) => Boolean(
    !isResultReviewComplete(session)
    && isRecentSession(session, now)
    && (needsUserResponse(session) || hasOptionalFollowup(session) || hasCurrentRisk(session, now)),
  );
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
  const flowExcerpt = (value, limit = 420) => {
    const plain = String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      .replace(/\*\*|__|~~/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return readablePreview(plain || t("management.signal_unavailable"), limit).text;
  };
  const noviceCopy = (value) => {
    const raw = String(value || "");
    if (/왼쪽\s*메뉴\s*이름/i.test(raw) && /[‘'"]?내\s*요청[’'"]?/i.test(raw)) {
      return "왼쪽 메뉴 이름을 ‘내 요청’으로 바꿀까요?";
    }
    if (/메타\s*타이틀/i.test(raw) && /메타\s*디스크립션/i.test(raw) && /\bPR\b/i.test(raw)) {
      return "검색 결과의 제목과 소개 문구를 이전 문구와 동일하게 바꿀까요?";
    }
    return raw
      .replace(/메타\s*타이틀/gi, "검색 결과에 표시될 제목")
      .replace(/메타\s*디스크립션/gi, "검색 결과 소개 문구")
      .replace(/\bPR\b/gi, "기존 변경 요청")
      .replace(/풀\s*스크린/gi, "전체 화면")
      .replace(/브랜치/gi, "작업 위치");
  };
  const latestAgentReply = session => {
    const message = [...(session.messages || [])].reverse()
      .find(row => row && row.role === "assistant" && String(row.text || "").trim());
    const communication = [...(session.collaboration?.communications || [])].reverse()
      .find(row => row && row.kind === "result" && String(row.text || "").trim());
    return flowExcerpt(message?.text
      || communication?.text
      || session.result
      || session.outcome?.summary
      || session.attention?.summary
      || session.statusDetail);
  };
  const attentionFlow = session => {
    const attention = session.attention || {};
    const responseRequired = needsUserResponse(session);
    const optional = hasOptionalFollowup(session);
    const kind = responseRequired
      ? attention.kind
      : optional ? "optional" : (session.status === "failed" ? "error" : session.status === "paused" ? "paused" : "risk");
    const check = t(`management.flow_check_${kind}`);
    const action = t(`management.flow_action_${kind}`);
    const reply = t(`management.flow_reply_${kind}`);
    const expected = t(`management.flow_expected_${kind}`);
    const replySource = responseRequired
      ? (attention.summary || session.statusDetail || latestAgentReply(session))
      : ((session.health?.signals || []).map(signal => {
        const label = signalLabel(signal.code);
        return signal.detail ? `${label} · ${signal.detail}` : label;
      }).join(" / ") || session.statusDetail || latestAgentReply(session));
    return {
      responseRequired,
      optional,
      kind,
      agentReply: optional ? flowExcerpt(attention.summary, 420) : latestAgentReply(session),
      reason: flowExcerpt(replySource, 260),
      check,
      action,
      reply,
      expected,
    };
  };
  const supervisionFreshnessScore = (timestamp, now = Date.now()) => {
    if (timestamp == null || timestamp === "") return -300;
    const numericTimestamp = typeof timestamp === "number" ? timestamp : Date.parse(timestamp || 0);
    if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) return -300;
    const age = Math.max(0, Number(now) - numericTimestamp);
    if (age <= 60 * 1000) return 180;
    if (age <= 5 * 60 * 1000) return 140;
    if (age <= 15 * 60 * 1000) return 95;
    if (age <= 60 * 60 * 1000) return 45;
    if (age <= 6 * 60 * 60 * 1000) return 0;
    return -260;
  };

  function managementBucket(session, now = Date.now()) {
    if (needsUserResponse(session)) return "attention";
    if (hasCurrentRisk(session, now) && actionableRiskLevel(session) === "critical") return "critical";
    if (hasCurrentRisk(session, now) && actionableRiskLevel(session) === "warning") return "warning";
    if (isRecentSession(session, now) && hasOptionalFollowup(session)) return "optional";
    return "healthy";
  }

  function matchesManagementFilter(session, filter, now = Date.now()) {
    const bucket = managementBucket(session, now);
    if (filter === "critical" || filter === "warning" || filter === "attention" || filter === "optional") return bucket === filter;
    return needsManagementInbox(session, now);
  }

  function rootManagementReviews(sessions, now = Date.now()) {
    const visible = Array.isArray(sessions) ? sessions : [];
    const allSessions = state.snapshot?.sessions || visible;
    const byId = new Map(allSessions.map(session => [session.id, session]));
    const grouped = new Map();
    const rootSession = (session) => {
      let current = session;
      const visited = new Set();
      while (current?.parentId && !visited.has(current.id)) {
        visited.add(current.id);
        const parent = byId.get(current.parentId);
        if (!parent) break;
        current = parent;
      }
      return current || session;
    };
    visible.filter(session => needsManagementReview(session, now)).forEach((source) => {
      const root = rootSession(source);
      if (!root?.id) return;
      if (!grouped.has(root.id)) grouped.set(root.id, { session: root, sources: [] });
      grouped.get(root.id).sources.push(source);
    });
    return [...grouped.values()];
  }

  function progressHtml(session, compactView = false) {
    const progress = session.progress || { percent: 0, checkpoints: [] };
    const checkpoints = compactView ? [] : (progress.checkpoints || []).slice(-8);
    const completed = Number(progress.completedSteps || 0);
    const total = Number(progress.totalSteps || 0);
    const loggedRatio = total ? Math.round(completed / total * 100) : 0;
    return `<section class="management-progress" data-progress-stage="${esc(progress.stage || "idle")}">
      <header><span>${esc(t("management.progress"))}</span><b>${esc(t("management.progress_steps", {
        completed, total,
      }))}</b><strong>${completed}/${total}</strong></header>
      <div class="management-progress-track" role="progressbar" aria-label="${esc(t("management.progress_steps", { completed, total }))}" aria-valuemin="0" aria-valuemax="${Math.max(1, total)}" aria-valuenow="${completed}"><i style="width:${Math.max(0, Math.min(100, loggedRatio))}%"></i></div>
      <p><b>${esc(progress.currentStep || t("management.no_current_step"))}</b><span>${esc(progress.lastActivityAt ? t("management.last_signal", { time: timeAgo(progress.lastActivityAt) }) : t("management.signal_unavailable"))}</span></p>
      ${progress.blocker ? `<aside><span>${esc(t("management.blocker"))}</span><b>${esc(progress.blocker)}</b></aside>` : ""}
      ${checkpoints.length ? `<ol class="management-checkpoints">${checkpoints.map(row => `<li class="${esc(row.status)}"><i></i><div><b>${esc(row.label)}</b>${row.detail ? `<small>${esc(row.detail)}</small>` : ""}</div><span>${esc(row.timestamp ? timeAgo(row.timestamp) : "")}</span></li>`).join("")}</ol>` : ""}
    </section>`;
  }

  function healthHtml(session, compactView = false) {
    const health = session.health || { level: "unknown", signals: [] };
    const signals = health.signals || [];
    return `<section class="management-health ${esc(health.level || "unknown")}">
      <header><span>${esc(t("management.health_title"))}</span><b>${esc(healthLabel(health.level))}</b><strong>${esc(t("common.count", { count: signals.length }))}</strong></header>
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

  function quickActionsHtml(session, includeQuestionChoices = false) {
    const attention = session.attention || {};
    const category = attention.category || (attention.required ? "required" : "none");
    if (category === "none") return "";
    const controls = session.controlCapabilities || {};
    const provider = providerInfo(session.provider);
    const buttons = [];
    const approvalText = `${attention.requestText || ""} ${attention.summary || ""}`;
    const quotedNames = [...approvalText.matchAll(/[“"]([^”"]{1,60})[”"]/g)].map(match => match[1].trim()).filter(Boolean);
    const approveLabel = quotedNames.length
      ? t("management.approve_named", { name: quotedNames.at(-1) })
      : t("management.approve", { provider: provider.label });
    // A yes/no approval message is only safe for explicit approval requests.
    // Decisions may require selecting a concrete option, so those use the
    // normal instruction composer instead of a misleading generic approval.
    if (controls.sendInstruction && attention.kind === "approval") {
      buttons.push(`<button type="button" class="approve" data-attention-session-id="${esc(session.id)}" data-attention-quick="${esc(t("management.quick.approve_text"))}"><span class="recommended-choice">추천</span>${esc(`이름을 “${quotedNames.at(-1) || "제안한 이름"}”으로 바꾸고 작업 계속`)}</button>`);
      buttons.push(`<button type="button" data-attention-session-id="${esc(session.id)}" data-attention-quick="${esc(t("management.quick.deny_text"))}">이름을 바꾸지 않고 작업 계속</button>`);
    }
    if (controls.sendInstruction && includeQuestionChoices) {
      buttons.push(`<button type="button" class="approve" data-attention-session-id="${esc(session.id)}" data-attention-quick="예, 이전 문구와 동일하게 변경해 주세요.">예, 동일하게 변경</button>`);
      buttons.push(`<button type="button" data-attention-session-id="${esc(session.id)}" data-attention-quick="아니요, 현재 문구를 유지해 주세요.">아니요, 현재 문구 유지</button>`);
    }
    const approvalPreview = attention.kind === "approval" && quotedNames.length
      ? `<div class="approval-name-preview"><span><small>현재 이름</small><b>확인 필요</b></span><i aria-hidden="true">→</i><span><small>바꿀 이름</small><b>${esc(quotedNames.at(-1))}</b></span></div>`
      : "";
    const approvalEffect = attention.kind === "approval"
      ? `<p class="approval-action-effect"><b>선택하면 즉시 ${esc(provider.label)}에 전달되고 멈춘 작업이 다시 시작됩니다.</b></p>`
      : "";
    return buttons.length ? `<div class="management-quick-actions">${approvalPreview}${approvalEffect}${buttons.join("")}</div>` : "";
  }

  function attentionCardHtml(session, index = 0) {
    const provider = providerInfo(session.provider);
    const attention = session.attention || {};
    const health = session.health || { level: "unknown", signals: [] };
    const evidence = session.evidence || {};
    const bucket = managementBucket(session);
    const category = ["required", "optional", "risk"].includes(attention.category)
      ? attention.category
      : needsUserResponse(session)
        ? "required"
        : "risk";
    const cardLabel = category === "required" || category === "optional"
      ? attentionLabel(attention.kind)
      : healthLabel(bucket === "critical" || bucket === "warning" ? bucket : health.level);
    const flow = attentionFlow(session);
    const displayType = attention.kind === "approval"
      ? "approval"
      : category === "risk" || ["error", "risk", "paused"].includes(flow.kind)
        ? "failure"
        : category === "optional" || flow.kind === "optional"
          ? "result"
          : "question";
    const displayLabel = t(`management.card.${displayType}`);
    const canDraft = Boolean(session.controlCapabilities?.sendInstruction && ["question", "approval"].includes(displayType));
    const approvalText = `${attention.requestText || ""} ${attention.summary || ""}`;
    const proposedName = [...approvalText.matchAll(/[“"]([^”"]{1,60})[”"]/g)]
      .map(match => match[1].trim()).filter(Boolean).at(-1) || "새 이름";
    const visibleTitle = attention.kind === "approval"
      ? `왼쪽 메뉴의 ‘확인 필요’를 ‘${proposedName}’으로 바꿀까요?`
      : noviceCopy(session.title);
    const providerRequestLabel = attention.kind === "approval"
      ? `이 작업을 맡은 AI: ${provider.label} · 메뉴 이름 변경에 답변이 필요합니다.`
      : `${t("memory.provider", { provider: provider.label })} · ${displayLabel}`;
    const draftComposer = canDraft
      ? displayType === "approval"
        ? `<details class="approval-custom-answer"><summary>원하는 이름 직접 입력하기 <i aria-hidden="true">⌄</i></summary>${context.agentCommandComposer(session, { conversation: true })}</details>`
        : context.agentCommandComposer(session, { conversation: true })
      : "";
    const primaryAction = displayType === "result" || displayType === "failure"
        ? `<button type="button" class="attention-primary-action" data-open-session="${esc(session.id)}">${esc(t(`management.action.${displayType}`))}</button>`
        : "";
    return `<article class="attention-card ${index === 0 ? "priority-card" : ""} ${esc(category)} ${esc(attention.kind || "response")} ${esc(displayType)}" data-management-session="${esc(session.id)}" data-attention-category="${esc(category)}" style="--management-provider:${provider.accent}">
      <p class="attention-now-action">${esc(index === 0 ? "가장 먼저 확인" : displayLabel)}</p>
      <header><span class="provider-mark">${esc(provider.mark)}</span><div><small>${esc(providerRequestLabel)}</small><h3>${esc(visibleTitle)}</h3></div><div class="attention-card-header-actions"><em class="confidence ${esc(evidence.confidence || "low")}">${esc(evidence.confidence === "medium" ? t("management.last_status_check", { time: absoluteTime(session.updatedAt) }) : evidenceLabel(evidence.confidence))}</em>${primaryAction}<button type="button" data-open-session="${esc(session.id)}">${esc(t("management.review_detail"))}</button></div></header>
      ${quickActionsHtml(session, displayType === "question")}
      <div class="attention-category-banner ${esc(category)}"><i aria-hidden="true"></i><span><b>${esc(attention.kind === "approval" ? t("management.attention.approval_short") : t(`management.category.${category}`))}</b><small>${esc(attention.kind === "approval" ? t("management.category.approval_detail", { provider: provider.label }) : t(`management.category.${category}_detail`))}</small></span></div>
      <div class="attention-decision-flow" data-attention-flow="${esc(flow.kind)}" aria-label="${esc(t("management.flow_label"))}">
        <section class="agent-reply"><span><i>1</i>${esc(t("management.flow_agent_reply", { provider: provider.label }))}</span><blockquote>${esc(flow.agentReply)}</blockquote><small><b>${esc(t("management.flow_why_here"))}</b>${esc(flow.reason)}</small></section>
        <i class="attention-flow-arrow" aria-hidden="true">→</i>
        <section class="user-decision"><span><i>2</i>${esc(t("management.flow_my_check"))}</span><b>${esc(flow.check)}</b><p>${esc(flow.action)}</p></section>
        <i class="attention-flow-arrow" aria-hidden="true">→</i>
        <section class="agent-next"><span><i>3</i>${esc(t("management.flow_my_reply", { provider: provider.label }))}</span><b>${esc(flow.reply)}</b><small><strong>${esc(t("management.flow_after_reply"))}</strong>${esc(flow.expected)}</small></section>
      </div>
      ${draftComposer}
      ${displayType === "failure" ? controlButtonsHtml(session) : ""}
      <details class="attention-evidence-details"><summary><span>${esc(t("management.flow_evidence"))}</span><small>${esc(t("management.flow_evidence_hint"))}</small><i aria-hidden="true">⌄</i></summary><div>${progressHtml(session, true)}${healthHtml(session, true)}</div></details>
    </article>`;
  }

  function renderAttentionInbox() {
    const section = $("#attentionInbox");
    if (!section) return 0;
    const preserveFocusedComposer = document.activeElement?.matches?.("[data-agent-command-draft]")
      && section.contains(document.activeElement);
    const reviewSessions = context.filteredSessions().filter(needsManagementInbox);
    const filter = ["critical", "warning", "attention", "answer", "approval", "optional"].includes(state.managementFilter) ? state.managementFilter : "all";
    const sessions = reviewSessions.filter((session) => {
      if (filter === "all") return !matchesManagementFilter(session, "optional");
      if (filter === "answer") return matchesManagementFilter(session, "attention") && session.attention?.kind !== "approval";
      if (filter === "approval") return matchesManagementFilter(session, "attention") && session.attention?.kind === "approval";
      return matchesManagementFilter(session, filter);
    });
    const counts = {
      critical: reviewSessions.filter(session => matchesManagementFilter(session, "critical")).length,
      warning: reviewSessions.filter(session => matchesManagementFilter(session, "warning")).length,
      attention: reviewSessions.filter(session => matchesManagementFilter(session, "attention")).length,
      optional: reviewSessions.filter(session => matchesManagementFilter(session, "optional")).length,
    };
    const answerCount = reviewSessions.filter(session =>
      matchesManagementFilter(session, "attention") && session.attention?.kind !== "approval").length;
    const approvalCount = reviewSessions.filter(session =>
      matchesManagementFilter(session, "attention") && session.attention?.kind === "approval").length;
    const filterButton = (value, label, count, showCount = true) => `<button type="button" data-management-inbox-filter="${value}" aria-pressed="${filter === value ? "true" : "false"}"><i></i><span>${esc(label)}</span>${showCount ? `<b>· ${count}건</b>` : ""}</button>`;
    const activeCount = Math.max(0, reviewSessions.length - counts.optional);
    const navWaitingCount = $("#navWaitingCount");
    if (navWaitingCount) {
      navWaitingCount.textContent = activeCount;
    }
    const countLabel = filter === "all"
      ? `확인 대기 ${activeCount}건`
      : `${sessions.length}건`;
    const firstSession = sessions[0] || null;
    const remainingSessions = sessions.slice(1);
    const remainingLabel = `나머지 ${remainingSessions.length}건 보기`;
    const cardsHtml = firstSession
      ? `${attentionCardHtml(firstSession, 0)}${remainingSessions.length ? `<details class="attention-more-cards"><summary>${esc(remainingLabel)} <i aria-hidden="true">⌄</i></summary><div>${remainingSessions.map((session, index) => attentionCardHtml(session, index + 1)).join("")}</div></details>` : ""}`
      : `<div class="management-empty"><b>${esc(t("management.inbox_empty"))}</b><span>${esc(t("management.inbox_empty_detail"))}</span></div>`;
    const nextHtml = `<header class="attention-inbox-head"><div><p>${esc(t("management.inbox_eyebrow"))}</p><h2>${esc(t("management.inbox_title"))}</h2><span>${firstSession ? `AI 작업 ${activeCount}건이 사용자의 선택을 기다리며 멈춰 있습니다. 가장 오래 기다린 1건부터 보여드립니다.` : esc(t("management.inbox_description", { active: activeCount, completed: counts.optional }))}</span></div><strong>${esc(countLabel)}</strong></header>
      <div class="attention-inbox-summary" role="toolbar" aria-label="${esc(t("management.operations_severity_buckets"))}">
        ${filterButton("all", t("management.filter_all_split", { count: reviewSessions.length }), reviewSessions.length, false)}
        <span class="management-filter-group response"><small>요청 종류</small>${filterButton("answer", t("management.filter_answer", { count: answerCount }), answerCount, false)}${filterButton("approval", t("management.filter_approval", { count: approvalCount }), approvalCount, false)}${filterButton("critical", t("management.filter_completion", { count: counts.critical }), counts.critical, false)}${filterButton("warning", t("management.filter_problem", { count: counts.warning }), counts.warning, false)}</span>
        <span class="management-filter-group optional"><small>처리 상태</small>${filterButton("optional", t("management.filter_handled", { count: counts.optional }), counts.optional, false)}</span>
      </div>
      <p class="attention-filter-note">${esc(t("management.filter_overlap_help"))}</p>
      <div class="attention-card-list">${cardsHtml}</div>`;
    if (!preserveFocusedComposer) section.innerHTML = nextHtml;
    return sessions.length;
  }

  function renderHomeAttention(section) {
    const sessions = typeof context.graphFilteredSessions === "function"
      ? context.graphFilteredSessions()
      : (state.snapshot?.sessions || []);
    const score = session => {
      if (matchesManagementFilter(session, "critical")) return 3;
      if (matchesManagementFilter(session, "attention")) return 2;
      if (matchesManagementFilter(session, "warning")) return 1;
      return 0;
    };
    const entryScore = entry => Math.max(0, ...entry.sources.map(score));
    const entryTimestamp = entry => Math.max(0, ...entry.sources.map(session =>
      Date.parse(session.attention?.requestedAt || session.updatedAt || 0)).filter(Number.isFinite));
    const ordered = rootManagementReviews(sessions).sort((a, b) =>
      entryScore(b) - entryScore(a) || entryTimestamp(b) - entryTimestamp(a),
    );
    if (!ordered.length) {
      section.innerHTML = "";
      section.classList.add("hidden");
      section.setAttribute("aria-hidden", "true");
      return 0;
    }
    section.classList.remove("hidden");
    section.removeAttribute("aria-hidden");
    const reviewItems = sessions.filter(needsManagementInbox);
    const completedItems = reviewItems.filter(session => matchesManagementFilter(session, "optional")).length;
    const activeItems = Math.max(0, reviewItems.length - completedItems);
    const totalItems = reviewItems.length;
    const shown = ordered.slice(0, 5);
    const item = (entry, index) => {
      const { session, sources } = entry;
      const provider = providerInfo(session.provider);
      const strongest = [...sources].sort((a, b) => score(b) - score(a))[0] || session;
      const reviewTargets = resultReviewTargets(session);
      const canCompleteReview = reviewTargets.length > 0;
      const tone = matchesManagementFilter(strongest, "critical") ? "critical" : matchesManagementFilter(strongest, "attention") ? "attention" : "warning";
      const directReview = sources.includes(session);
      const childReviewCount = sources.filter(source => source.id !== session.id).length;
      const label = directReview
        ? (session.attention?.required ? attentionLabel(session.attention.kind) : healthLabel(session.health?.level))
        : t("control.attention_session_unit", { provider: provider.label });
      const groupedLabel = sources.length > 1
        ? `${label} · ${t("control.attention_grouped_count", { count: sources.length })}`
        : label;
      const summary = directReview
        ? prioritySummary(session.attention?.summary || session.statusDetail || latestAgentReply(session))
        : t("control.attention_subagent_summary", { provider: provider.label, count: childReviewCount });
      const itemTitle = index === 0
        ? canCompleteReview
          ? `${provider.label}가 작업을 마쳤습니다.`
          : needsUserResponse(strongest)
            ? `${provider.label}가 답변을 기다리고 있습니다.`
            : `${provider.label} 작업을 확인해 주세요.`
        : t("control.attention_work_name", { title: readablePreview(session.title, 54).text });
      const itemSummary = index === 0
        ? canCompleteReview
          ? t("management.result_review_open_help")
          : needsUserResponse(strongest)
            ? t("management.result_response_open_help")
            : t("management.result_problem_open_help")
        : t("control.attention_check_summary", { summary });
      return `<button type="button" class="home-attention-item ${tone}" data-open-session="${esc(session.id)}" ${canCompleteReview ? 'data-result-review="true"' : ""} style="--management-provider:${provider.accent}" aria-label="${esc(`${groupedLabel}: ${session.title}. ${summary}`)}">
        <span class="home-attention-column-heading">${esc(t(index === 0 ? "control.attention_column_selected" : "control.attention_column_others"))}</span>
        <span class="home-attention-dot" aria-hidden="true"></span>
        <span><small>${index === 0 ? "가장 오래 기다린 결과" : groupedLabel.includes(provider.label) ? esc(groupedLabel) : `${esc(provider.label)} · ${esc(groupedLabel)}`}</small><b>${esc(itemTitle)}</b><em title="${esc(summary)}">${esc(itemSummary)}</em><u>${esc(t("control.attention_open_record"))}</u></span>
        <time>${esc(timeAgo(directReview ? session.attention?.requestedAt || session.updatedAt : entryTimestamp(entry)))}</time><i aria-hidden="true">→</i>
      </button>`;
    };
    const overflow = Math.max(0, ordered.length - shown.length);
    const compactOverflow = Math.max(0, ordered.length - 1);
    section.innerHTML = `<div class="home-attention-strip ${ordered.length ? "has-items" : "is-clear"}" data-home-attention="${ordered.length}">
      <button type="button" class="home-attention-title" data-management-filter="all">
        <span class="home-attention-column-heading">1. 내가 먼저 할 일</span>
        <span class="home-attention-signal" aria-hidden="true"><i>!</i></span>
        <span><small>${esc(t("control.attention_eyebrow"))}</small><b>${esc(t("control.attention_title", { active: activeItems, completed: completedItems, total: totalItems, shown: shown.length }))}</b><u>${esc(activeItems > 1 ? `나머지 ${activeItems - 1}건 모두 보기` : t("control.attention_view_all"))}</u></span>
        <strong>${esc(t("control.attention_total", { count: activeItems }))}</strong>
      </button>
      <div class="home-attention-list">${shown.map(item).join("")}</div>
      ${overflow ? `<button type="button" class="home-attention-more" data-management-filter="all">${esc(t("control.attention_more", { count: overflow }))}</button>` : compactOverflow ? `<button type="button" class="home-attention-more compact-only" data-management-filter="all">${esc(t("control.attention_more", { count: compactOverflow }))}</button>` : ""}
    </div>`;
    return totalItems;
  }

  function usageResetLabel(value) {
    if (!value) return t("usage.reset_unknown");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("usage.reset_unknown");
    return t("usage.resets_at", {
      time: new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date),
    });
  }

  function usageWindowHtml(window, kind) {
    const hasUsed = Number.isFinite(Number(window?.usedPercent));
    const hasRemaining = Number.isFinite(Number(window?.remainingPercent));
    if (!window || (!hasUsed && !hasRemaining)) {
      return `<div class="provider-limit-row is-unknown"><div><b>${esc(kind)}</b><span>${esc(t("usage.not_available"))}</span></div><div class="provider-limit-track"><i></i></div><small>${esc(t("usage.no_reset"))}</small></div>`;
    }
    const used = Math.max(0, Math.min(100,
      hasUsed ? Number(window.usedPercent) : 100 - Number(window.remainingPercent)));
    const tone = used >= 90 ? "critical" : used >= 70 ? "warning" : "healthy";
    return `<div class="provider-limit-row ${tone}">
      <div><b>${esc(window.label || kind)}</b><span>${esc(t("usage.used_percent", { percent: Math.round(used) }))}</span></div>
      <div class="provider-limit-track" role="progressbar" aria-label="${esc(t("usage.used_meter_label", { label: window.label || kind, percent: Math.round(used) }))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"><i style="width:${used}%"></i></div>
      <small>${esc(usageResetLabel(window.resetsAt))}</small>
    </div>`;
  }

  function usageUnavailableReason(item, provider) {
    if (!state.availability[provider.id]) return t("usage.cli_unavailable");
    if (item?.reason === "not-signed-in") return t("usage.sign_in_required");
    if (item?.reason === "usage-not-observed") return t("usage.run_once");
    if (item?.reason === "request-failed" || String(item?.reason || "").startsWith("http-")) return t("usage.refresh_failed");
    return t("usage.provider_not_supported");
  }

  function renderProviderUsage(section) {
    if (!section) return;
    const providers = (state.providers || []).filter(provider => !state.hiddenProviders.has(provider.id));
    section.classList.remove("hidden");
    section.removeAttribute("aria-hidden");
    const cards = providers.map(provider => {
      const item = state.providerUsage?.providers?.[provider.id];
      const info = providerInfo(provider.id);
      const windows = item?.available && (item.shortWindow || item.weekly || item.modelWindow)
        ? `${usageWindowHtml(item.shortWindow, t("usage.short_limit"))}${usageWindowHtml(item.weekly, t("usage.weekly_limit"))}${item.modelWindow ? usageWindowHtml(item.modelWindow, t("usage.model_limit")) : ""}`
        : `<div class="provider-limit-unavailable"><b>${esc(t("usage.unavailable"))}</b><span>${esc(usageUnavailableReason(item, provider))}</span></div>`;
      return `<article class="provider-limit-card" style="--usage-provider:${info.accent}" data-provider-usage="${esc(provider.id)}">
        <header><span class="provider-limit-mark">${esc(info.mark)}</span><div><b>${esc(info.label)}</b><small>${esc(item?.plan ? t("usage.plan", { plan: item.plan }) : t("usage.account_limit"))}</small></div></header>
        ${windows}
      </article>`;
    }).join("");
    section.innerHTML = `<div class="provider-usage-overview">
      <header class="provider-usage-head"><div><p>${esc(t("usage.eyebrow"))}</p><h2>${esc(t("usage.title"))}</h2><span>${esc(t("usage.description"))}</span></div>
      <button type="button" data-provider-usage-refresh ${state.providerUsageLoading ? 'disabled aria-busy="true"' : ""}>${esc(t(state.providerUsageLoading ? "usage.refreshing" : "usage.refresh"))}</button></header>
      <div class="provider-limit-grid">${cards || `<div class="provider-limit-unavailable"><b>${esc(t("usage.no_visible_ai"))}</b></div>`}</div>
      <footer>${esc(t("usage.accuracy_note"))}</footer>
    </div>`;
  }

  async function refreshProviderUsage(force = false) {
    if (!window.loadtoagent?.providerUsage || state.providerUsageLoading) return state.providerUsage;
    state.providerUsageLoading = true;
    if (state.view === "all" && state.workspace !== "all") renderOperationsOverview();
    try {
      state.providerUsage = await window.loadtoagent.providerUsage({ force: Boolean(force) });
    } finally {
      state.providerUsageLoading = false;
      if (state.view === "all" && state.workspace !== "all") renderOperationsOverview();
      renderGlobalStats();
    }
    return state.providerUsage;
  }

  function renderOperationsOverview() {
    const section = $("#operationsOverview");
    if (!section) return;
    section.innerHTML = "";
    section.classList.add("hidden");
    section.setAttribute("aria-hidden", "true");
    document.body.dataset.homeAttentionCount = "0";
    if (state.view === "all") {
      $("#pageEyebrow").textContent = t("control.home_eyebrow");
      $("#pageTitle").textContent = t("control.home_title_clear", { count: 0 });
      $("#pageSubtitle").textContent = t("control.home_subtitle");
    }
    return;
    const sessions = typeof context.graphFilteredSessions === "function"
      ? context.graphFilteredSessions()
      : (state.snapshot?.sessions || []);
    const byId = new Map(sessions.map(session => [session.id, session]));
    const critical = sessions.filter(session => matchesManagementFilter(session, "critical"));
    const warning = sessions.filter(session => matchesManagementFilter(session, "warning"));
    const responses = sessions.filter(session => matchesManagementFilter(session, "attention"));
    const flaggedIds = new Set([...critical, ...warning, ...responses].map(session => session.id));
    const clear = sessions.filter(session => !flaggedIds.has(session.id));
    const reviewCount = flaggedIds.size;
    const descendantCache = new Map();
    const descendants = session => {
      if (descendantCache.has(session.id)) return descendantCache.get(session.id);
      const found = [];
      const queue = [...(session.childIds || [])];
      const visited = new Set();
      while (queue.length) {
        const id = queue.shift();
        if (!id || visited.has(id)) continue;
        visited.add(id);
        const child = byId.get(id);
        if (!child) continue;
        found.push(child);
        queue.push(...(child.childIds || []));
      }
      descendantCache.set(session.id, found);
      return found;
    };
    const runningExecutions = session => (session.executions || []).filter(execution => execution.status === "running");
    const supervisionCandidates = sessions.filter(session =>
      isLiveSession(session)
      || ["paused", "waiting"].includes(session.status)
      || runningExecutions(session).length > 0,
    );
    const controlModeCache = new Map();
    const controlMode = session => {
      if (controlModeCache.has(session.id)) return controlModeCache.get(session.id);
      const targets = typeof context.agentCommandTargets === "function" ? context.agentCommandTargets(session) : [];
      const mode = typeof context.agentControlMode === "function" ? context.agentControlMode(session, targets) : "ended";
      controlModeCache.set(session.id, mode);
      return mode;
    };
    const directControl = mode => mode === "direct";
    const recoverableControl = mode => ["handoff", "resume", "origin-resume"].includes(mode);
    const controlTone = mode => directControl(mode) ? "ready" : recoverableControl(mode) ? "recover" : "observe";
    const rankingNow = Date.now();
    const operationTimestamp = session => Math.max(0, ...[
      session.progress?.lastActivityAt,
      session.health?.lastActivityAt,
      session.updatedAt,
      ...(session.executions || []).map(execution => execution.updatedAt || execution.startedAt),
    ].map(value => Date.parse(value || 0)).filter(Number.isFinite));
    const freshnessScore = session => supervisionFreshnessScore(operationTimestamp(session), rankingNow);
    const rankScore = session => {
      const children = descendants(session);
      const activeChildren = children.filter(isLiveSession).length;
      const executionCount = runningExecutions(session).length;
      const mode = controlMode(session);
      return freshnessScore(session)
        + (isLiveSession(session) ? 260 : ["paused", "waiting"].includes(session.status) ? 160 : 0)
        + (!session.parentId ? 30 : 0)
        + activeChildren * 75
        + children.length * 5
        + executionCount * 90
        + (directControl(mode) ? 40 : recoverableControl(mode) ? 15 : 0)
        + ((session.runtimePresence || []).length ? 15 : 0);
    };
    const ordered = [...supervisionCandidates].sort((a, b) =>
      rankScore(b) - rankScore(a)
      || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)
      || String(a.title || "").localeCompare(String(b.title || "")),
    );
    const selected = ordered.find(session => session.id === state.supervisionFocusId) || ordered[0] || null;
    if (!state.supervisionFocusId && selected) state.supervisionFocusId = selected.id;
    const selectedRank = selected ? ordered.findIndex(session => session.id === selected.id) + 1 : 0;
    const selectedIsRecommended = selectedRank === 1;
    const liveRoots = ordered.filter(session => !session.parentId && isLiveSession(session));
    const liveHelpers = ordered.filter(session => session.parentId && isLiveSession(session));
    const runningExecutionCount = ordered.reduce((sum, session) => sum + runningExecutions(session).length, 0);
    const readyControlCount = ordered.filter(session => directControl(controlMode(session))).length;

    const supervisionReason = session => {
      const activeChildren = descendants(session).filter(isLiveSession).length;
      const executionCount = runningExecutions(session).length;
      const mode = controlMode(session);
      const timestamp = operationTimestamp(session);
      const factors = [t("management.supervision_factor_activity", { time: timestamp ? timeAgo(timestamp) : t("management.signal_unavailable") })];
      if (activeChildren) factors.push(t("management.supervision_factor_helpers", { count: activeChildren }));
      if (executionCount) factors.push(t("management.supervision_factor_executions", { count: executionCount }));
      if (directControl(mode)) factors.push(t("management.supervision_factor_input"));
      else if (recoverableControl(mode)) factors.push(t("management.supervision_factor_recover"));
      if (session.parentId) factors.push(t("management.supervision_factor_delegated"));
      return factors.join(" · ");
    };
    const statusLabel = status => ({
      starting: t("ui.preparing"), running: t("ui.working"), paused: t("management.attention.paused"),
      waiting: t("ui.waiting_for_review"), failed: t("ui.problem"), completed: t("ui.completed"),
    })[status] || status;
    const controlLabel = mode => t(`management.supervision_control_${mode}`);
    const queue = ordered.map(session => {
      const index = ordered.findIndex(candidate => candidate.id === session.id);
      const provider = providerInfo(session.provider);
      const activity = currentActivity(session);
      const children = descendants(session).filter(isLiveSession).length;
      const executions = runningExecutions(session).length;
      const mode = controlMode(session);
      const selectedClass = session.id === selected?.id ? "selected" : "";
      return `<button type="button" class="supervision-queue-item ${selectedClass}" data-supervision-focus="${esc(session.id)}" aria-pressed="${session.id === selected?.id ? "true" : "false"}" style="--management-provider:${provider.accent}">
        <span class="supervision-rank">${index + 1}</span>
        <span class="provider-mark">${esc(provider.mark)}</span>
        <span class="supervision-queue-copy"><small>${esc(session.parentId ? t("management.supervision_helper_agent") : t("management.supervision_main_agent"))} · ${esc(provider.label)}</small><b>${esc(readablePreview(session.agentName || session.title, 62).text)}</b><em>${esc(prioritySummary(activity.title || session.statusDetail))}</em><i>${esc(supervisionReason(session))}</i></span>
        <span class="supervision-queue-meta"><b class="${controlTone(mode)}">${esc(controlLabel(mode))}</b><small>${children ? esc(t("management.supervision_live_helpers_short", { count: children })) : executions ? esc(t("management.supervision_executions_short", { count: executions })) : esc(timeAgo(session.updatedAt))}</small></span>
      </button>`;
    }).join("");

    let primary = "";
    if (selected) {
      const provider = providerInfo(selected.provider);
      const parent = selected.parentId ? byId.get(selected.parentId) : null;
      const children = descendants(selected);
      const activeChildren = children.filter(isLiveSession);
      const executions = runningExecutions(selected);
      const activity = currentActivity(selected);
      const mode = controlMode(selected);
      const delegation = selected.delegation || {};
      const goal = selected.parentId
        ? (delegation.assignment || delegation.taskName || selected.taskName || selected.title)
        : (selected.sharedGoal || selected.title);
      const downstream = activeChildren.length
        ? t("management.supervision_downstream_helpers", { count: activeChildren.length, names: activeChildren.slice(0, 3).map(child => child.agentName || providerInfo(child.provider).label).join(" · ") })
        : executions.length
          ? t("management.supervision_downstream_executions", { count: executions.length, names: executions.slice(0, 3).map(execution => execution.label || execution.runtime || execution.tool).join(" · ") })
          : t("management.supervision_downstream_none");
      const role = selected.parentId
        ? t("management.supervision_helper_role", { role: selected.agentRole ? agentRoleLabel(selected.agentRole) : t("ui.assistance") })
        : t("management.supervision_owner_role");
      const focusLabel = selectedIsRecommended
        ? t("management.supervision_primary")
        : t("management.supervision_selected", { rank: selectedRank });
      const reasonLabel = selectedIsRecommended
        ? t("management.supervision_why_first")
        : t("management.supervision_why_selected", { rank: selectedRank });
      primary = `<article class="supervision-primary" data-supervision-session="${esc(selected.id)}" style="--management-provider:${provider.accent}">
        <header class="supervision-primary-head">
          <span class="provider-mark">${esc(provider.mark)}</span>
          <div><small data-supervision-focus-kind="${selectedIsRecommended ? "recommended" : "selected"}">${esc(focusLabel)} · ${esc(role)}</small><h3>${esc(readablePreview(selected.agentName || selected.title, 96).text)}</h3><p>${esc(provider.label)} · ${esc(selected.model || t("session.model_unknown"))}${parent ? ` · ${esc(t("management.supervision_parent", { parent: readablePreview(parent.agentName || parent.title, 46).text }))}` : ""}</p></div>
          <span class="supervision-status ${esc(selected.status || "")}"><i aria-hidden="true"></i>${esc(statusLabel(selected.status))}</span>
        </header>
        <div class="supervision-mobile-now">
          <div><span>${esc(t("management.supervision_current_behavior"))}</span><b>${esc(prioritySummary(activity.title || selected.statusDetail))}</b><small>${esc(prioritySummary(latestWorkCopy(selected) || activity.detail || selected.statusDetail))}</small></div>
          <button type="button" data-supervision-intervention-open="${esc(selected.id)}">${esc(t("management.supervision_intervention_mobile"))}</button>
        </div>
        <div class="supervision-watch-reason"><span>${esc(reasonLabel)}</span><b>${esc(supervisionReason(selected))}</b><small>${esc(t("management.supervision_updated", { time: timeAgo(selected.updatedAt) }))}</small></div>
        <div class="supervision-behavior" aria-label="${esc(t("management.supervision_behavior_trace"))}">
          <section><span><i>1</i>${esc(t("management.supervision_goal"))}</span><b>${esc(prioritySummary(goal))}</b><small>${esc(role)}</small></section>
          <i class="supervision-flow-arrow" aria-hidden="true">→</i>
          <section class="current"><span><i>2</i>${esc(t("management.supervision_current_behavior"))}</span><b>${esc(prioritySummary(activity.title || selected.statusDetail))}</b><small>${esc(prioritySummary(latestWorkCopy(selected) || activity.detail || selected.statusDetail))}</small></section>
          <i class="supervision-flow-arrow" aria-hidden="true">→</i>
          <section><span><i>3</i>${esc(t("management.supervision_downstream"))}</span><b>${esc(downstream)}</b><small>${esc(t("management.supervision_downstream_counts", { helpers: activeChildren.length, executions: executions.length }))}</small></section>
        </div>
        <div class="supervision-control-strip">
          <div><span>${esc(t("management.supervision_control_channel"))}</span><b class="${controlTone(mode)}"><i aria-hidden="true"></i>${esc(controlLabel(mode))}</b><small>${esc(t(`management.supervision_control_help_${mode}`))}</small></div>
          <div class="supervision-control-actions">
            <button type="button" data-graph-focus="${esc(selected.id)}">${esc(t("management.supervision_open_flow"))}</button>
            <button type="button" data-open-session="${esc(selected.id)}">${esc(t("management.supervision_open_detail"))}</button>
          </div>
        </div>
        ${controlButtonsHtml(selected)}
        ${typeof context.agentCommandComposer === "function" ? `<details class="supervision-intervention" data-disclosure-key="supervision:command:${esc(selected.id)}"><summary><span><b>${esc(t("management.supervision_intervention"))}</b><small>${esc(t("management.supervision_intervention_hint"))}</small></span><i aria-hidden="true">⌄</i></summary>${context.agentCommandComposer(selected)}</details>` : ""}
      </article>`;
    }

    section.innerHTML = `<header>
      <div class="operations-heading">
        <span class="operations-signal" aria-hidden="true"><i></i><i></i><i></i></span>
        <div class="operations-heading-copy"><p>${esc(t("management.supervision_eyebrow"))}</p><h2>${esc(t("management.supervision_title"))}</h2><span>${esc(t("management.supervision_description"))}</span></div>
      </div>
      <button type="button" class="operations-review-total" data-management-filter="all"><strong>${reviewCount}</strong><span>${esc(t("management.supervision_attention_open"))}</span><i aria-hidden="true">→</i></button>
    </header>
    <div class="supervision-metrics" aria-label="${esc(t("management.supervision_metrics_label"))}">
      <div><span>${esc(t("management.supervision_active_roots"))}</span><b>${liveRoots.length}</b></div>
      <div><span>${esc(t("management.supervision_active_helpers"))}</span><b>${liveHelpers.length}</b></div>
      <div><span>${esc(t("management.supervision_running_executions"))}</span><b>${runningExecutionCount}</b></div>
      <div><span>${esc(t("management.supervision_control_ready"))}</span><b>${readyControlCount}</b></div>
    </div>
    ${selected ? `<div class="supervision-console"><aside class="supervision-queue"><header><div><span>${esc(t("management.supervision_queue"))}</span><b>${esc(t("management.supervision_queue_hint"))}</b></div><strong>${ordered.length}</strong></header><div>${queue}</div></aside>${primary}</div>` : `<div class="supervision-empty"><span aria-hidden="true">◎</span><b>${esc(t("management.supervision_empty"))}</b><small>${esc(t("management.supervision_empty_detail"))}</small></div>`}
    <div class="supervision-attention-bar" aria-label="${esc(t("management.operations_severity_buckets"))}">
      <span>${esc(t("management.supervision_attention_summary"))}</span>
      <button type="button" data-management-filter="attention" data-management-metric="attention"><i></i>${esc(t("management.health.attention"))}<b>${responses.length}</b></button>
      <button type="button" data-management-filter="critical" data-management-metric="critical"><i></i>${esc(t("management.health.critical"))}<b>${critical.length}</b></button>
      <button type="button" data-management-filter="warning" data-management-metric="warning"><i></i>${esc(t("management.health.warning"))}<b>${warning.length}</b></button>
      <span class="supervision-clear" data-management-metric="clear">${esc(t("management.recent_clear"))}<b>${clear.length}</b></span>
    </div>`;
  }

  function outcomeHtml(session) {
    const outcome = session.outcome || { artifacts: [], checks: [] };
    const evidence = session.evidence || { sources: [] };
    const controls = session.controlCapabilities || {};
    const pendingReviewTargets = resultReviewTargets(session);
    return `<div class="management-detail">
      ${pendingReviewTargets.length ? `<section class="management-result-review" aria-labelledby="managementResultReviewTitle">
        <div><span>${esc(t("management.result_review_eyebrow"))}</span><b id="managementResultReviewTitle">${esc(t("management.result_review_title"))}</b><small>${esc(t("management.result_review_help"))}</small></div>
        <button type="button" data-result-review-complete="${esc(session.id)}">${esc(t("management.result_review_complete"))}</button>
      </section>` : ""}
      <section class="management-outcome ${esc(outcome.status || "in-progress")}">
        <header><div><span>${esc(t("management.outcome"))}</span><h3>${esc(t(`management.outcome.${outcome.status || "in-progress"}`))}</h3></div><em class="${outcome.verified ? "verified" : "unverified"}">${esc(outcome.verified ? t("management.verified") : t("management.unverified"))}</em></header>
        <p>${esc(outcome.summary || t("management.outcome_pending"))}</p>
      </section>
      ${(session.attention?.category && session.attention.category !== "none") || session.attention?.required ? `<section class="management-attention-detail"><header><span>${esc(attentionLabel(session.attention.kind))}</span><b>${esc(session.attention.summary)}</b></header>${quickActionsHtml(session)}${controls.sendInstruction ? context.agentCommandComposer(session) : ""}</section>` : ""}
      ${progressHtml(session)}
      ${healthHtml(session)}
      <section class="management-artifacts"><header><span>${esc(t("management.artifacts"))}</span><b>${esc(t("common.items", { count: (outcome.artifacts || []).length }))}</b></header>${outcome.artifacts?.length ? `<ul>${outcome.artifacts.map(item => `<li><i>${esc(item.kind)}</i><b title="${esc(item.value)}">${esc(item.value)}</b><span>${esc(t("management.detected"))}</span></li>`).join("")}</ul>` : `<p>${esc(t("management.no_artifacts"))}</p>`}</section>
      <section class="management-checks"><header><span>${esc(t("management.verification_checks"))}</span><b>${esc(t("common.items", { count: (outcome.checks || []).length }))}</b></header>${outcome.checks?.length ? `<ul>${outcome.checks.map(check => `<li class="${esc(check.status)}"><i></i><b>${esc(check.label)}</b><span>${esc(t(`management.check.${check.status}`))}</span></li>`).join("")}</ul>` : `<p>${esc(t("management.no_checks"))}</p>`}</section>
      <section class="management-evidence"><header><span>${esc(t("management.evidence_title"))}</span><b>${esc(evidenceLabel(evidence.confidence))}</b></header><dl><div><dt>${esc(t("management.evidence_status"))}</dt><dd>${esc(evidenceLabel(evidence.status))}</dd></div><div><dt>${esc(t("management.evidence_hierarchy"))}</dt><dd>${esc(evidenceLabel(evidence.hierarchy))}</dd></div><div><dt>${esc(t("management.evidence_completion"))}</dt><dd>${esc(evidenceLabel(evidence.completion))}</dd></div></dl><p>${esc((evidence.sources || []).join(" · ") || t("management.signal_unavailable"))}</p></section>
      <section class="management-controls"><header><span>${esc(t("management.controls"))}</span><b>${esc(t("management.controls_description"))}</b></header>${controlButtonsHtml(session)}</section>
    </div>`;
  }

  return {
    isRecentSession,
    managementBucket,
    matchesManagementFilter,
    rootManagementReviews,
    needsManagementInbox,
    needsManagementReview,
    attentionCardHtml,
    quickActionsHtml,
    controlButtonsHtml,
    healthHtml,
    outcomeHtml,
    progressHtml,
    renderAttentionInbox,
    renderOperationsOverview,
    refreshProviderUsage,
    supervisionFreshnessScore,
  };
};
