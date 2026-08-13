'use strict';

const assert = require('assert');
const {
  applyPromptResolution,
  detectPendingPrompt,
  reconcilePromptDismissals,
} = require('../../renderer/terminal-prompt');

function registerTerminalPromptTests({ test }) {
  test('Codex 파일 수정 승인 화면을 선택 가능한 세 가지 동작으로 감지한다', () => {
    const prompt = detectPendingPrompt(`\u001b[2J
 Edited .planning/loops/order-live-verify/
research/p3-task2-report.md → /mnt/d/approval-loop-
worktrees/cras-backend/order-live-orch/order-
live-verify/.planning/loops/order-live-verify/
research/p3-task2-report.md (+0 -0)

 Would you like to make the following edits?

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files
     (a)
  3. No, and tell Codex what to do differently
     (esc)`);

    assert.ok(prompt);
    assert.equal(prompt.kind, 'codex-edit-approval');
    assert.match(prompt.detail, /p3-task2-report\.md/);
    assert.deepEqual(prompt.choices.map(choice => [choice.id, choice.key]), [
      ['proceed', 'y'],
      ['always', 'a'],
      ['reject', 'Escape'],
    ]);
  });

  test('과거 터미널 기록에만 남은 파일 승인 문구는 활성 요청으로 감지하지 않는다', () => {
    const prompt = detectPendingPrompt(`Would you like to make the following edits?
1. Yes, proceed (y)
2. Yes, and don't ask again for these files (a)
3. No, and tell Codex what to do differently (esc)
${'작업을 계속 진행해 완료했습니다. '.repeat(400)}`);
    assert.equal(prompt, null);
  });

  test('팝업에서 처리한 정확한 터미널 요청은 대시보드 대기 상태와 재전송 경로에서 함께 제거한다', () => {
    const pendingPrompts = new Map([
      ['session-a', {
        fingerprint: 'codex-edit:src/a.js',
        target: { id: 'terminal-a', terminalId: 'terminal-a' },
      }],
      ['session-b', {
        fingerprint: 'codex-edit:src/b.js',
        target: { id: 'terminal-b', terminalId: 'terminal-b' },
      }],
    ]);
    const dismissals = new Map();
    const result = applyPromptResolution(pendingPrompts, dismissals, {
      sessionId: 'session-a',
      terminalId: 'terminal-a',
      targetId: 'terminal-a',
      fingerprint: 'codex-edit:src/a.js',
      choiceId: 'reject',
      requiresText: true,
    });

    assert.deepEqual(result, {
      ok: true,
      changed: true,
      sessionId: 'session-a',
      terminalId: 'terminal-a',
      targetId: 'terminal-a',
      fingerprint: 'codex-edit:src/a.js',
      choiceId: 'reject',
      requiresText: true,
    });
    assert.equal(pendingPrompts.has('session-a'), false);
    assert.equal(pendingPrompts.has('session-b'), true, '다른 세션의 요청은 유지해야 합니다.');
    assert.equal(dismissals.get('terminal-a'), 'codex-edit:src/a.js');
  });

  test('해결 tombstone은 같은 출력이 남아 있는 동안만 유지되고 새 prompt lifecycle 전에 정리된다', () => {
    const pendingPrompts = new Map([
      ['session-a', {
        fingerprint: 'codex-edit:src/new.js',
        target: { id: 'terminal-a', terminalId: 'terminal-a' },
      }],
    ]);
    const dismissals = new Map();
    const stale = applyPromptResolution(pendingPrompts, dismissals, {
      sessionId: 'session-a',
      terminalId: 'terminal-a',
      targetId: 'terminal-a',
      fingerprint: 'codex-edit:src/old.js',
    });
    assert.equal(stale.changed, false, '이전 응답 이벤트가 새 요청을 지우면 안 됩니다.');
    assert.equal(pendingPrompts.has('session-a'), true);
    assert.equal(reconcilePromptDismissals(dismissals, new Map([
      ['terminal-a', 'codex-edit:src/old.js'],
    ])), 0, '같은 승인 화면이 replay에 남아 있으면 재노출을 막아야 합니다.');
    assert.equal(reconcilePromptDismissals(dismissals, new Map()), 0, '일시적으로 읽지 못한 target의 tombstone을 지우면 안 됩니다.');
    assert.equal(reconcilePromptDismissals(dismissals, new Map([
      ['terminal-a', 'codex-edit:src/new.js'],
    ])), 1, '새 fingerprint가 관측되면 이전 tombstone을 제거해야 합니다.');
    assert.equal(dismissals.size, 0);
  });
}

module.exports = { registerTerminalPromptTests };
