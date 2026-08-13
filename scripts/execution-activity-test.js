'use strict';

const assert = require('assert');
const {
  createExecutionTracker,
  reconcileExecutionActivities,
} = require('../src/agentMonitor/executionActivity');

function activityFor(command, options = {}) {
  const tracker = createExecutionTracker({
    compactText: value => String(value || ''),
    timestamp: value => value || null,
  });
  tracker.recordCall({
    name: options.name || 'shell_command',
    callId: options.callId || 'call-1',
    args: {
      command,
      sandbox_permissions: options.sandboxPermissions,
    },
    at: options.at || '2026-07-27T00:00:00.000Z',
  });
  return { tracker, activity: tracker.activities[0] };
}

{
  const { activity } = activityFor(
    "$exe = Resolve-Path '.\\LoadToAgent.exe'; Start-Process -FilePath $exe -PassThru",
  );
  assert.equal(activity.runtime, 'Windows 명령창');
}

{
  const { activity } = activityFor(
    "Get-Process LoadToAgent -ErrorAction SilentlyContinue | Select-Object Id,Path",
  );
  assert.equal(activity.runtime, 'Windows 명령창');
}

{
  const { activity } = activityFor("node -e 'console.log(\"ok\")'");
  assert.equal(activity.runtime, '명령창');
}

{
  const { tracker, activity } = activityFor(
    "$launch = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -PassThru",
    { sandboxPermissions: 'require_escalated' },
  );
  assert.equal(activity.approvalRequired, true);
  const [expired] = reconcileExecutionActivities(tracker.finalize(), {
    now: Date.parse('2026-07-27T00:10:00.000Z'),
    staleAfterMs: 5 * 60_000,
  });
  assert.equal(expired.status, 'cancelled');
  assert.equal(expired.statusDetail, '권한 승인 요청 만료');
  assert.equal(expired.completedAt, activity.updatedAt);
}

{
  const { tracker } = activityFor('npm test');
  const [unobserved] = reconcileExecutionActivities(tracker.finalize(), {
    now: Date.parse('2026-07-27T00:10:00.000Z'),
    staleAfterMs: 5 * 60_000,
  });
  assert.equal(unobserved.status, 'unverified');
  assert.equal(unobserved.statusDetail, '최근 실행 활동이 확인되지 않음');
}

{
  const { tracker, activity } = activityFor(
    'Start-Process notepad.exe',
    { sandboxPermissions: 'require_escalated' },
  );
  tracker.recordOutput({
    name: 'shell_command',
    callId: activity.callId,
    output: 'Process launched\nexit code: 0',
    at: '2026-07-27T00:00:01.000Z',
  });
  assert.equal(activity.status, 'completed');
  assert.equal(activity.exitCode, 0);
}

{
  const { tracker, activity } = activityFor('npm run watch', { callId: 'long-running' });
  for (let index = 0; index < 125; index += 1) {
    const callId = `completed-${index}`;
    tracker.recordCall({
      name: 'shell_command', callId, args: { command: `echo ${index}` },
      at: `2026-07-27T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
    });
    tracker.recordOutput({
      name: 'shell_command', callId, output: 'exit code: 0',
      at: `2026-07-27T00:02:${String(index % 60).padStart(2, '0')}.000Z`,
    });
  }
  const projected = tracker.finalize(120);
  assert.equal(projected.some(item => item.id === activity.id && item.status === 'running'), true);
}

process.stdout.write('실행 작업 감지 테스트 7개 통과\n');
