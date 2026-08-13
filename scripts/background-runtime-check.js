'use strict';

const port = Number(process.argv[2] || 9224);
const cwd = process.argv[3] || process.cwd();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function targetPage() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
      const target = targets.find(item => item.type === 'page' && /Whitebox/i.test(item.title || '')) || targets.find(item => item.type === 'page');
      if (target && target.webSocketDebuggerUrl) return target;
    } catch {}
    await pause(200);
  }
  throw new Error('백그라운드 검증용 앱 화면을 찾지 못했습니다.');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result || {});
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '렌더러 평가 실패');
  return result.result && result.result.value;
}

async function waitFor(send, expression, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const value = await evaluate(send, expression);
      if (value) return value;
    } catch {}
    await pause(200);
  }
  throw new Error(message);
}

(async () => {
  const target = await targetPage();
  const { socket, send } = await connect(target.webSocketDebuggerUrl);
  let terminalId = '';
  try {
    await send('Runtime.enable');
    terminalId = await evaluate(send, `(async () => { const bootstrap = await window.whitebox.bootstrap(); const created = await window.whitebox.terminalCreate({ type: bootstrap.platform.localShell, cwd: ${JSON.stringify(cwd)}, title: '일반 터미널 백그라운드 유지 검증' }); return created.id; })()`);
    await waitFor(send, `(async () => (await window.whitebox.terminalList()).some(item => item.id === ${JSON.stringify(terminalId)} && item.status === 'running' && item.type !== 'agent'))()`, '일반 세션 터미널이 실행되지 않았습니다.');
    await evaluate(send, 'window.close(); true');
    const hidden = await waitFor(send, `(async () => { const state = await window.whitebox.backgroundState(); return !state.visible && state.backgroundSessions >= 1 && state.trayReady ? state : null; })()`, '창을 닫은 뒤 일반 터미널이 백그라운드로 유지되지 않았습니다.');
    const retained = await evaluate(send, `(async () => { await new Promise(resolve => setTimeout(resolve, 800)); return (await window.whitebox.terminalList()).find(item => item.id === ${JSON.stringify(terminalId)}) || null; })()`);
    if (!retained || retained.status !== 'running') throw new Error('숨김 상태에서 일반 세션 터미널이 종료되었습니다.');
    await evaluate(send, 'window.whitebox.showApp()');
    const reopened = await waitFor(send, `(async () => (await window.whitebox.backgroundState()).visible)()`, '백그라운드 앱을 다시 열지 못했습니다.');
    await evaluate(send, `window.whitebox.terminalClose(${JSON.stringify(terminalId)})`);
    terminalId = '';
    process.stdout.write(`${JSON.stringify({ ok: true, hidden, retained: { type: retained.type, status: retained.status }, reopened })}\n`);
  } finally {
    if (terminalId) {
      try { await evaluate(send, `window.whitebox.terminalClose(${JSON.stringify(terminalId)})`); } catch {}
    }
    socket.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
