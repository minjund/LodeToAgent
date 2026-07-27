"use strict";

const assert = require("assert");
const {
  CONFIRMATION_DELAY_MS,
  messageKey,
  deliveryState,
} = require("../../renderer/conversation-delivery");

function registerConversationDeliveryTests(context) {
  const { test } = context;

  test("대화 전송 상태는 요청·수신·실행·응답의 실제 관측 신호를 구분한다", () => {
    const sentAt = "2026-07-24T01:00:00.000Z";
    const oldMessages = [
      { id: "old-user", role: "user", text: "이전 요청", timestamp: "2026-07-24T00:59:00.000Z" },
      { id: "old-answer", role: "assistant", text: "이전 답변", timestamp: "2026-07-24T00:59:30.000Z" },
    ];
    const entry = {
      text: "새 요청",
      timestamp: sentAt,
      status: "sending",
      baselineMessageKeys: new Set(oldMessages.map(messageKey)),
    };
    const session = {
      status: "running",
      messages: oldMessages,
      lifecycle: [{ type: "turn-start", status: "running", timestamp: "2026-07-24T00:59:00.000Z" }],
    };

    assert.equal(deliveryState(session, entry, Date.parse(sentAt)).phase, "sending");

    entry.status = "awaiting";
    entry.dispatchedAt = sentAt;
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 5_000).phase, "confirming");
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + CONFIRMATION_DELAY_MS).phase, "delayed");

    session.messages = [
      ...oldMessages,
      { id: "new-user", role: "user", text: "새 요청", timestamp: "2026-07-24T01:00:13.000Z" },
    ];
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 13_000).phase, "received",
      "이전 턴의 실행 상태만으로 새 메시지에 응답 중이라고 표시하면 안 됩니다.");

    session.lifecycle.push({ type: "turn-start", status: "running", timestamp: "2026-07-24T01:00:14.000Z" });
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 14_000).phase, "responding");

    session.messages.push({ id: "new-answer", role: "assistant", text: "응답 시작", timestamp: "2026-07-24T01:00:15.000Z" });
    assert.equal(deliveryState(session, entry, Date.parse(sentAt) + 15_000).phase, "responded");

    const failed = { ...entry, status: "failed" };
    assert.equal(deliveryState({ ...session, messages: oldMessages }, failed, Date.parse(sentAt) + 1_000).phase, "failed");
    const interrupted = { ...entry, status: "interrupted" };
    assert.equal(
      deliveryState({ ...session, messages: oldMessages }, interrupted, Date.parse(sentAt) + 1_000).phase,
      "interrupted",
    );
  });

  test("Claude 터미널 재개가 새 세션 로그를 만들면 같은 프로젝트의 후속 로그에서 수신을 확인한다", () => {
    const sentAt = "2026-07-27T01:00:00.000Z";
    const entry = {
      text: "터미널로 보낸 요청",
      timestamp: sentAt,
      dispatchedAt: sentAt,
      status: "awaiting",
      baselineMessageKeys: new Set(),
    };
    const original = {
      id: "claude:original",
      messages: [{ id: "old", role: "assistant", text: "이전 답변", timestamp: "2026-07-27T00:59:00.000Z" }],
      lifecycle: [],
    };
    const resumed = {
      id: "claude:resumed",
      messages: [
        { id: "resumed-user", role: "user", text: "터미널로 보낸 요청", timestamp: "2026-07-27T01:00:02.000Z" },
      ],
      lifecycle: [],
    };
    const observed = { ...original, deliveryObservationSessions: [original, resumed] };

    const received = deliveryState(observed, entry, Date.parse(sentAt) + 3_000);
    assert.equal(received.phase, "received");
    assert.equal(received.observationSessionId, "claude:resumed");

    resumed.messages.push({
      id: "resumed-answer",
      role: "assistant",
      text: "응답을 시작했습니다.",
      timestamp: "2026-07-27T01:00:04.000Z",
    });
    assert.equal(deliveryState(observed, entry, Date.parse(sentAt) + 5_000).phase, "responded");
  });

  test("다른 Claude 로그의 전송 이전 동일 문구는 새 수신으로 오인하지 않는다", () => {
    const sentAt = "2026-07-27T01:00:00.000Z";
    const entry = {
      text: "반복 요청",
      timestamp: sentAt,
      dispatchedAt: sentAt,
      status: "awaiting",
      baselineMessageKeys: new Set(),
    };
    const original = { id: "claude:original", messages: [], lifecycle: [] };
    const oldRelated = {
      id: "claude:old-related",
      messages: [
        { id: "old-repeat", role: "user", text: "반복 요청", timestamp: "2026-07-27T00:59:00.000Z" },
        { id: "old-answer", role: "assistant", text: "이전 응답", timestamp: "2026-07-27T00:59:10.000Z" },
      ],
      lifecycle: [],
    };
    const observed = { ...original, deliveryObservationSessions: [original, oldRelated] };
    assert.equal(deliveryState(observed, entry, Date.parse(sentAt) + 5_000).phase, "confirming");
  });
}

module.exports = { registerConversationDeliveryTests };
