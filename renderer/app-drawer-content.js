"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawerContent = function createDrawerContent(context = {}) {
  const { esc, uiLocale, state, messageContentHtml, compact, fullNumber, timeOnly, providerInfo, statusIcon, agentPathTaskName, snapshotSession } = context;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);

  function chatHtml(session, options = {}) {
    const messages = session.messages || [];
    if (!messages.length) return `<div class="empty-state"><h3>${esc(t("drawer.no_conversation"))}</h3></div>`;
    const userLabel = options.userLabel || t("drawer.user");
    const assistantLabel = options.assistantLabel || providerInfo(session.provider).label;
    const conversationLabel = options.conversationLabel || t("drawer.conversation");
    const conversation = messages.filter((message) => message.role === "user" || message.role === "assistant");
    const activities = messages.filter((message) => message.role !== "user" && message.role !== "assistant");
    const omitted = Number(session.omittedMessages || 0);
    const notice =
      omitted || session.truncated
        ? `<div class="chat-truncated">${esc(t("drawer.recent_history"))}${omitted ? ` · ${esc(t("drawer.messages_omitted", { count: omitted.toLocaleString(uiLocale()) }))}` : ""}</div>`
        : "";
    const statusLabels = {
      started: t("ui.working"), running: t("ui.working"),
      done: t("ui.completed"), completed: t("ui.completed"), failed: t("drawer.failed"),
    };
    const statusLabel = (value) => statusLabels[value] || value || "";
    const rows = conversation
      .map((message) => {
        const role = message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : message.role === "system" ? "system" : "user";
        const renderedMessage = role === "tool" || role === "system"
          ? { ...message, text: window.LoadToAgentI18n.observedText(message.text) }
          : message;
        const label =
          role === "assistant"
            ? assistantLabel
            : role === "tool"
              ? window.LoadToAgentI18n.observedText(message.title || t("session.tool"))
              : message.role === "system"
                ? t("drawer.system")
                : userLabel;
        const avatar = role === "assistant" ? providerInfo(session.provider).mark : role === "tool" ? "⌘" : role === "system" ? "i" : "ME";
        const fullTime = new Date(message.timestamp).toLocaleString(uiLocale());
        return `<div class="chat-row ${role}" data-message-id="${esc(message.id || "")}">
        <span class="chat-avatar">${esc(avatar)}</span>
        <div class="chat-bubble">
        <div class="chat-bubble-head">
        <b>${esc(label)}</b>
        <span title="${esc(fullTime)}">${esc(timeOnly(message.timestamp))}</span>
        ${message.status ? `<span>${esc(statusLabel(message.status))}</span>` : ""}
        </div>${messageContentHtml(renderedMessage)}</div>
        </div>`;
      })
      .join("");
    const activityHtml = activities.length
      ? `<details class="chat-activities">
      <summary>${esc(t("drawer.activities_view", { count: activities.length }))}</summary>
      <div>${activities
        .map(
          (message) => `<article>
      <header>
      <b>${esc(window.LoadToAgentI18n.observedText(message.title || (message.role === "tool" ? t("drawer.tool_execution") : t("drawer.system"))))}</b>
      <span>${esc(statusLabel(message.status))} · ${esc(timeOnly(message.timestamp))}</span>
      </header>${messageContentHtml({ ...message, text: window.LoadToAgentI18n.observedText(message.text) })}</article>`,
        )
        .join("")}</div>
      </details>`
      : "";
    const emptyConversation = conversation.length ? "" : `<div class="empty-state compact"><h3>${esc(t("drawer.no_user_ai_conversation"))}</h3></div>`;
    return `${notice}<div class="chat-history-head">
      <span>${esc(t("drawer.conversation_summary", { label: conversationLabel, count: conversation.length, activities: activities.length ? ` · ${t("drawer.activities", { count: activities.length })}` : "" }))}</span>
      <button type="button" data-scroll-latest>${esc(t("drawer.latest_conversation"))} ↓</button>
      </div>
      <div class="chat-list">${rows}${emptyConversation}${activityHtml}<div class="chat-latest-anchor" aria-label="${esc(t("drawer.latest_conversation"))}">
      </div>
      </div>`;
  }

  function lifecycleHtml(session) {
    const events = session.lifecycle || [];
    if (!events.length) return `<div class="empty-state"><h3>${esc(t("drawer.no_lifecycle"))}</h3></div>`;
    return `<div class="lifecycle-list">${events
      .map(
        (event) => `<div class="lifecycle-event ${esc(event.status)}">
      <span class="life-node">${statusIcon(event.type)}</span>
      <div class="life-copy">
      <b>${esc(window.LoadToAgentI18n.observedText(event.label))}</b>
      <span>${esc(window.LoadToAgentI18n.observedText(event.detail || event.type))}</span>
      </div>
      <time>${esc(timeOnly(event.timestamp))}</time>
      </div>`,
      )
      .join("")}</div>`;
  }

  function tokensHtml(session) {
    const usage = session.usage || {};
    const turn = session.turnUsage || {};
    const context = session.context || {};
    const sourceLabel =
      context.source === "session"
        ? t("drawer.context_source_session")
        : context.source === "model-catalog"
          ? t("drawer.context_source_catalog")
          : t("session.context_size_unknown");
    return `<div class="token-hero" style="--drawer-provider:${providerInfo(session.provider).accent}">
      <div class="token-hero-head">
        <span>${esc(t("session.context_usage"))}</span>
        <b>${esc(t("drawer.tokens", { count: context.window ? `${fullNumber(context.used)} / ${fullNumber(context.window)}` : fullNumber(context.used) }))}</b>
        </div>
      <div class="big-context"><span style="width:${Math.min(100, context.percent || 0)}%"></span></div>
      <div class="context-scale">
        <span>0</span><span>${(context.percent || 0).toFixed(1)}%</span>
        <span>${context.window ? compact(context.window) : "--"}</span>
      </div>
    </div>
    <div class="token-grid">
      <div class="token-tile"><span>${esc(t("drawer.input"))}</span><strong>${fullNumber(usage.input)}</strong><small>${esc(t("drawer.input_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.output"))}</span><strong>${fullNumber(usage.output)}</strong><small>${esc(t("drawer.output_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.cached"))}</span><strong>${fullNumber(usage.cachedInput)}</strong><small>${esc(t("drawer.cached_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.cache_write"))}</span><strong>${fullNumber(usage.cacheWrite)}</strong><small>${esc(t("drawer.cache_write_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.reasoning"))}</span><strong>${fullNumber(usage.reasoning)}</strong><small>${esc(t("drawer.reasoning_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.total"))}</span><strong>${fullNumber(usage.total)}</strong><small>${esc(t("drawer.total_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.last_input"))}</span><strong>${fullNumber(turn.input)}</strong><small>${esc(t("drawer.latest_turn"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.last_total"))}</span><strong>${fullNumber(turn.total)}</strong><small>${esc(t("drawer.last_total_help"))}</small></div>
    </div><div class="token-note">${esc(t("drawer.token_note", { source: sourceLabel }))}</div>`;
  }

  function subagentCommunicationEvents(session) {
    if (!session || !session.parentId) return [];
    const parent = state.details.get(session.parentId) || snapshotSession(session.parentId);
    const all = (parent && parent.collaboration && parent.collaboration.communications) || [];
    const taskName = session.taskName || (session.delegation && session.delegation.taskName) || agentPathTaskName(session.agentPath);
    return all
      .filter((event) => ["assignment", "started", "followup", "message", "result", "interrupt"].includes(event.kind))
      .filter((event) => event.childId === session.id || (taskName && event.taskName === taskName));
  }

  function subagentTextPreview(value, maxCharacters = 360) {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= maxCharacters) return { text, truncated: false };
    return { text: `${text.slice(0, maxCharacters).trimEnd()}…`, truncated: true };
  }

  function subagentCoordinationEvents(session) {
    return subagentCommunicationEvents(session).filter((event) => {
      if (!event || event.protected || event.kind === "started") return false;
      if (!["assignment", "followup", "message", "result", "interrupt"].includes(event.kind)) return false;
      const text = String(event.text || "").trim();
      return Boolean(text && text.toLowerCase() !== "started");
    });
  }

  function subagentWorkMessages(session) {
    const messages = [...(session.messages || [])];
    const hasConversation = messages.some((message) =>
      (message.role === "user" || message.role === "assistant") && String(message.text || "").trim(),
    );
    if (hasConversation) return messages;
    const delegation = session.delegation || {};
    if (delegation.assignmentObserved && !delegation.assignmentProtected && String(delegation.assignment || "").trim()) {
      messages.push({
        id: `${session.id}:delegation`, role: "user", text: delegation.assignment,
        timestamp: delegation.startedAt || session.startedAt || session.updatedAt,
      });
    }
    if (String(session.result || delegation.result || "").trim()) {
      messages.push({
        id: `${session.id}:result`, role: "assistant", text: session.result || delegation.result,
        timestamp: session.completedAt || delegation.completedAt || session.updatedAt,
      });
    }
    return messages.sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
  }

  function subagentCoordinationHtml(session) {
    const events = subagentCoordinationEvents(session);
    if (!events.length) return "";
    const taskName = session.taskName || (session.delegation && session.delegation.taskName) || session.title;
    const childPath = String(session.agentPath || "");
    const endpointIsChild = (value) => {
      const endpoint = String(value || "");
      return endpoint === childPath || endpoint === session.id || agentPathTaskName(endpoint) === taskName;
    };
    const rows = events
      .map((event) => {
        const fromChild = event.kind === "result" || endpointIsChild(event.from);
        const preview = subagentTextPreview(event.text);
        const label = fromChild ? t("drawer.child_to_main", { child: session.agentName || taskName }) : t("drawer.main_to_child");
        return `<article data-subagent-communication="${esc(event.kind)}">
          <header><b>${esc(window.LoadToAgentI18n.observedText(event.label || event.kind))}</b><span>${esc(label)} · ${esc(timeOnly(event.timestamp))}</span></header>
          <div class="chat-content plain subagent-message-preview${preview.truncated ? " is-truncated" : ""}"
            data-subagent-message-preview data-truncated="${preview.truncated ? "true" : "false"}"><p>${esc(preview.text)}</p></div>
        </article>`;
      })
      .join("");
    return `<details class="chat-activities subagent-coordination" data-subagent-coordination-count="${events.length}">
      <summary>${esc(t("drawer.coordination_events", { count: events.length }))}</summary><div>${rows}</div>
    </details>`;
  }

  function subagentConversationHtml(session) {
    const messages = subagentWorkMessages(session);
    const conversationCount = messages.filter((message) => message.role === "user" || message.role === "assistant").length;
    const workSession = { ...session, messages };
    const sourceCopy = session.source === "collaboration-history"
      ? t("drawer.subagent_history_reconstructed")
      : t("drawer.subagent_history_actual");
    return `<section class="subagent-work-source" data-subagent-work-messages="${conversationCount}">
      <b>${esc(t("drawer.subagent_work_history"))}</b><span>${esc(sourceCopy)}</span>
    </section>${chatHtml(workSession, {
      userLabel: t("drawer.assignment"),
      assistantLabel: session.agentName || t("drawer.sub_ai"),
      conversationLabel: t("drawer.work_history"),
    })}${subagentCoordinationHtml(session)}`;
  }

  return { chatHtml, lifecycleHtml, tokensHtml, subagentCommunicationEvents, subagentCoordinationEvents, subagentTextPreview, subagentConversationHtml };
};
