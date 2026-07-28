'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function registerTerminalComposerTests(context) {
  const { test, root } = context;

  test('AI 터미널 composer가 provider별 슬래시 명령과 긴 입력 기준을 구분한다', () => {
    const source = fs.readFileSync(path.join(root, 'renderer', 'terminal-composer.js'), 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox, { filename: 'terminal-composer.js' });
    const composer = sandbox.window.LoadToAgentTerminalComposer;
    const values = provider => Array.from(composer.commandsForProvider(provider), command => command.value);

    assert.deepStrictEqual(values('codex'), ['/model', '/status', '/compact', '/review', '/diff', '/new']);
    assert.deepStrictEqual(values('claude'), ['/model', '/status', '/compact', '/context', '/help', '/clear']);
    assert.deepStrictEqual(values('unknown'), ['/model', '/status', '/compact']);
    assert.equal(composer.slashQuery('/sta', 4), 'sta');
    assert.equal(composer.slashQuery('/status now', 11), null);
    assert.equal(composer.slashQuery('echo /status', 12), null);
    assert.deepStrictEqual(
      Array.from(composer.filterCommands('codex', 're'), command => command.value),
      ['/review'],
    );
    assert.equal(composer.isLongDraft('a'.repeat(559), 100), false);
    assert.equal(composer.isLongDraft('a'.repeat(560), 100), true);
    assert.equal(composer.isLongDraft('1\n2\n3\n4\n5\n6\n7', 100), true);
    assert.equal(composer.isLongDraft('short', 169), true);
  });
}

module.exports = { registerTerminalComposerTests };
