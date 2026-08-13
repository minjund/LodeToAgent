'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createImeSubmit(root) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'ime-submit.js'), 'utf8');
  const sandbox = { window: {}, setTimeout, clearTimeout };
  vm.runInNewContext(source, sandbox, { filename: 'ime-submit.js' });
  return sandbox.window.WhiteboxImeSubmit;
}

function inputFixture(value = '한글 질문') {
  let submissions = 0;
  const form = {
    requestSubmit() { submissions += 1; },
    querySelector() { return input; },
  };
  const input = {
    value,
    isConnected: true,
    closest: selector => selector === 'form' ? form : null,
  };
  return { input, form, submissions: () => submissions };
}

function registerImeSubmitTests(context) {
  const { test, root } = context;

  test('한국어 IME 조합 완료 Enter는 두 번째 Enter 없이 한 번 전송한다', async () => {
    const ime = createImeSubmit(root);
    const fixture = inputFixture();
    let prevented = false;
    const handled = ime.handleKeydown({
      key: 'Enter', shiftKey: false, isComposing: true, keyCode: 229,
      preventDefault() { prevented = true; },
    }, fixture.input);

    assert.equal(handled, true);
    assert.equal(prevented, false, 'IME가 조합을 끝낼 기본 동작은 막지 않아야 합니다.');
    assert.equal(fixture.submissions(), 0);
    ime.handleCompositionEnd({ target: fixture.input });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fixture.submissions(), 1);
  });

  test('브라우저가 일반 Enter도 이어서 보내면 IME 지연 전송과 중복되지 않는다', async () => {
    const ime = createImeSubmit(root);
    const fixture = inputFixture();
    ime.handleKeydown({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 229 }, fixture.input);
    ime.handleCompositionEnd({ target: fixture.input });
    ime.handleKeydown({
      key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13,
      preventDefault() {},
    }, fixture.input);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fixture.submissions(), 1);
  });
}

module.exports = { registerImeSubmitTests };
