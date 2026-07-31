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

  return {
    detectCodexEditApproval,
    detectPendingPrompt,
    stripTerminalControls,
  };
});
