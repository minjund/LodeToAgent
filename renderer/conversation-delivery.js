"use strict";

(function exposeConversationDelivery(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LoadToAgentConversationDelivery = api;
})(typeof window === "object" ? window : null, function createConversationDelivery() {
  // Claude startup hooks can delay the provider log by tens of seconds even
  // though the prompt was already handed to the CLI. Avoid turning normal
  // startup latency into an alarming false "unreceived" state.
  const CONFIRMATION_DELAY_MS = 60_000;

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function messageKey(message) {
    const id = String(message?.id || "").trim();
    if (id) return `id:${id}`;
    return `${message?.role || ""}:${normalizedText(message?.text)}:${message?.timestamp || ""}`;
  }

  function newMessagesForEntry(session, entry) {
    const baseline = entry?.baselineMessageKeys instanceof Set
      ? entry.baselineMessageKeys
      : new Set(entry?.baselineMessageKeys || []);
    return (session?.messages || []).filter(message => !baseline.has(messageKey(message)));
  }

  function observedAtOrAfter(message, minimumAt) {
    if (!Number.isFinite(minimumAt)) return true;
    const observedAt = Date.parse(message?.timestamp || 0);
    return Number.isFinite(observedAt) && observedAt >= minimumAt;
  }

  function deliveryState(session, entry, now = Date.now()) {
    if (!entry) return null;
    const expectedText = normalizedText(entry.text);
    const dispatchedAt = Date.parse(entry.dispatchedAt || entry.timestamp || 0);
    const elapsedMs = Number.isFinite(dispatchedAt) ? Math.max(0, Number(now) - dispatchedAt) : 0;
    // Claude can continue a terminal-resumed conversation in a new session
    // file. The renderer supplies same-project observation sessions so receipt
    // confirmation follows the actual log instead of remaining pinned to the
    // session id that launched the terminal.
    const observationSessions = Array.isArray(session?.deliveryObservationSessions)
      ? session.deliveryObservationSessions
      : [session];
    const minimumObservedAt = Number.isFinite(dispatchedAt) ? dispatchedAt - 2_000 : Number.NaN;
    let observedSession = null;
    let observedMessages = [];
    let userMessage = null;
    for (const candidate of observationSessions) {
      const candidateMessages = newMessagesForEntry(candidate, entry);
      const matched = candidateMessages.find(message =>
        message?.role === "user"
        && normalizedText(message.text) === expectedText
        && observedAtOrAfter(message, minimumObservedAt)) || null;
      if (!matched) continue;
      observedSession = candidate;
      observedMessages = candidateMessages;
      userMessage = matched;
      break;
    }
    const userObservedAt = Date.parse(userMessage?.timestamp || 0);
    const assistantMessage = userMessage
      ? observedMessages.find(message =>
        message?.role === "assistant"
        && normalizedText(message.text)
        && observedAtOrAfter(message, Number.isFinite(userObservedAt) ? userObservedAt : minimumObservedAt)) || null
      : null;
    const responseStartEvent = userMessage
      ? (observedSession?.lifecycle || []).find(event => {
        const eventAt = Date.parse(event?.timestamp || 0);
        return Number.isFinite(eventAt)
          && (!Number.isFinite(userObservedAt) || eventAt >= userObservedAt)
          && event?.status === "running"
          && /start|turn|run/i.test(String(event?.type || event?.label || ""));
      }) || null
      : null;

    let phase = "confirming";
    // Provider transcripts are the authoritative delivery evidence. A lost
    // terminal acknowledgement must not permanently override an observed turn.
    if (assistantMessage) phase = "responded";
    else if (userMessage && responseStartEvent) phase = "responding";
    else if (userMessage) phase = "received";
    else if (entry.status === "interrupted") phase = "interrupted";
    else if (entry.status === "uncertain") phase = "uncertain";
    else if (entry.status === "failed") phase = "failed";
    else if (entry.status === "sending") phase = "sending";
    else if (elapsedMs >= CONFIRMATION_DELAY_MS) phase = "delayed";

    return {
      phase,
      elapsedMs,
      userMessage,
      assistantMessage,
      responseStartEvent,
      observationSessionId: observedSession?.id || null,
      receivedAt: userMessage?.timestamp || null,
      responseObservedAt: assistantMessage?.timestamp || responseStartEvent?.timestamp || null,
    };
  }

  return {
    CONFIRMATION_DELAY_MS,
    normalizedText,
    messageKey,
    newMessagesForEntry,
    deliveryState,
  };
});
