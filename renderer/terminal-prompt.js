(function exposeTerminalPromptParser(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LoadToAgentTerminalPrompts = api;
})(typeof window !== 'undefined' ? window : globalThis, function createTerminalPromptParser() {
  'use strict';

  function stripTerminalControls(value) {
    return String(value || '')
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[@-_]/g, '')
      .replace(/\r/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  function compactEditedTarget(value) {
    return String(value || '')
      .replace(/([/\\-])\s*\n\s*/g, '$1')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[─━═]{3,}/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s›>*-]+/, '')
      .trim()
      .slice(0, 520);
  }

  function detectCodexEditApproval(value) {
    const text = stripTerminalControls(value);
    const question = 'Would you like to make the following edits?';
    const start = text.toLowerCase().lastIndexOf(question.toLowerCase());
    if (start < 0 || text.length - start > 6_000) return null;
    const choiceBlock = text.slice(start, start + 1_800);
    if (!/Yes,\s*proceed\s*\(y\)/i.test(choiceBlock)
      || !/don't\s+ask\s+again[\s\S]{0,120}\(a\)/i.test(choiceBlock)
      || !/tell\s+Codex\s+what\s+to\s+do\s+differently[\s\S]{0,120}\(esc\)/i.test(choiceBlock)) return null;
    const before = text.slice(Math.max(0, start - 1_600), start);
    const editedAt = before.toLowerCase().lastIndexOf('edited ');
    const target = compactEditedTarget(editedAt >= 0 ? before.slice(editedAt + 'edited '.length) : '');
    const fingerprint = `codex-edit:${target || choiceBlock.replace(/\s+/g, ' ').slice(0, 280)}`;
    return {
      kind: 'codex-edit-approval',
      fingerprint,
      title: '파일 수정 승인',
      question: 'AI가 요청한 파일 수정을 적용할까요?',
      detail: target || '수정할 파일과 변경 내용을 확인한 뒤 진행 방법을 선택하세요.',
      choices: [
        { id: 'proceed', label: '이번 수정 진행', key: 'y', tone: 'approve' },
        { id: 'always', label: '이 파일은 다시 묻지 않고 진행', key: 'a', tone: 'remember' },
        { id: 'reject', label: '거절하고 수정 방향 입력', key: 'Escape', tone: 'reject', requiresText: true },
      ],
    };
  }

  function detectPendingPrompt(value) {
    return detectCodexEditApproval(value);
  }

  function normalizePromptResolution(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const sessionId = String(raw.sessionId || '').trim().slice(0, 512);
    const terminalId = String(raw.terminalId || '').trim().slice(0, 512);
    const targetId = String(raw.targetId || '').trim().slice(0, 512);
    const fingerprint = String(raw.fingerprint || '').trim().slice(0, 1_000);
    if (!sessionId || !terminalId || !targetId || targetId !== terminalId || !fingerprint) return null;
    return {
      sessionId,
      terminalId,
      targetId,
      fingerprint,
      choiceId: String(raw.choiceId || '').trim().slice(0, 120),
      requiresText: raw.requiresText === true,
    };
  }

  function applyPromptResolution(pendingPrompts, promptDismissals, value) {
    const resolution = normalizePromptResolution(value);
    if (!resolution || !(pendingPrompts instanceof Map) || !(promptDismissals instanceof Map)) {
      return { ok: false, changed: false, requiresText: false };
    }
    const pending = pendingPrompts.get(resolution.sessionId) || null;
    const matches = Boolean(pending
      && String(pending.fingerprint || '') === resolution.fingerprint
      && String(pending.target?.id || '') === resolution.targetId
      && String(pending.target?.terminalId || '') === resolution.terminalId);
    promptDismissals.set(resolution.targetId, resolution.fingerprint);
    if (matches) pendingPrompts.delete(resolution.sessionId);
    return { ok: true, changed: matches, ...resolution };
  }

  function reconcilePromptDismissals(promptDismissals, observedTargets) {
    if (!(promptDismissals instanceof Map) || !(observedTargets instanceof Map)) return 0;
    let removed = 0;
    for (const [targetId, fingerprint] of [...promptDismissals]) {
      if (!observedTargets.has(targetId)) continue;
      if (observedTargets.get(targetId) === fingerprint) continue;
      promptDismissals.delete(targetId);
      removed += 1;
    }
    return removed;
  }

  return {
    applyPromptResolution,
    detectCodexEditApproval,
    detectPendingPrompt,
    normalizePromptResolution,
    reconcilePromptDismissals,
    stripTerminalControls,
  };
});
