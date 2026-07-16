'use strict';

const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 9223);
const sessionId = process.argv[3] || 'codex:019f6366-dd50-74f2-b297-4694f00cc0c5';
const childTaskName = process.argv[4] || '';
const outputDir = path.join(__dirname, '..', 'artifacts');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
      const target = targets.find(item => item.type === 'page' && /LoadToAgent/i.test(item.title || '')) || targets.find(item => item.type === 'page');
      if (target && target.webSocketDebuggerUrl) return target;
    } catch {}
    await pause(250);
  }
  throw new Error(`실제 앱 디버그 대상(${port})을 찾지 못했습니다.`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(send, expression)) return;
    await pause(250);
  }
  throw new Error(message);
}

async function screenshot(send, name) {
  const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const file = path.join(outputDir, name);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

(async () => {
  const target = await pageTarget();
  const { socket, send } = await connect(target.webSocketDebuggerUrl);
  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.bringToFront');
    await waitFor(send, `Boolean(typeof state !== 'undefined' && state.snapshot && state.snapshot.sessions && state.snapshot.sessions.some(item => item.id === ${JSON.stringify(sessionId)}))`, '검증할 실제 세션을 앱에서 찾지 못했습니다.');
    await evaluate(send, `(() => {
      state.view = 'all'; state.provider = 'all'; state.providerFilters.clear(); state.workspace = 'all'; state.search = ''; state.graphFocusId = null;
      renderSessions('view'); document.querySelector('.main-stage')?.scrollTo(0, 0); return true;
    })()`);
    await waitFor(send, `document.querySelectorAll('.runtime-segment').length === 1 && document.querySelectorAll('.live-tmux-card').length === 0`, '실제 진행 중 화면에 실행 세션 외 자원이 섞였습니다.');
    const runtimeSplit = await evaluate(send, `(() => ({ segments: document.querySelectorAll('.runtime-segment').length, firstIsTmux: document.querySelector('.runtime-segment:first-child')?.classList.contains('tmux-runtime') || false, tmuxCards: document.querySelectorAll('.live-tmux-card').length, tmuxNames: [...document.querySelectorAll('.live-tmux-card-head b')].map(node => node.textContent.trim()), standardLanes: document.querySelectorAll('.standard-runtime .agent-flow-lane').length, overflow: document.querySelector('#liveSessionGrid').scrollWidth > document.querySelector('#liveSessionGrid').clientWidth + 2 }))()`);
    if (runtimeSplit.segments !== 1 || runtimeSplit.firstIsTmux || runtimeSplit.tmuxCards !== 0 || runtimeSplit.standardLanes < 1 || runtimeSplit.overflow) throw new Error(`실제 진행 중 실행 세션 전용 UI가 맞지 않습니다: ${JSON.stringify(runtimeSplit)}`);
    await pause(700);
    await evaluate(send, `(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } return true; })()`);
    const runtimeSplitImage = await screenshot(send, 'loadtoagent-actual-runtime-split.png');
    const tmuxOpen = await evaluate(send, `(() => { state.view = 'tmux'; renderSessions('view'); const pane = document.querySelector('[data-tmux-type="pane"][data-tmux-id]'); const id = pane?.dataset.tmuxId || ''; pane?.click(); return { id, view: state.view, focus: state.tmuxFocus }; })()`);
    if (!tmuxOpen.id || tmuxOpen.view !== 'tmux' || tmuxOpen.focus?.id !== tmuxOpen.id) throw new Error(`TMUX 자원을 전용 탭에서 열지 못했습니다: ${JSON.stringify(tmuxOpen)}`);
    await evaluate(send, `(() => {
      state.view = 'all'; state.provider = 'all'; state.providerFilters.clear(); state.workspace = 'all'; state.search = '';
      state.graphFocusId = ${JSON.stringify(sessionId)};
      state.expandedCompletedSubagents.delete(${JSON.stringify(sessionId)});
      renderSessions('focus'); drawAgentWorkflowConnections();
      document.querySelector('.main-stage')?.scrollTo(0, 0);
      return true;
    })()`);
    let probe = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      probe = await evaluate(send, `(() => { const session = state.snapshot.sessions.find(item => item.id === ${JSON.stringify(sessionId)}); const relevant = (session?.collaboration?.communications || []).filter(event => ['assignment', 'started', 'followup', 'message', 'result', 'interrupt'].includes(event.kind)); return { focusId: state.graphFocusId, title: session?.title || '', source: session?.source || '', sourceLabel: session?.sourceLabel || '', clientKind: session?.clientKind || '', parentId: session?.parentId || '', taskName: session?.taskName || '', file: session?.file || '', environment: session?.environment || null, truncated: session?.truncated || false, childIds: session?.childIds?.length || 0, parsedSpawns: session?.collaboration?.spawns?.length || 0, parsedCommunications: session?.collaboration?.communications?.length || 0, relevantCommunications: relevant.length, parsedMetrics: session?.collaboration?.metrics || null, domChildren: document.querySelectorAll('.downstream-column .agent-workflow-node').length, completedToggle: Boolean(document.querySelector('[data-subagent-completed-toggle]')), completedExpanded: Boolean(document.querySelector('[data-completed-subagent-list]')), legacyFilters: document.querySelectorAll('[data-subagent-status], [data-subagent-provider], [data-subagent-search]').length, recentSubagents: [...document.querySelectorAll('#sessionGrid [data-session-id]')].filter(node => state.snapshot.sessions.find(item => item.id === node.dataset.sessionId)?.parentId).length, domCommunications: document.querySelectorAll('.agent-communication-event').length, domCommunicationTotal: Number(document.querySelector('.agent-communication-panel')?.dataset.collaborationCommunicationsTotal || 0), pageText: document.querySelector('.agent-workflow-canvas')?.innerText?.slice(0, 300) || '' }; })()`);
      if (probe.childIds > 0 && probe.domChildren === 0 && probe.completedToggle && !probe.completedExpanded && probe.legacyFilters === 0 && probe.recentSubagents === 0 && probe.parsedSpawns === probe.childIds
        && probe.domCommunications === Math.min(probe.relevantCommunications, 60)
        && probe.domCommunicationTotal === probe.relevantCommunications) break;
      await pause(250);
    }
    if (!probe || probe.childIds < 1 || probe.domChildren !== 0 || !probe.completedToggle || probe.completedExpanded || probe.legacyFilters !== 0 || probe.recentSubagents !== 0 || probe.parsedSpawns !== probe.childIds
      || probe.domCommunications !== Math.min(probe.relevantCommunications, 60)
      || probe.domCommunicationTotal !== probe.relevantCommunications) throw new Error(`실제 세션의 서브에이전트 또는 통신 기록 수가 맞지 않습니다: ${JSON.stringify(probe)}`);
    const collapsedWorkflow = await screenshot(send, 'loadtoagent-actual-collaboration-collapsed.png');
    await evaluate(send, `(() => { document.querySelector('[data-subagent-completed-toggle]')?.click(); return true; })()`);
    await waitFor(send, `document.querySelectorAll('.downstream-column .agent-workflow-node').length === ${probe.childIds} && Boolean(document.querySelector('[data-completed-subagent-list]'))`, '완료된 서브에이전트 펼치기가 동작하지 않았습니다.');
    await pause(700);
    await evaluate(send, `(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } drawAgentWorkflowConnections(); return true; })()`);
    const metrics = await evaluate(send, `(() => ({
      values: [...document.querySelectorAll('[data-collaboration-metric]')].reduce((out, node) => { out[node.dataset.collaborationMetric] = node.querySelector('b')?.textContent?.trim(); return out; }, {}),
      childCards: document.querySelectorAll('.downstream-column .agent-workflow-node').length,
      completedCards: document.querySelectorAll('.downstream-column .agent-flow-row.completed').length,
      communications: document.querySelectorAll('.agent-communication-event').length,
      assignments: document.querySelectorAll('[data-communication-kind="assignment"]').length,
      results: document.querySelectorAll('[data-communication-kind="result"]').length,
      narratedAssignments: document.querySelectorAll('.agent-flow-assignment-source').length,
      legacyProtectionCopy: /지시 내용은 보호된 세션|로컬 로그에서 보호|지시 원문은 Codex 로컬 로그에서 암호화/.test(document.body.innerText),
      connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
      groupedArrows: document.querySelectorAll('.agent-workflow-edge.downstream.group[marker-end]').length,
      workingSubagents: document.querySelectorAll('.child-session.work-working').length,
      restingSubagents: document.querySelectorAll('.child-session.work-resting').length,
      attentionSubagents: document.querySelectorAll('.child-session.work-attention').length,
      conversationCards: document.querySelectorAll('[data-open-subagent-chat]').length,
      nestedFlowCards: document.querySelectorAll('.downstream-column [data-graph-focus]').length,
      completedToggle: Boolean(document.querySelector('[data-subagent-completed-toggle]')),
      completedExpanded: Boolean(document.querySelector('[data-completed-subagent-list]')),
      legacyFilters: document.querySelectorAll('[data-subagent-status], [data-subagent-provider], [data-subagent-search]').length,
      executionBadges: document.querySelectorAll('.downstream-column .execution-mode-badge').length,
      tmuxBadges: document.querySelectorAll('.downstream-column .execution-mode-badge.tmux').length,
      standardBadges: document.querySelectorAll('.downstream-column .execution-mode-badge.standard').length,
      taskNames: [...document.querySelectorAll('.downstream-column .agent-flow-session-title')].map(node => node.textContent.trim()),
      agentNames: [...document.querySelectorAll('.downstream-column .agent-flow-agent strong')].map(node => node.textContent.trim()),
      outcomes: [...document.querySelectorAll('.downstream-column .agent-flow-outcome')].map(node => node.textContent.trim()),
    }))()`);
    const parsedMetrics = probe.parsedMetrics || {};
    const expected = metrics.values.created === String(parsedMetrics.cumulativeCreated)
      && metrics.values.capacity === String(parsedMetrics.simultaneousCapacity > 0 ? parsedMetrics.simultaneousCapacity : '--')
      && metrics.values.running === String(parsedMetrics.currentlyRunning)
      && metrics.values.completed === String(parsedMetrics.completedRecords)
      && metrics.childCards === probe.childIds && metrics.completedCards === parsedMetrics.completedRecords
      && metrics.communications === Math.min(probe.relevantCommunications, 60)
      && metrics.connectionPaths === 2 && metrics.groupedArrows === 1
      && metrics.workingSubagents + metrics.restingSubagents + metrics.attentionSubagents === metrics.childCards
      && metrics.conversationCards === metrics.childCards && metrics.nestedFlowCards === 0
      && metrics.completedToggle && metrics.completedExpanded && metrics.legacyFilters === 0
      && metrics.executionBadges === metrics.childCards && metrics.tmuxBadges + metrics.standardBadges === metrics.childCards
      && !metrics.legacyProtectionCopy && (!childTaskName || metrics.narratedAssignments > 0)
      && metrics.taskNames.length === metrics.childCards && metrics.agentNames.length === metrics.childCards && metrics.outcomes.length === metrics.childCards;
    if (!expected) throw new Error(`실제 앱 협업 수치가 맞지 않습니다: ${JSON.stringify({ parsedMetrics, probe, metrics })}`);
    const workflow = await screenshot(send, 'loadtoagent-actual-collaboration-workflow.png');
    const focusBeforeConversation = await evaluate(send, 'state.graphFocusId');
    const selectedConversation = await evaluate(send, `(() => { const cards = [...document.querySelectorAll('[data-open-subagent-chat]')]; const wanted = ${JSON.stringify(childTaskName)}; const card = wanted ? cards.find(node => state.snapshot.sessions.find(item => item.id === node.dataset.openSubagentChat)?.taskName === wanted) : cards[cards.length - 1]; const id = card?.dataset.openSubagentChat || ''; const session = state.snapshot.sessions.find(item => item.id === id); const expectedEvents = session ? subagentCoordinationEvents(session).length : 0; const expectsResume = Boolean(session && !isLiveSession(session) && agentResumeSupport(session).supported); card?.click(); return { id, taskName: session?.taskName || '', expectedEvents, expectsResume, clientKind: session?.clientKind || '', assignmentSource: session?.delegation?.assignmentSource || '' }; })()`);
    await waitFor(send, `!document.querySelector('.drawer-loading') && Boolean(document.querySelector('[data-subagent-work-messages]'))`, '실제 서브에이전트 전체 작업 기록을 불러오지 못했습니다.');
    const conversationMetrics = await evaluate(send, `({ focusId: state.graphFocusId, drawerMode: state.drawerMode, events: document.querySelectorAll('[data-subagent-communication]').length, workMessages: Number(document.querySelector('[data-subagent-work-messages]')?.dataset.subagentWorkMessages || 0), coordinationCollapsed: !document.querySelector('.subagent-coordination')?.open, visibleTabs: document.querySelectorAll('.drawer-tab:not(.hidden)').length, resumeAvailable: Boolean(document.querySelector('[data-resume-agent]')), text: document.querySelector('#drawerContent')?.innerText || '' })`);
    if (!selectedConversation.id || (childTaskName && selectedConversation.taskName !== childTaskName) || (childTaskName && selectedConversation.assignmentSource !== 'parent-narration') || conversationMetrics.workMessages < 1 || !conversationMetrics.text.includes('서브에이전트 실제 작업 기록') || /보호된 메시지|내용 없이 통신 상태|서브에이전트 실행이 시작/.test(conversationMetrics.text) || conversationMetrics.focusId !== focusBeforeConversation || conversationMetrics.drawerMode !== 'subagent' || conversationMetrics.events !== selectedConversation.expectedEvents || !conversationMetrics.coordinationCollapsed || conversationMetrics.visibleTabs !== 1 || conversationMetrics.resumeAvailable !== selectedConversation.expectsResume) throw new Error(`실제 앱 서브에이전트 작업 상세가 맞지 않습니다: ${JSON.stringify({ selectedConversation, conversationMetrics })}`);
    const subagentConversation = await screenshot(send, 'loadtoagent-actual-subagent-conversation.png');
    await evaluate(send, `(() => { document.querySelector('#closeDrawerBtn')?.click(); return true; })()`);
    await pause(350);
    await evaluate(send, `(() => { document.querySelector('.agent-communication-panel')?.scrollIntoView({ block: 'start' }); return true; })()`);
    await pause(350);
    const communication = await screenshot(send, 'loadtoagent-actual-collaboration-communication.png');
    process.stdout.write(`${JSON.stringify({ ok: true, sessionId, runtimeSplit, runtimeSplitImage, probe, metrics, selectedConversation, conversationMetrics, collapsedWorkflow, workflow, subagentConversation, communication }, null, 2)}\n`);
  } finally {
    socket.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
