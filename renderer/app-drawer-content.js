"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createDrawerContent = function createDrawerContent(context = {}) {
  const INITIAL_CONVERSATION_TURNS = 120;
  const CONVERSATION_TURN_PAGE = 120;
  const {
    esc, uiLocale, state, messageContentHtml, compact, fullNumber, timeOnly, providerInfo, statusIcon, agentPathTaskName, snapshotSession,
    controlRoomAgentGoal, inferredExecutionSummary, executionActivityLabel, executionActivityStatus,
    conversationDeliveryState, observeConversationDelivery,
  } = context;
  const t = (key, params) => window.WhiteboxI18n.t(key, params);

  function conversationTurns(session, options = {}) {
    const turns = [];
    let current = null;
    for (const message of session.messages || []) {
      if (!message) continue;
      if (message.role === "user") {
        current = { id: message.id || `turn-${turns.length}`, user: message, assistants: [], activityAfterAssistant: false };
        turns.push(current);
        continue;
      }
      if (message.role === "assistant") {
        if (!current) {
          const title = String(session.title || "").trim();
          const syntheticUser = options.synthesizeRequest === false || !title
            ? null
            : {
              id: `${session.id}:request`, role: "user", text: title,
              timestamp: session.startedAt || message.timestamp,
            };
          current = { id: syntheticUser?.id || message.id || `turn-${turns.length}`, user: syntheticUser, assistants: [], activityAfterAssistant: false };
          turns.push(current);
        }
        current.assistants.push(message);
        current.activityAfterAssistant = false;
        continue;
      }
      if (message.role === "tool" && current && current.assistants.length) current.activityAfterAssistant = true;
    }
    const latestIndex = turns.length - 1;
    const live = options.forceLatestLive || session.status === "running" || session.status === "starting";
    return turns.map((turn, index) => ({
      ...turn,
      representative: turn.assistants.at(-1) || null,
      progress: turn.assistants.slice(0, -1),
      live: live && index === latestIndex,
      awaitingFinal: Boolean(turn.activityAfterAssistant),
    }));
  }

  function conversationRowHtml(message, session, options = {}) {
    if (!message) return "";
    const assistant = message.role === "assistant";
    const label = assistant ? options.assistantLabel : options.userLabel;
    const avatar = assistant ? providerInfo(session.provider).mark : t("drawer.me_mark");
    const fullTime = new Date(message.timestamp).toLocaleString(uiLocale());
    const workingIndicator = options.live
      ? `<span class="chat-working-dots" aria-hidden="true"><i></i><i></i><i></i></span>`
      : "";
    const answerKind = assistant && options.answerKind
      ? `<span class="chat-answer-kind${options.live ? " is-live" : ""}">${esc(options.answerKind)}${workingIndicator}</span>`
      : "";
    const deliveryStatusKey = {
      sending: "drawer.message_sending",
      confirming: "drawer.message_confirming",
      delayed: "drawer.message_unconfirmed",
      uncertain: "drawer.message_uncertain",
      received: "drawer.message_received",
      responding: "drawer.message_responding",
      interrupted: "drawer.message_interrupted",
      failed: "drawer.message_failed",
    };
    const deliveryStatus = !assistant && message.deliveryStatus
      ? `<span class="chat-delivery-status ${esc(message.deliveryStatus)}">${esc(t(deliveryStatusKey[message.deliveryStatus]
        || "drawer.message_sent"))}</span>`
      : "";
    const optimisticClasses = message.optimistic
      ? ` is-optimistic is-${esc(message.deliveryStatus || "awaiting")}${message.animate ? " is-new" : ""}`
      : "";
    const messageBody = assistant
      ? messageContentHtml(message, session.id)
      : userPromptHtml(message, session);
    return `<div class="chat-row ${assistant ? "assistant" : "user"}${optimisticClasses}" data-message-id="${esc(message.id || "")}">
      <span class="chat-avatar">${esc(avatar)}</span>
      <div class="chat-bubble">
      <div class="chat-bubble-head">
      <b>${esc(label)}</b>
      <span title="${esc(fullTime)}">${esc(timeOnly(message.timestamp))}</span>${deliveryStatus}${answerKind}
      </div>${messageBody}</div>
      </div>`;
  }

  function userPromptHtml(message, session) {
    const text = String(message?.text || "").trim();
    if (!text) return messageContentHtml(message, session.id);
    const characters = typeof Intl?.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(uiLocale(), { granularity: "grapheme" }).segment(text), item => item.segment)
      : Array.from(text);
    const truncated = characters.length > 200;
    const messageKey = String(message.id || message.timestamp || `${characters.length}:${text.slice(0, 32)}`);
    const promptKey = `prompt:${session.id}:${messageKey}`;
    const contentId = `user-prompt-${String(promptKey).replace(/[^a-z0-9_-]/gi, "-")}`;
    const expanded = truncated && state.expandedConversationPrompts.has(promptKey);
    const visibleText = expanded ? text : truncated ? `${characters.slice(0, 200).join("").trimEnd()}…` : text;
    const actions = position => `<div class="chat-prompt-actions ${position}">
      <span class="chat-prompt-length">${esc(t("drawer.prompt_length", { count: characters.length.toLocaleString(uiLocale()) }))}</span>
      <div class="chat-prompt-action-buttons">
        ${truncated ? `<button type="button" data-prompt-toggle="${esc(promptKey)}" data-short-label="${esc(t(expanded ? "drawer.prompt_close_short" : "drawer.prompt_show_full_short"))}" aria-controls="${esc(contentId)}" aria-expanded="${expanded ? "true" : "false"}"><span class="prompt-action-long-label">${esc(t(expanded ? "drawer.prompt_close" : "drawer.prompt_show_full"))}</span></button>` : ""}
        <button type="button" data-copy-text="${esc(text)}" data-user-prompt-copy="${esc(promptKey)}" data-short-label="${esc(t("drawer.prompt_copy_short"))}"><span class="prompt-action-long-label">${esc(t("drawer.prompt_copy"))}</span></button>
        ${position === "is-top" ? `<button type="button" class="expanded-reader-close" data-close-expanded-reader aria-label="${esc(t("common.close"))}">× <span>${esc(t("common.close"))}</span></button>` : ""}
      </div>
    </div>`;
    return `<div class="chat-user-prompt" data-user-prompt="${esc(promptKey)}"
      data-prompt-truncated="${truncated ? "true" : "false"}" data-prompt-expanded="${expanded ? "true" : "false"}">
      ${expanded ? actions("is-top") : ""}
      <div class="chat-content plain user-prompt-text" id="${esc(contentId)}">${esc(visibleText)}</div>
      ${actions(expanded ? "is-bottom" : "is-collapsed")}
    </div>`;
  }

  function conversationOverlay(session) {
    const pending = state.pendingConversationMessages.get(session.id) || [];
    const resolved = state.resolvedConversationMessages?.get(session.id) || [];
    const messageIdentity = message => {
      const id = String(message?.id || "").trim();
      return id
        ? `id:${id}`
        : `${message?.role || ""}:${String(message?.text || "").replace(/\s+/g, " ").trim()}:${message?.timestamp || ""}`;
    };
    const merged = new Map((session.messages || []).map(message => [messageIdentity(message), message]));
    for (const message of resolved) {
      const key = messageIdentity(message);
      if (!merged.has(key)) merged.set(key, message);
    }
    const messages = [...merged.values()];
    if (!pending.length) {
      messages.sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
      return {
        session: resolved.length ? { ...session, messages } : session,
        forceLatestLive: false,
      };
    }
    const retained = [];
    let forceLatestLive = false;
    for (const entry of pending) {
      const delivery = conversationDeliveryState({ ...session, messages }, entry);
      if (!delivery) continue;
      observeConversationDelivery(session, entry, delivery);
      if (delivery.phase === "responded") {
        clearTimeout(entry.confirmationTimer);
        continue;
      }
      if (!delivery.userMessage) {
        messages.push({
          id: entry.id,
          role: "user",
          text: entry.text,
          timestamp: entry.timestamp,
          optimistic: true,
          animate: !entry.presented,
          deliveryStatus: delivery.phase,
        });
        entry.presented = true;
      } else {
        // The lightweight snapshot can observe the delivered turn before the
        // full-history detail request catches up. Match by stable identity,
        // then insert the observed row when the detail cache does not have it
        // yet so an acknowledged user message never disappears in between.
        const actualIndex = messages.findIndex(message =>
          messageIdentity(message) === messageIdentity(delivery.userMessage));
        if (actualIndex >= 0) {
          messages[actualIndex] = {
            ...delivery.userMessage,
            deliveryStatus: delivery.phase,
          };
        } else {
          messages.push({
            ...delivery.userMessage,
            deliveryStatus: delivery.phase,
          });
        }
      }
      forceLatestLive = true;
      retained.push(entry);
    }
    if (retained.length) state.pendingConversationMessages.set(session.id, retained);
    else state.pendingConversationMessages.delete(session.id);
    messages.sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
    return { session: { ...session, messages }, forceLatestLive };
  }

  function subagentCallEvents(session) {
    const spawns = session?.collaboration?.spawns || [];
    const children = (session?.childIds || [])
      .map(id => state.details.get(id) || snapshotSession(id))
      .filter(Boolean);
    const recordedChildren = new Set(spawns.map(spawn => spawn.childId).filter(Boolean));
    const records = spawns.concat(children
      .filter(child => !recordedChildren.has(child.id)
        && !spawns.some(spawn => (spawn.agentPath && child.agentPath === spawn.agentPath)
          || (spawn.taskName && child.taskName === spawn.taskName)))
      .map(child => ({
        callId: `inferred:${child.id}`,
        childId: child.id,
        agentPath: child.agentPath,
        taskName: child.taskName || child.delegation?.taskName || child.agentName,
        assignment: child.delegation?.assignmentObserved ? child.delegation.assignment : "",
        assignmentProtected: Boolean(child.delegation?.assignmentProtected),
        assignmentSource: child.delegation?.assignmentSource || "unavailable",
        status: child.status,
        startedAt: child.delegation?.startedAt || child.startedAt,
      })));
    const calls = records.map((spawn, index) => {
      const child = (spawn.childId && (state.details.get(spawn.childId) || snapshotSession(spawn.childId)))
        || children.find(candidate => (spawn.agentPath && candidate.agentPath === spawn.agentPath)
          || (spawn.taskName && candidate.taskName === spawn.taskName));
      const timestamp = spawn.startedAt || child?.startedAt || session.startedAt || session.updatedAt;
      const assignmentProtected = Boolean(spawn.assignmentProtected || child?.delegation?.assignmentProtected);
      const observedAssignment = spawn.assignmentObserved
        ? spawn.assignment
        : (child?.delegation?.assignmentObserved ? child.delegation.assignment : "");
      const childTitle = String(child?.title || "").trim();
      return {
        id: spawn.callId || child?.id || `subagent-call-${index}`,
        childId: child?.id || spawn.childId || "",
        taskName: spawn.taskName || child?.taskName || child?.agentName || t("control.subagent"),
        assignment: observedAssignment,
        workSummary: observedAssignment || (!assignmentProtected && childTitle && childTitle !== session.title ? childTitle : ""),
        assignmentProtected,
        assignmentSource: spawn.assignmentSource || child?.delegation?.assignmentSource || "unavailable",
        status: child?.status || spawn.status || "idle",
        timestamp,
      };
    }).sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
    const messages = session.messages || [];
    return calls.map((call, index) => {
      const calledAt = Date.parse(call.timestamp || 0);
      const latestUserAt = messages.reduce((latest, message) => {
        const messageAt = Date.parse(message?.timestamp || 0);
        return message?.role === "user" && messageAt <= calledAt ? Math.max(latest, messageAt) : latest;
      }, Number.NEGATIVE_INFINITY);
      const anchor = [...messages].reverse().find(message => {
        const messageAt = Date.parse(message?.timestamp || 0);
        return message?.role === "assistant" && String(message.text || "").trim()
          && messageAt <= calledAt && messageAt >= latestUserAt;
      });
      const anchorText = String(anchor?.text || "").replace(/\s+/g, " ").trim();
      return {
        ...call,
        sequence: index + 1,
        anchorText: anchorText.length > 240 ? `${anchorText.slice(0, 240).trimEnd()}…` : anchorText,
        anchorTimestamp: anchor?.timestamp || "",
        requestTimestamp: Number.isFinite(latestUserAt) ? new Date(latestUserAt).toISOString() : "",
        elapsedAfterRequestMs: Number.isFinite(latestUserAt) && Number.isFinite(calledAt)
          ? Math.max(0, calledAt - latestUserAt)
          : null,
      };
    });
  }

  function subagentCallElapsed(milliseconds) {
    if (!Number.isFinite(milliseconds)) return "";
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (totalSeconds < 1) return t("drawer.duration_less_than_second");
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return t("drawer.duration_hours_minutes_seconds", { hours, minutes, seconds });
    if (minutes) return t("drawer.duration_minutes_seconds", { minutes, seconds });
    return t("drawer.duration_seconds", { seconds });
  }

  function subagentCallStatus(status) {
    if (status === "completed") return t("ui.completed");
    if (status === "running" || status === "starting") return t("ui.working");
    if (status === "waiting") return t("ui.waiting_for_review");
    if (status === "failed") return t("ui.problem");
    if (status === "cancelled") return t("ui.stopped");
    return t("ui.idle");
  }

  function subagentCallHtml(call, options = {}) {
    const fullTime = new Date(call.timestamp).toLocaleString(uiLocale());
    const assignment = call.workSummary || call.assignment || call.taskName || t("control.subagent");
    const elapsed = subagentCallElapsed(call.elapsedAfterRequestMs);
    const timing = elapsed
      ? t("drawer.called_after_user_request", { elapsed })
      : t("drawer.subagent_called");
    const anchorTime = call.anchorTimestamp ? timeOnly(call.anchorTimestamp) : "";
    const anchor = call.anchorText
      ? `<div class="subagent-call-anchor"><span aria-hidden="true">AI</span><div><small>${esc(t("drawer.called_after_main_message"))}${anchorTime ? ` · ${esc(anchorTime)}` : ""}</small><blockquote>${esc(call.anchorText)}</blockquote></div></div>`
      : `<div class="subagent-call-anchor is-context-only"><span aria-hidden="true">AI</span><div><small>${esc(t("drawer.main_called_here"))}</small></div></div>`;
    const showAnchor = options.showAnchor !== false || !call.anchorText;
    const content = `<span class="subagent-call-icon" aria-hidden="true">⑂</span>
      <span class="subagent-call-copy"><small class="subagent-call-timing">${esc(timing)}</small><span class="subagent-call-clock">${esc(t("drawer.subagent_call_point", { count: call.sequence }))} · <time title="${esc(fullTime)}">${esc(timeOnly(call.timestamp))}</time></span>
      <b>${esc(assignment)}</b><span>${esc(t("drawer.subagent_name", { name: call.taskName }))}</span></span>
      <span class="subagent-call-action"><em class="status-${esc(call.status)}">${esc(subagentCallStatus(call.status))}</em><strong>${esc(t("drawer.open_subagent_work"))} →</strong></span>`;
    const event = !call.childId
      ? `<div class="subagent-call-event is-unavailable" data-subagent-call-event="${esc(call.id)}">${content}</div>`
      : `<button type="button" class="subagent-call-event" data-subagent-call-event="${esc(call.id)}"
        data-open-subagent-chat="${esc(call.childId)}" aria-label="${esc(t("control.open_subagent", { task: call.taskName }))}">${content}</button>`;
    return `<div class="subagent-call-moment${showAnchor ? "" : " is-inline"}" data-subagent-call-sequence="${call.sequence}"${Number.isFinite(call.elapsedAfterRequestMs) ? ` data-subagent-call-elapsed-ms="${call.elapsedAfterRequestMs}"` : ""}>${showAnchor ? anchor : ""}<span class="subagent-call-connector" aria-hidden="true"><i></i><b>↓</b></span>${event}</div>`;
  }

  function turnWithSubagentCallsHtml(turn, session, calls, labels) {
    const representativeId = turn.representative?.id || "";
    const items = [
      ...turn.assistants.map((message, index) => ({ kind: "message", message, index, timestamp: message.timestamp })),
      ...calls.map((call, index) => ({ kind: "call", call, index, timestamp: call.timestamp })),
    ].sort((left, right) => {
      const leftAt = Date.parse(left.timestamp || 0);
      const rightAt = Date.parse(right.timestamp || 0);
      if (leftAt !== rightAt) return leftAt - rightAt;
      if (left.kind !== right.kind) return left.kind === "message" ? -1 : 1;
      return left.index - right.index;
    });
    return items.map(item => {
      if (item.kind === "call") return subagentCallHtml(item.call, { showAnchor: false });
      const finalMessage = item.index === turn.assistants.length - 1
        || (representativeId && item.message.id === representativeId);
      return conversationRowHtml(item.message, session, {
        userLabel: labels.userLabel,
        assistantLabel: labels.assistantLabel,
        answerKind: finalMessage
          ? t(turn.live ? "drawer.current_progress" : turn.awaitingFinal ? "drawer.last_progress" : "drawer.final_answer")
          : "",
        live: turn.live && finalMessage,
      });
    }).join("");
  }

  function chatHtml(session, options = {}) {
    const overlay = conversationOverlay(session);
    session = overlay.session;
    const messages = session.messages || [];
    const allCalls = options.showSubagentCalls === false ? [] : subagentCallEvents(session);
    const context = session.context || {};
    const contextPercent = Math.max(0, Math.min(100, Number(context.percent || 0)));
    const contextValue = context.window
      ? `${fullNumber(context.used)} / ${fullNumber(context.window)}`
      : fullNumber(context.used);
    const contextHtml = `<section class="conversation-context-meter" data-conversation-context="${esc(session.id)}" style="--context-percent:${contextPercent}%">
      <div><span>${esc(t("session.live_context"))}</span><b>${esc(t("drawer.tokens", { count: contextValue }))}</b><small>${esc(session.model || t("session.model_unknown"))}</small></div>
      <div class="conversation-context-track" role="progressbar" aria-label="${esc(t("session.live_context"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${contextPercent}"><i></i></div>
      <strong>${context.window ? `${contextPercent.toFixed(1)}%` : t("session.context_size_unknown")}</strong>
    </section>`;
    if (!messages.length && !allCalls.length) return `${contextHtml}<div class="empty-state"><h3>${esc(t("drawer.no_conversation"))}</h3></div>`;
    const userLabel = options.userLabel || t("drawer.user");
    const assistantLabel = options.assistantLabel || providerInfo(session.provider).label;
    const conversationLabel = options.conversationLabel || t("drawer.conversation");
    const allTurns = conversationTurns(session, { ...options, forceLatestLive: overlay.forceLatestLive });
    const configuredTurnLimit = Number(state.conversationTurnLimits?.get(session.id) || INITIAL_CONVERSATION_TURNS);
    const turnLimit = Math.max(INITIAL_CONVERSATION_TURNS, configuredTurnLimit);
    const hiddenTurnCount = Math.max(0, allTurns.length - turnLimit);
    const turns = hiddenTurnCount ? allTurns.slice(hiddenTurnCount) : allTurns;
    const firstVisibleAt = Date.parse(turns[0]?.user?.timestamp || turns[0]?.representative?.timestamp || 0);
    const calls = hiddenTurnCount && Number.isFinite(firstVisibleAt)
      ? allCalls.filter(call => {
        const calledAt = Date.parse(call.timestamp || 0);
        return !Number.isFinite(calledAt) || calledAt >= firstVisibleAt;
      })
      : allCalls;
    const omitted = Number(session.omittedMessages || 0);
    const notice =
      omitted || session.truncated
        ? `<div class="chat-truncated">${esc(t("drawer.recent_history"))}${omitted ? ` · ${esc(t("drawer.messages_omitted", { count: omitted.toLocaleString(uiLocale()) }))}` : ""}</div>`
        : "";
    const rows = turns.map((turn, turnIndex) => {
      const user = conversationRowHtml(turn.user, session, { userLabel, assistantLabel });
      const turnStartedAt = Date.parse(turn.user?.timestamp || turn.representative?.timestamp || 0);
      const nextTurnTimestamp = turns[turnIndex + 1]?.user?.timestamp;
      const nextTurnStartedAt = nextTurnTimestamp ? Date.parse(nextTurnTimestamp) : Number.NaN;
      const turnCalls = calls.filter(call => {
        const calledAt = Date.parse(call.timestamp || 0);
        if (Number.isFinite(turnStartedAt) && calledAt < turnStartedAt) return false;
        return !Number.isFinite(nextTurnStartedAt) || calledAt < nextTurnStartedAt;
      });
      const timeline = turnWithSubagentCallsHtml(turn, session, turnCalls, { userLabel, assistantLabel });
      return `<section class="chat-turn${turn.live ? " is-live" : ""}" data-conversation-turn="${esc(turn.id)}">
        ${user}${timeline}
      </section>`;
    }).join("");
    const unmatchedCalls = calls.filter(call => !turns.some((turn, turnIndex) => {
      const startedAt = Date.parse(turn.user?.timestamp || turn.representative?.timestamp || 0);
      const nextTimestamp = turns[turnIndex + 1]?.user?.timestamp;
      const nextStartedAt = nextTimestamp ? Date.parse(nextTimestamp) : Number.NaN;
      const calledAt = Date.parse(call.timestamp || 0);
      return (!Number.isFinite(startedAt) || calledAt >= startedAt) && (!Number.isFinite(nextStartedAt) || calledAt < nextStartedAt);
    }));
    const callOnlyRows = unmatchedCalls.map(subagentCallHtml).join("");
    const emptyConversation = turns.length || calls.length ? "" : `<div class="empty-state compact"><h3>${esc(t("drawer.no_user_ai_conversation"))}</h3></div>`;
    const earlierTurns = hiddenTurnCount
      ? `<div class="chat-earlier-history"><button type="button" data-load-earlier-turns="${esc(session.id)}"
        data-next-turn-limit="${turnLimit + CONVERSATION_TURN_PAGE}">${esc(t("drawer.load_earlier_turns", {
          count: Math.min(hiddenTurnCount, CONVERSATION_TURN_PAGE).toLocaleString(uiLocale()),
        }))}</button><small>${esc(t("drawer.earlier_turns_remaining", { count: hiddenTurnCount.toLocaleString(uiLocale()) }))}</small></div>`
      : "";
    return `${contextHtml}${notice}<div class="chat-history-head">
      <span>${esc(t("drawer.turn_summary", { label: conversationLabel, count: allTurns.length, updates: "" }))}</span>
      <button type="button" data-scroll-latest>${esc(t("drawer.latest_conversation"))} ↓</button>
      </div>
      <div class="chat-list">${earlierTurns}${callOnlyRows}${rows}${emptyConversation}<div class="chat-latest-anchor" aria-label="${esc(t("drawer.latest_conversation"))}">
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
      <b>${esc(window.WhiteboxI18n.observedText(event.label))}</b>
      <span>${esc(window.WhiteboxI18n.observedText(event.detail || event.type))}</span>
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
    const wordPieces = value => esc(t("drawer.word_pieces", { count: fullNumber(value) }));
    return `<div class="token-hero" style="--drawer-provider:${providerInfo(session.provider).accent}">
      <div class="token-hero-head">
        <span>${esc(t("session.context_usage"))}</span>
        <b>${esc(t("drawer.tokens", { count: context.window ? `${fullNumber(context.used)} / ${fullNumber(context.window)}` : fullNumber(context.used) }))}</b>
        </div>
      <div class="big-context"><span style="width:${Math.min(100, context.percent || 0)}%"></span></div>
      <div class="context-scale">
        <span>${wordPieces(0)}</span><span>${(context.percent || 0).toFixed(1)}%</span>
        <span>${context.window ? esc(t("drawer.word_pieces", { count: compact(context.window) })) : "--"}</span>
      </div>
    </div>
    <div class="token-grid">
      <div class="token-tile"><span>${esc(t("drawer.input"))}</span><strong>${wordPieces(usage.input)}</strong><small>${esc(t("drawer.input_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.output"))}</span><strong>${wordPieces(usage.output)}</strong><small>${esc(t("drawer.output_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.cached"))}</span><strong>${wordPieces(usage.cachedInput)}</strong><small>${esc(t("drawer.cached_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.cache_write"))}</span><strong>${wordPieces(usage.cacheWrite)}</strong><small>${esc(t("drawer.cache_write_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.reasoning"))}</span><strong>${wordPieces(usage.reasoning)}</strong><small>${esc(t("drawer.reasoning_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.total"))}</span><strong>${wordPieces(usage.total)}</strong><small>${esc(t("drawer.total_help"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.last_input"))}</span><strong>${wordPieces(turn.input)}</strong><small>${esc(t("drawer.latest_turn"))}</small></div>
      <div class="token-tile"><span>${esc(t("drawer.last_total"))}</span><strong>${wordPieces(turn.total)}</strong><small>${esc(t("drawer.last_total_help"))}</small></div>
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
    const parent = session.parentId ? state.details.get(session.parentId) || snapshotSession(session.parentId) : null;
    const delegation = session.delegation || {};
    const startValue = delegation.startedAt || session.startedAt || "";
    const startedAt = startValue ? Date.parse(startValue) : Number.NaN;
    const normalizedText = value => String(value || "").replace(/\s+/g, " ").trim();
    const messageKey = message => `${message.role || ""}:${normalizedText(message.text)}`;
    const parentMessageIds = new Set((parent?.messages || []).map(message => String(message.id || "")).filter(Boolean));
    const parentMessageKeys = new Set((parent?.messages || []).map(messageKey));
    const messages = (session.messages || []).filter(message => {
      if (!message || !["user", "assistant"].includes(message.role) || message.protected || !normalizedText(message.text)) return false;
      const messageAt = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
      if (Number.isFinite(startedAt) && startedAt > 0 && Number.isFinite(messageAt) && messageAt < startedAt - 2000) return false;
      const inheritedId = message.id && parentMessageIds.has(String(message.id));
      const inheritedText = parentMessageKeys.has(messageKey(message));
      return !inheritedId && !inheritedText;
    });
    const existingKeys = new Set(messages.map(messageKey));
    for (const event of subagentCoordinationEvents(session)) {
      if (!["followup", "message"].includes(event.kind) || !normalizedText(event.text)) continue;
      const message = {
        id: `${session.id}:coordination:${event.id}`,
        role: "user",
        text: event.text,
        timestamp: event.timestamp || session.updatedAt,
        source: "coordination",
      };
      const key = messageKey(message);
      if (existingKeys.has(key)) continue;
      messages.push(message);
      existingKeys.add(key);
    }
    const hasConversation = messages.some((message) =>
      (message.role === "user" || message.role === "assistant") && String(message.text || "").trim(),
    );
    if (!hasConversation && delegation.assignmentObserved && !delegation.assignmentProtected && String(delegation.assignment || "").trim()) {
      const assignmentMessage = {
        id: `${session.id}:delegation`, role: "user", text: delegation.assignment,
        timestamp: delegation.startedAt || session.startedAt || session.updatedAt,
      };
      messages.push(assignmentMessage);
      existingKeys.add(messageKey(assignmentMessage));
    }
    const result = String(session.result || delegation.result || "").trim();
    const resultMessage = {
      id: `${session.id}:result`, role: "assistant", text: result,
      timestamp: session.completedAt || delegation.completedAt || session.updatedAt,
    };
    if (result && !existingKeys.has(messageKey(resultMessage))) {
      messages.push(resultMessage);
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
          <header><b>${esc(window.WhiteboxI18n.observedText(event.label || event.kind))}</b><span>${esc(label)} · ${esc(timeOnly(event.timestamp))}</span></header>
          <div class="chat-content plain subagent-message-preview${preview.truncated ? " is-truncated" : ""}"
            data-subagent-message-preview data-truncated="${preview.truncated ? "true" : "false"}"><p>${esc(preview.text)}</p></div>
        </article>`;
      })
      .join("");
    return `<details class="chat-activities subagent-coordination" data-subagent-coordination-count="${events.length}" data-disclosure-key="${esc(`drawer:${session.id}:coordination`)}">
      <summary>${esc(t("drawer.coordination_events", { count: events.length }))}</summary><div>${rows}</div>
    </details>`;
  }

  function subagentConversationHtml(session) {
    const delegation = session.delegation || {};
    const parent = session.parentId ? state.details.get(session.parentId) || snapshotSession(session.parentId) : null;
    const assignmentEvent = subagentCoordinationEvents(session).find(event => event.kind === "assignment" && String(event.text || "").trim());
    const delegatedAssignment = delegation.assignmentObserved && String(delegation.assignment || "").trim()
      ? delegation.assignment
      : "";
    const eventAssignment = assignmentEvent && !assignmentEvent.protected ? assignmentEvent.text : "";
    const assignment = String(delegatedAssignment || eventAssignment || "").trim();
    const assignmentSource = delegation.assignmentSource === "claude-agent-prompt"
      ? t("drawer.assignment_source_claude")
      : delegation.assignmentSource === "spawn-message"
        ? t("drawer.assignment_source_codex")
        : "";
    let assignmentRemoved = false;
    const messages = subagentWorkMessages(session).filter(message => {
      if (assignmentRemoved || message.role !== "user" || !assignment) return true;
      if (String(message.text || "").replace(/\s+/g, " ").trim() !== assignment.replace(/\s+/g, " ").trim()) return true;
      assignmentRemoved = true;
      return false;
    });
    const conversationCount = messages.filter((message) => message.role === "user" || message.role === "assistant").length;
    const workSession = { ...session, messages };
    const sourceCopy = session.source === "collaboration-history"
      ? t("drawer.subagent_history_reconstructed")
      : t("drawer.subagent_history_actual");
    const assignmentCard = assignment
      ? `<section class="subagent-assignment-card" data-subagent-assignment="true">
        <span aria-hidden="true">⌁</span><div><b>${esc(t("control.main_assignment"))}</b>${parent ? `<small>${esc(t("control.created_from"))} · ${esc(parent.title)}</small>` : ""}${assignmentSource ? `<small>${esc(assignmentSource)}</small>` : ""}<p>${esc(assignment)}</p></div>
      </section>`
      : "";
    return `${assignmentCard}<section class="subagent-work-source" data-subagent-work-messages="${conversationCount}" data-conversation-scope="subagent-only">
      <b>${esc(t("control.subagent_conversation"))}</b><span>${esc(sourceCopy)}</span>
    </section>${chatHtml(workSession, {
      userLabel: t("drawer.user"),
      assistantLabel: session.agentName || t("drawer.sub_ai"),
      conversationLabel: t("drawer.work_history"),
      synthesizeRequest: false,
    })}${subagentCoordinationHtml(session)}`;
  }

  function executionActivityDetailHtml(session, activity) {
    if (!activity) return `<div class="empty-state"><h3>${esc(t("drawer.execution_unavailable"))}</h3></div>`;
    const purpose = inferredExecutionSummary(activity);
    const ownerGoal = controlRoomAgentGoal(session, 180);
    const runtime = activity.runtime || activity.tool || t("graph.runtime_unknown");
    const handle = activity.backgroundId
      ? `${activity.backgroundIdType || t("graph.execution_handle")} · ${activity.backgroundId}`
      : "";
    const command = String(activity.command || activity.label || purpose.full || "").trim();
    const output = String(activity.output || "").trim();
    const status = executionActivityStatus(activity);
    const ownerLabel = session.parentId
      ? `${t("control.subagent")} · ${session.agentName || session.taskName || providerInfo(session.provider).label}`
      : `${t("control.main_agent")} · ${session.agentName || providerInfo(session.provider).label}`;
    const timeline = [
      activity.startedAt ? { label: t("drawer.execution_started"), value: activity.startedAt } : null,
      activity.updatedAt ? {
        label: activity.status === "running" || activity.status === "unverified"
          ? t("drawer.execution_latest_activity")
          : t("drawer.execution_finished"),
        value: activity.updatedAt,
      } : null,
    ].filter(Boolean);
    return `<div class="execution-drawer" data-execution-detail="${esc(activity.id)}" data-conversation-scope="execution-only">
      <section class="execution-purpose-card">
        <span class="execution-purpose-icon" aria-hidden="true">${activity.kind === "shell" ? "›_" : "◌"}</span>
        <div><small>${esc(t("drawer.execution_purpose"))}</small><b>${esc(purpose.text)}</b><p>${esc(t("drawer.execution_owner_context", { owner: ownerLabel, task: ownerGoal.text }))}</p></div>
      </section>
      <section class="execution-process-card">
        <header><span><small>${esc(executionActivityLabel(activity))}</small><b>${esc(status)}</b></span><em class="${activity.status === "running" ? "is-running" : ""}"><i aria-hidden="true"></i>${esc(activity.statusDetail || status)}</em></header>
        <dl>
          <div><dt>${esc(t("graph.execution_runtime"))}</dt><dd>${esc(runtime)}</dd></div>
          ${activity.cwd ? `<div><dt>${esc(t("graph.execution_workdir"))}</dt><dd title="${esc(activity.cwd)}">${esc(activity.cwd)}</dd></div>` : ""}
          ${handle ? `<div><dt>${esc(t("graph.execution_handle"))}</dt><dd>${esc(handle)}</dd></div>` : ""}
          ${activity.exitCode != null ? `<div><dt>${esc(t("drawer.execution_exit_code"))}</dt><dd>${esc(Number(activity.exitCode) === 0 ? t("drawer.execution_exit_success") : t("drawer.execution_exit_failure", { code: activity.exitCode }))}</dd></div>` : ""}
        </dl>
      </section>
      <section class="execution-code-card">
        <header><span><small>${esc(t("drawer.execution_command_from", { owner: ownerLabel }))}</small><b>${esc(t("graph.execution_command"))}</b></span>${command ? `<button type="button" data-copy-text="${esc(command)}">${esc(t("graph.copy_command"))}</button>` : ""}</header>
        ${command ? `<pre><code>${esc(command)}</code></pre>` : `<p>${esc(t("drawer.execution_command_unavailable"))}</p>`}
      </section>
      <section class="execution-code-card output-card">
        <header><span><small>${esc(t("drawer.execution_output_help"))}</small><b>${esc(t("graph.execution_output"))}</b></span>${output ? `<button type="button" data-copy-text="${esc(output)}">${esc(t("graph.copy_output"))}</button>` : ""}</header>
        ${output ? `<pre>${esc(output)}</pre>` : `<p>${esc(activity.status === "running" ? t("drawer.execution_waiting_output") : t("graph.execution_output_unavailable"))}</p>`}
      </section>
      ${timeline.length ? `<section class="execution-timeline" aria-label="${esc(t("drawer.execution_timeline"))}">${timeline.map((item, index) => `<div><i aria-hidden="true"></i><span><b>${esc(item.label)}</b><time title="${esc(item.value)}">${esc(new Date(item.value).toLocaleString(uiLocale()))}</time></span>${index === timeline.length - 1 && activity.status === "running" ? `<em>${esc(t("graph.execution_running"))}</em>` : ""}</div>`).join("")}</section>` : ""}
    </div>`;
  }

  return {
    conversationTurns, chatHtml, lifecycleHtml, tokensHtml,
    subagentCommunicationEvents, subagentCoordinationEvents, subagentWorkMessages,
    subagentTextPreview, subagentConversationHtml, executionActivityDetailHtml,
  };
};
