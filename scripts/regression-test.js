'use strict';

const path = require('path');
const { registerAgentParserTests } = require('./tests/agent-parsers');
const { registerCoreUpdateWorkspaceTests } = require('./tests/core-update-workspace');
const { createRegressionFixtures } = require('./tests/fixtures');
const { createTestHarness } = require('./tests/harness');
const { registerRuntimeTerminalBridgeTests } = require('./tests/runtimes-terminal-bridge');
const { registerUiContractSuite } = require('./tests/ui-contracts');
const { registerAttentionNotifierTests } = require('./tests/attention-notifier');
const { registerAutomationMonitorTests } = require('./tests/automation-monitor');

const root = path.resolve(__dirname, '..');
const fixtures = createRegressionFixtures(root);
const harness = createTestHarness();
const context = { ...fixtures, test: harness.test };

registerCoreUpdateWorkspaceTests(context);
registerAttentionNotifierTests(context);
registerAutomationMonitorTests(context);
registerAgentParserTests(context);
registerRuntimeTerminalBridgeTests(context);
registerUiContractSuite(context);

if (harness.count() !== 59) {
  throw new Error(`회귀 테스트 등록 수가 59개가 아닙니다: ${harness.count()}`);
}

harness.run({ cleanup: fixtures.cleanup }).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
