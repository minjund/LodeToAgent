'use strict';

const assert = require('assert');
const { detectPendingPrompt } = require('../../renderer/terminal-prompt');

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
}

module.exports = { registerTerminalPromptTests };
