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
const { registerSessionIntelligenceTests } = require('./tests/session-intelligence');
const { registerConversationDeliveryTests } = require('./tests/conversation-delivery');
const { registerTerminalAgentActionTests } = require('./tests/terminal-agent-actions');
const { registerTerminalComposerTests } = require('./tests/terminal-composer');
const { registerTerminalInteractionTests } = require('./tests/terminal-interactions');
const { registerInlineAgentTerminalTests } = require('./tests/inline-agent-terminal');
const { registerTerminalPromptTests } = require('./tests/terminal-prompts');
const { registerAgentRunnerLifecycleTests } = require('./tests/agent-runner-lifecycle');
const { registerUpdateDownloadLimitTests } = require('./tests/update-download-limits');
const { registerTmuxControlProxyLifecycleTests } = require('./tests/tmux-control-proxy-lifecycle');
const { registerTerminalBoundConversationTests } = require('./tests/terminal-bound-conversation');
const { registerBridgeBackpressureTests } = require('./tests/bridge-backpressure');
const { registerProjectPtyPreconnectTests } = require('./tests/project-pty-preconnect');
const { registerAttentionPopupManagerTests } = require('./tests/attention-popup-manager');
const { registerAttentionActivationTests } = require('./tests/attention-activation');
const { registerAttentionHookTests } = require('./tests/attention-hook');
const { registerStructuredInputRequestTests } = require('./tests/structured-input-request');
const { registerSourcePluginTests } = require('./tests/source-plugins');
const { registerCodexSharedAppServerTests } = require('./tests/codex-shared-app-server');
const { registerBrandMigrationTests } = require('./tests/brand-migration');

const root = path.resolve(__dirname, '..');
const fixtures = createRegressionFixtures(root);
const harness = createTestHarness();
const context = { ...fixtures, test: harness.test };

registerCoreUpdateWorkspaceTests(context);
registerAttentionNotifierTests(context);
registerAutomationMonitorTests(context);
registerSessionIntelligenceTests(context);
registerConversationDeliveryTests(context);
registerTerminalAgentActionTests(context);
registerTerminalComposerTests(context);
registerTerminalInteractionTests(context);
registerInlineAgentTerminalTests(context);
registerTerminalPromptTests(context);
registerAgentRunnerLifecycleTests(context);
registerUpdateDownloadLimitTests(context);
registerTmuxControlProxyLifecycleTests(context);
registerTerminalBoundConversationTests(context);
registerBridgeBackpressureTests(context);
registerProjectPtyPreconnectTests(context);
registerAttentionPopupManagerTests(context);
registerAttentionActivationTests(context);
registerAttentionHookTests(context);
registerStructuredInputRequestTests(context);
registerSourcePluginTests(context);
registerCodexSharedAppServerTests(context);
registerBrandMigrationTests(context);
registerAgentParserTests(context);
registerRuntimeTerminalBridgeTests(context);
registerUiContractSuite(context);

if (harness.count() !== 361) {
  throw new Error(`회귀 테스트 등록 수가 361개가 아닙니다: ${harness.count()}`);
}

harness.run({ cleanup: fixtures.cleanup }).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
