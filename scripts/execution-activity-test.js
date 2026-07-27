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
  assert.equal(activity.runtime, 'PowerShell');
}

{
  const { activity } = activityFor(
    "Get-Process LoadToAgent -ErrorAction SilentlyContinue | Select-Object Id,Path",
  );
  assert.equal(activity.runtime, 'PowerShell');
}

{
  const { activity } = activityFor("node -e 'console.log(\"ok\")'");
  assert.equal(activity.runtime, 'Shell');
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
  assert.equal(unobserved.statusDetail, '최근 실행 신호 없음');
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

process.stdout.write('실행 작업 감지 테스트 6개 통과\n');
