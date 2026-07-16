'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const localTerminalType = process.platform === 'win32' ? 'powershell' : 'shell';

function markerCommand(marker) {
  return process.platform === 'win32' ? `Write-Output ${marker}` : `printf '${marker}\\n'`;
}

const isolatedBridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), `loadtoagent-visual-${process.pid}-`));
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), `loadtoagent-visual-user-${process.pid}-`));
process.env.LOADTOAGENT_TEST_INSTANCE = '1';
process.env.LOADTOAGENT_BRIDGE_HOME = isolatedBridgeHome;
const { app, BrowserWindow } = require('electron');
app.setPath('userData', isolatedUserData);
app.once('quit', () => {
  try { fs.rmSync(isolatedBridgeHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(isolatedUserData, { recursive: true, force: true }); } catch {}
});

require('../main');

async function waitForRenderer(win, expression, attempts = 40, intervalMs = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await win.webContents.executeJavaScript(expression);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function captureStableState(win, setupExpression, verifyExpression, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await win.webContents.executeJavaScript(setupExpression);
    await new Promise(resolve => setTimeout(resolve, 480));
    if (!await win.webContents.executeJavaScript(verifyExpression)) continue;
    await win.webContents.executeJavaScript(`(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } void document.body.offsetHeight; return true; })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    const image = await win.webContents.capturePage();
    if (await win.webContents.executeJavaScript(verifyExpression)) return image;
  }
  throw new Error('검증할 화면 상태가 유지되는 동안 캡처하지 못했습니다.');
}

function setTestWindowSize(win, width, height) {
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  win.restore();
  win.setBounds({ width, height }, false);
}

app.whenReady().then(() => {
  const timeout = setTimeout(async () => {
    let exitCode = 0;
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('LoadToAgent 창을 찾을 수 없습니다.');
      const executeJavaScript = win.webContents.executeJavaScript.bind(win.webContents);
      let executionStep = 0;
      win.webContents.executeJavaScript = async expression => {
        executionStep += 1;
        try {
          return await executeJavaScript(expression);
        } catch (error) {
          const preview = String(expression).replace(/\s+/g, ' ').slice(0, 180);
          throw new Error(`visual execute step ${executionStep} failed (${preview}): ${error.message}`);
        }
      };
      setTestWindowSize(win, 1600, 980);
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const tmuxReady = await win.webContents.executeJavaScript(`(() => {
          const summary = window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.tmux && window.LoadToAgentApp.state.snapshot.tmux.summary || {};
          const totals = window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.summary && window.LoadToAgentApp.state.snapshot.summary.totals || {};
          return Number(summary.aiPanes || 0) > 0
            && Number(summary.linked || 0) === Number(summary.aiPanes || 0)
            && Number(totals.sessions || 0) > 0;
        })()`);
        if (tmuxReady) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await win.webContents.executeJavaScript("document.fonts.ready.then(() => { window.LoadToAgentI18n?.setLocale('ko'); window.LoadToAgentApp.state.view = 'all'; window.LoadToAgentApp.state.graphFocusId = null; document.querySelectorAll('.view-nav .nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'all')); window.LoadToAgentApp.renderSessions(); document.querySelector('.main-stage')?.scrollTo(0, 0); })");
      await new Promise(resolve => setTimeout(resolve, 500));
      const bridgeInfo = await win.webContents.executeJavaScript(`(async () => {
        const bootstrap = await window.loadtoagent.bootstrap();
        const command = await window.loadtoagent.bridgeCommand('codex');
        return { launcher: bootstrap.bridgeCli, command };
      })()`);
      if (!bridgeInfo.launcher || !bridgeInfo.launcher.path || !fs.existsSync(bridgeInfo.launcher.path) || !bridgeInfo.command || !bridgeInfo.command.ok || !bridgeInfo.command.command.includes('run codex')) throw new Error(`외부 터미널 브리지 실행기가 준비되지 않았습니다: ${JSON.stringify(bridgeInfo)}`);
      const image = await win.webContents.capturePage();
      const outputDir = path.join(__dirname, '..', 'artifacts');
      fs.mkdirSync(outputDir, { recursive: true });
      const output = path.join(outputDir, 'loadtoagent-dashboard.png');
      fs.writeFileSync(output, image.toPNG());
      const beginnerMetrics = await win.webContents.executeJavaScript(`(() => {
        const guide = document.querySelector('#beginnerGuide');
        const stage = document.querySelector('.main-stage');
        const visibleText = document.body.innerText;
        return {
          guideVisible: Boolean(guide && !guide.classList.contains('hidden')),
          guideSteps: guide ? guide.querySelectorAll('li').length : 0,
          homeActive: document.querySelector('[data-view="all"]')?.classList.contains('active') || false,
          navLabels: [...document.querySelectorAll('.view-nav .nav-item span:nth-child(2)')].map(item => item.textContent.trim()),
          primaryAction: document.querySelector('#newRunBtn')?.textContent.replace(/\s+/g, ' ').trim() || '',
          oldJargonVisible: ['AI AGENT OBSERVATORY', 'SESSION STREAM', 'AGENT MIND MAP', 'NEW TMUX SESSION'].filter(label => visibleText.includes(label)),
          noHorizontalOverflow: stage ? stage.scrollWidth <= stage.clientWidth + 2 : false,
        };
      })()`);
      if (!beginnerMetrics.guideVisible || beginnerMetrics.guideSteps !== 4 || !beginnerMetrics.homeActive || !beginnerMetrics.navLabels.includes('홈') || !beginnerMetrics.navLabels.includes('내 확인 필요') || !beginnerMetrics.navLabels.includes('세션 터미널') || !beginnerMetrics.navLabels.includes('tmux 작업') || beginnerMetrics.primaryAction !== '＋새 AI 작업⌘N' || beginnerMetrics.oldJargonVisible.length || !beginnerMetrics.noHorizontalOverflow) {
        throw new Error(`초보자용 기본 화면이 올바르지 않습니다: ${JSON.stringify(beginnerMetrics)}`);
      }
      setTestWindowSize(win, 1080, 700);
      await new Promise(resolve => setTimeout(resolve, 350));
      await win.webContents.executeJavaScript("document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 100));
      const compactMetrics = await win.webContents.executeJavaScript(`(() => {
        const guide = document.querySelector('#beginnerGuide');
        const intro = guide?.querySelector('.beginner-guide-intro')?.getBoundingClientRect();
        const steps = guide?.querySelector('ol')?.getBoundingClientRect();
        return {
          width: window.innerWidth,
          guideVisible: Boolean(guide && !guide.classList.contains('hidden')),
          guideStacked: Boolean(intro && steps && intro.bottom <= steps.top + 2),
          noBodyOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
          noGuideOverflow: guide ? guide.scrollWidth <= guide.clientWidth + 2 : false,
        };
      })()`);
      if (!compactMetrics.guideVisible || !compactMetrics.guideStacked || !compactMetrics.noBodyOverflow || !compactMetrics.noGuideOverflow) throw new Error(`최소 창 크기에서 초보자 안내가 올바르지 않습니다: ${JSON.stringify(compactMetrics)}`);
      const compactImage = await win.webContents.capturePage();
      const compactOutput = path.join(outputDir, 'loadtoagent-beginner-compact.png');
      fs.writeFileSync(compactOutput, compactImage.toPNG());
      setTestWindowSize(win, 1600, 980);
      await new Promise(resolve => setTimeout(resolve, 350));

      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('[data-view="settings"]')?.click();
        const select = document.querySelector('#languageSelect');
        select.value = 'zh-CN';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('.main-stage')?.scrollTo(0, 0);
      })()`);
      await new Promise(resolve => setTimeout(resolve, 350));
      const settingsMetrics = await win.webContents.executeJavaScript(`(() => {
        const section = document.querySelector('#settingsSection');
        const card = document.querySelector('.language-settings-card');
        const select = document.querySelector('#languageSelect');
        return {
          visible: Boolean(section && !section.classList.contains('hidden')),
          locale: window.LoadToAgentI18n?.getLocale(),
          language: document.documentElement.lang,
          title: document.querySelector('#settingsTitle')?.textContent || '',
          options: select?.options.length || 0,
          cardVisible: Boolean(card && card.getBoundingClientRect().height > 0),
          noOverflow: Boolean(section && section.scrollWidth <= section.clientWidth + 2),
        };
      })()`);
      if (!settingsMetrics.visible || settingsMetrics.locale !== 'zh-CN' || settingsMetrics.language !== 'zh-CN' || settingsMetrics.title !== '应用设置' || settingsMetrics.options !== 3 || !settingsMetrics.cardVisible || !settingsMetrics.noOverflow) throw new Error(`다국어 설정 화면이 올바르지 않습니다: ${JSON.stringify(settingsMetrics)}`);
      const settingsImage = await win.webContents.capturePage();
      const settingsOutput = path.join(outputDir, 'loadtoagent-language-settings.png');
      fs.writeFileSync(settingsOutput, settingsImage.toPNG());
      await win.webContents.executeJavaScript("window.LoadToAgentI18n.setLocale('ko')");
      await new Promise(resolve => setTimeout(resolve, 150));

      await win.webContents.executeJavaScript("document.querySelector('[data-view=\"terminal\"]')?.click(); document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 300));
      await win.webContents.executeJavaScript("document.querySelector('#newPowerShellBtn')?.click()");
      const firstTerminalId = await waitForRenderer(win, "document.querySelector('.terminal-session-item.active')?.dataset.terminalId || ''", 50, 200);
      if (!firstTerminalId) throw new Error('로컬 PTY 터미널이 생성되지 않았습니다.');
      await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#terminalCommandInput'); input.value = ${JSON.stringify(markerCommand('LOADTOAGENT_PTY_OK'))}; document.querySelector('#terminalCommandForm').requestSubmit(); })()`);
      const firstTerminalReplay = await waitForRenderer(win, `(async () => { const value = await window.loadtoagent.terminalGet(${JSON.stringify(firstTerminalId)}); return value && value.replay.includes('LOADTOAGENT_PTY_OK') ? value.replay : ''; })()`, 50, 200);
      if (!firstTerminalReplay) throw new Error('로컬 PTY에 보낸 명령 결과를 수신하지 못했습니다.');

      await win.webContents.executeJavaScript("document.querySelector('#newPowerShellBtn')?.click()");
      const secondTerminalId = await waitForRenderer(win, `(() => { const id = document.querySelector('.terminal-session-item.active')?.dataset.terminalId || ''; return id && id !== ${JSON.stringify(firstTerminalId)} ? id : ''; })()`, 50, 200);
      if (!secondTerminalId) throw new Error('두 번째 로컬 PTY 터미널이 생성되지 않았습니다.');
      await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#terminalCommandInput'); input.value = ${JSON.stringify(markerCommand('LOADTOAGENT_SECOND_PTY_OK'))}; document.querySelector('#terminalCommandForm').requestSubmit(); })()`);
      const secondTerminalReplay = await waitForRenderer(win, `(async () => { const value = await window.loadtoagent.terminalGet(${JSON.stringify(secondTerminalId)}); return value && value.replay.includes('LOADTOAGENT_SECOND_PTY_OK') ? value.replay : ''; })()`, 50, 200);
      if (!secondTerminalReplay) throw new Error('두 번째 로컬 PTY에 보낸 명령 결과를 수신하지 못했습니다.');
      const terminalMetrics = await win.webContents.executeJavaScript(`(async () => {
        const terminalSessions = await window.loadtoagent.terminalList();
        return {
          sectionVisible: !document.querySelector('#terminalSection')?.classList.contains('hidden'),
          appView: window.LoadToAgentApp.state.view,
          activeNav: document.querySelector('.view-nav .nav-item.active')?.dataset.view || '',
          sectionClass: document.querySelector('#terminalSection')?.className || '',
          sessions: document.querySelectorAll('.terminal-session-item').length,
          duplicateTabs: document.querySelectorAll('.terminal-tab').length,
          xterms: document.querySelectorAll('.terminal-screen .xterm').length,
          selectedTitle: document.querySelector('#terminalTargetMeta b')?.textContent || '',
          workbenchInGeneral: document.querySelector('#terminalSection')?.contains(document.querySelector('#terminalWorkbench')) || false,
          tmuxSectionHidden: document.querySelector('#tmuxSection')?.classList.contains('hidden') || false,
          tmuxControlsMixedIn: Boolean(document.querySelector('#terminalSection #terminalTmuxList') || document.querySelector('#terminalSection #newTmuxSessionBtn')),
          onlyGeneralSessions: [...document.querySelectorAll('.terminal-session-item')].every(item => terminalSessions.find(session => session.id === item.dataset.terminalId)?.type !== 'tmux'),
          composerVisible: (() => { const rect = document.querySelector('#terminalCommandForm')?.getBoundingClientRect(); return Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight + 2); })(),
          consolePaneVisible: Boolean(document.querySelector('.terminal-console-pane')),
        };
      })()`);
      if (!terminalMetrics.sectionVisible || terminalMetrics.sessions < 2 || terminalMetrics.duplicateTabs !== 0 || terminalMetrics.xterms < 2 || !terminalMetrics.workbenchInGeneral || !terminalMetrics.tmuxSectionHidden || terminalMetrics.tmuxControlsMixedIn || !terminalMetrics.onlyGeneralSessions || !terminalMetrics.composerVisible || !terminalMetrics.consolePaneVisible) throw new Error(`일반 명령창 UX가 불완전합니다: ${JSON.stringify(terminalMetrics)}`);
      const terminalImage = await captureStableState(win,
        `(() => {
          document.querySelector('#runModal')?.classList.add('hidden');
          document.querySelector('#drawerBackdrop')?.classList.add('hidden');
          document.querySelector('.main-stage')?.scrollTo(0, 0);
        })()`,
        `(() => {
          const section = document.querySelector('#terminalSection');
          const composer = document.querySelector('#terminalCommandForm')?.getBoundingClientRect();
          return Boolean(section && !section.classList.contains('hidden')
            && document.querySelector('.terminal-session-item.active')
            && document.querySelector('#drawerBackdrop')?.classList.contains('hidden')
            && composer && composer.top >= 0 && composer.bottom <= window.innerHeight + 2);
        })()`, 12);
      const terminalOutput = path.join(outputDir, 'loadtoagent-terminal-control.png');
      fs.writeFileSync(terminalOutput, terminalImage.toPNG());
      await win.webContents.executeJavaScript("window.loadtoagent.terminalList().then(items => Promise.all(items.map(item => window.loadtoagent.terminalClose(item.id))))");
      await new Promise(resolve => setTimeout(resolve, 250));

      await win.webContents.executeJavaScript("document.querySelector('[data-view=\"tmux\"]')?.click(); document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 500));
      const tmuxImage = await win.webContents.capturePage();
      const tmuxOutput = path.join(outputDir, 'loadtoagent-tmux-map.png');
      fs.writeFileSync(tmuxOutput, tmuxImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.tmux-pane-node.has-agent [data-control-tmux]')?.click()");
      await waitForRenderer(win, `(() => document.querySelector('#runModal')?.classList.contains('hidden') && document.querySelector('#drawerBackdrop')?.classList.contains('hidden'))()`, 60, 100);
      const tmuxControlMetrics = await win.webContents.executeJavaScript(`(() => ({
        tmuxSectionVisible: !document.querySelector('#tmuxSection')?.classList.contains('hidden'),
        generalSectionHidden: document.querySelector('#terminalSection')?.classList.contains('hidden') || false,
        workbenchInTmux: document.querySelector('#tmuxSection')?.contains(document.querySelector('#terminalWorkbench')) || false,
        tmuxListInTmux: document.querySelector('#tmuxSection')?.contains(document.querySelector('#terminalTmuxList')) || false,
        generalListMixedIn: Boolean(document.querySelector('#tmuxSection #terminalSessionList')),
        tmuxCreateInTmux: document.querySelector('#tmuxSection')?.contains(document.querySelector('#newTmuxSessionBtn')) || false,
        targetSelected: !document.querySelector('#terminalTargetMeta b')?.textContent.includes('아직 선택'),
        toolsVisible: !document.querySelector('#terminalTmuxTools')?.classList.contains('hidden'),
        controlButtons: document.querySelectorAll('[data-control-tmux]').length,
      }))()`);
      if (!tmuxControlMetrics.tmuxSectionVisible || !tmuxControlMetrics.generalSectionHidden || !tmuxControlMetrics.workbenchInTmux || !tmuxControlMetrics.tmuxListInTmux || tmuxControlMetrics.generalListMixedIn || !tmuxControlMetrics.tmuxCreateInTmux || !tmuxControlMetrics.targetSelected || !tmuxControlMetrics.toolsVisible || tmuxControlMetrics.controlButtons < 1) throw new Error(`tmux 전용 묶음이 불완전합니다: ${JSON.stringify(tmuxControlMetrics)}`);
      const tmuxControlImage = await win.webContents.capturePage();
      const tmuxControlOutput = path.join(outputDir, 'loadtoagent-tmux-control.png');
      fs.writeFileSync(tmuxControlOutput, tmuxControlImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 200));
      await win.webContents.executeJavaScript("document.querySelector('.tmux-pane-node.has-agent [data-tmux-type=\"pane\"]')?.click()");
      await new Promise(resolve => setTimeout(resolve, 500));
      const tmuxFocusImage = await win.webContents.capturePage();
      const tmuxFocusOutput = path.join(outputDir, 'loadtoagent-tmux-focus.png');
      fs.writeFileSync(tmuxFocusOutput, tmuxFocusImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.tmux-pane-node.has-agent [data-open-session]')?.click()");
      const tmuxDetailReady = await waitForRenderer(win, `(() => document.querySelector('#detailDrawer')?.classList.contains('open') && !document.querySelector('.drawer-loading'))()`, 120, 250);
      if (!tmuxDetailReady) throw new Error('여러 창 작업에서 연결된 AI의 대화 상세를 불러오지 못했습니다.');
      const tmuxDetailImage = await win.webContents.capturePage();
      const tmuxDetailOutput = path.join(outputDir, 'loadtoagent-tmux-detail.png');
      fs.writeFileSync(tmuxDetailOutput, tmuxDetailImage.toPNG());
      const tmuxDetailMetrics = await win.webContents.executeJavaScript(`(() => ({
        drawerOpen: document.querySelector('#detailDrawer')?.classList.contains('open'),
        title: document.querySelector('#drawerTitle')?.textContent || '',
        loading: Boolean(document.querySelector('.drawer-loading')),
      }))()`);
      await win.webContents.executeJavaScript("document.querySelector('#closeDrawerBtn')?.click()");
      const tmuxMetrics = await win.webContents.executeJavaScript(`(() => ({
        summary: window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.tmux && window.LoadToAgentApp.state.snapshot.tmux.summary,
        distroNodes: document.querySelectorAll('.tmux-distro-node').length,
        sessionNodes: document.querySelectorAll('.tmux-session-node').length,
        windowNodes: document.querySelectorAll('.tmux-window-node').length,
        paneNodes: document.querySelectorAll('.tmux-pane-node').length,
        aiPaneNodes: document.querySelectorAll('.tmux-pane-node.has-agent').length,
        breadcrumbSteps: document.querySelectorAll('#tmuxBreadcrumbs button').length,
        focused: Boolean(window.LoadToAgentApp.state.tmuxFocus),
        linkedCommandTargets: (window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.sessions || []).filter(session => window.LoadToAgentTerminal.agentTargets(session).some(target => target.kind === 'tmux')).length,
      }))()`);
      if (Number(tmuxMetrics.summary?.linked || 0) > 0 && tmuxMetrics.linkedCommandTargets < 1) throw new Error(`연결된 tmux AI를 직접 지시 대상으로 찾지 못했습니다: ${JSON.stringify(tmuxMetrics)}`);
      await win.webContents.executeJavaScript("document.querySelector('[data-view=\"all\"]')?.click(); document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 350));
      const structuredSessionId = await win.webContents.executeJavaScript(`(() => {
        const base = (window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.sessions || []).find(item => item.provider === 'claude') || {};
        const id = 'visual-check:structured-detail';
        const fixture = {
          ...base,
          id,
          provider: 'claude',
          title: '구조화된 작업 기억 검토',
          model: base.model || 'claude',
          status: 'idle',
          updatedAt: new Date().toISOString(),
          messages: [{ id: 'memory', role: 'assistant', timestamp: new Date().toISOString(), text: JSON.stringify([
            { target: 'MEMORY.md', category: 'decision', content: '터미널 명령은 PTY 세션을 통해 전달한다.' },
            { target: 'terminal', category: 'pattern', content: 'tmux 대상과 입력 본문을 구조적으로 분리한다.' },
          ]) }],
          lifecycle: [],
          usage: base.usage || { input: 0, cachedInput: 0, output: 0, total: 0 },
          context: base.context || { used: 0, window: 0, percent: 0 },
        };
        window.LoadToAgentApp.state.details.set(id, fixture);
        window.LoadToAgentApp.state.selectedId = id;
        window.LoadToAgentApp.state.detailLoading = false;
        window.LoadToAgentApp.state.drawerTab = 'chat';
        window.LoadToAgentApp.state.drawerForceLatest = true;
        document.querySelector('#drawerBackdrop').classList.remove('hidden');
        document.querySelector('#detailDrawer').classList.add('open');
        document.querySelector('#detailDrawer').setAttribute('aria-hidden', 'false');
        window.LoadToAgentApp.renderDrawer();
        return id;
      })()`);
      await new Promise(resolve => setTimeout(resolve, 350));
      const structuredMetrics = await win.webContents.executeJavaScript(`(() => {
        const content = document.querySelector('#drawerContent');
        return {
          sessionId: ${JSON.stringify(structuredSessionId)},
          candidates: document.querySelectorAll('.memory-candidate').length,
          rawPreBlocks: document.querySelectorAll('.chat-bubble pre').length,
          bottomGap: content ? Math.abs(content.scrollHeight - content.scrollTop - content.clientHeight) : null,
          atBottom: content ? Math.abs(content.scrollHeight - content.scrollTop - content.clientHeight) < 60 : false,
          messageCount: document.querySelectorAll('.chat-row').length,
        };
      })()`);
      const structuredImage = await win.webContents.capturePage();
      const structuredOutput = path.join(outputDir, 'loadtoagent-structured-detail.png');
      fs.writeFileSync(structuredOutput, structuredImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('#closeDrawerBtn')?.click()");
      if (structuredSessionId && structuredMetrics.candidates === 0) throw new Error('구조화 JSON 메시지가 읽기 쉬운 카드로 렌더링되지 않았습니다.');
      if (structuredSessionId && !structuredMetrics.atBottom) throw new Error(`상세 대화가 최신 메시지 위치로 이동하지 않았습니다. gap=${structuredMetrics.bottomGap}`);
      const densitySetup = await win.webContents.executeJavaScript(`(async () => {
        const sessions = window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.sessions || [];
        const base = sessions.find(item => !item.parentId && window.LoadToAgentApp.isLiveSession(item)) || sessions[0];
        if (!base) return { focusId: '', terminalId: '' };
        const directTerminal = await window.loadtoagent.terminalCreate({ type: ${JSON.stringify(localTerminalType)}, title: 'AI 직접 지시 검증', cols: 120, rows: 32 });
        const alternateTerminal = await window.loadtoagent.terminalCreate({ type: ${JSON.stringify(localTerminalType)}, title: 'AI 지시 대상 선택 검증', cols: 120, rows: 32 });
        await window.LoadToAgentTerminal.refresh();
        const providerIds = window.LoadToAgentApp.state.providers.map(item => item.id);
        const now = Date.now();
        const roots = Array.from({ length: 32 }, (_, index) => ({
          ...base,
          id: 'visual-density:root:' + index,
          externalId: 'visual-density-root-' + index,
          provider: providerIds[index % providerIds.length],
          parentId: null,
          depth: 0,
          agentName: '',
          agentRole: '',
          title: '대규모 병렬 작업 흐름 ' + String(index + 1).padStart(2, '0'),
          status: 'running',
          statusDetail: '밀도 적응형 에이전트 지도 검증 중',
          updatedAt: new Date(now - index * 1000).toISOString(),
          childIds: index === 0 ? Array.from({ length: 10 }, (_, childIndex) => 'visual-density:child:' + childIndex) : [],
          context: { used: 54000 + index * 100, window: 258400, percent: 21 + index / 10, source: 'session' },
          usage: { input: 70000 + index * 100, cachedInput: 42000, output: 3200, reasoning: 900, total: 116100 + index * 100 },
          messages: [{ role: 'assistant', text: '동시에 실행되는 작업의 상태를 확인하고 있습니다.', timestamp: new Date(now - index * 1000).toISOString() }],
          lifecycle: [],
          runtimePresence: index === 0 ? [
            { id: 'visual-terminal:' + directTerminal.id, kind: 'windows', label: directTerminal.title, provider: base.provider, pid: directTerminal.pid, parentPid: directTerminal.pid, terminalId: directTerminal.id },
            { id: 'visual-terminal:' + alternateTerminal.id, kind: 'windows', label: alternateTerminal.title, provider: base.provider, pid: alternateTerminal.pid, parentPid: alternateTerminal.pid, terminalId: alternateTerminal.id },
          ] : [],
        }));
        const children = Array.from({ length: 10 }, (_, index) => ({
          ...roots[0],
          id: 'visual-density:child:' + index,
          externalId: 'visual-density-child-' + index,
          parentId: roots[0].id,
          depth: 1,
          agentName: ['Atlas', 'Nova', 'Echo', 'Iris', 'Orion', 'Sage', 'Flux', 'Luna', 'Pico', 'Gauss'][index],
          agentRole: index % 2 ? 'reviewer' : 'explorer',
          title: '연결된 서브에이전트 작업 ' + (index + 1),
          provider: index === 1 ? 'codex' : roots[0].provider,
          clientKind: index === 1 ? 'codex-desktop' : 'external-cli',
          status: 'completed',
          statusDetail: '작업 완료',
          taskName: 'accuracy_check_' + String(index + 1).padStart(2, '0'),
          agentPath: '/root/accuracy_check_' + String(index + 1).padStart(2, '0'),
          sharedGoal: '10개 서브에이전트의 정확도 결과를 합산해줘',
          result: String(index + 1) + '번 검사 완료',
          completionObserved: true,
          completedAt: new Date(now - index * 700).toISOString(),
          childIds: [],
          runtimePresence: index === 9 ? [{
            id: 'visual-tmux-pane-9',
            kind: 'tmux',
            label: 'density-team:%9',
            distro: 'FixtureLinux',
            sessionName: 'density-team',
            paneNativeId: '%9',
            paneId: 'visual-pane-9',
          }] : [],
          updatedAt: new Date(now - index * 700).toISOString(),
        }));
        children.forEach((child, index) => {
          child.delegation = {
            taskName: child.taskName,
            assignment: index % 2 ? '버튼과 화면 전환의 실제 동작을 독립적으로 검사해줘' : '',
            assignmentObserved: Boolean(index % 2),
            assignmentProtected: !Boolean(index % 2),
            sharedGoal: child.sharedGoal,
            result: child.result,
            currentlyRetained: index >= 7,
          };
        });
        const grandchild = {
          ...children[0],
          id: 'visual-density:grandchild:0',
          externalId: 'visual-density-grandchild-0',
          parentId: children[0].id,
          depth: 2,
          agentName: 'Nested',
          taskName: 'nested_accuracy_check',
          agentPath: children[0].agentPath + '/nested_accuracy_check',
          title: '중첩 서브에이전트 정확도 검사',
          result: '중첩 연결 정상',
          childIds: [],
          delegation: { taskName: 'nested_accuracy_check', result: '중첩 연결 정상', assignmentObserved: true, assignment: '하위 연결을 검사해줘' },
        };
        children[0].childIds = [grandchild.id];
        children[0].collaboration = { communications: [
          { id: 'nested-assignment', kind: 'assignment', label: '새 작업 배정', from: children[0].agentPath, to: grandchild.agentPath, taskName: grandchild.taskName, childId: grandchild.id, text: '하위 연결을 검사해줘', timestamp: new Date(now - 28000).toISOString() },
          { id: 'nested-started', kind: 'started', label: '서브에이전트 실행 시작', from: 'Codex 런타임', to: grandchild.agentPath, taskName: grandchild.taskName, childId: grandchild.id, text: 'started', timestamp: new Date(now - 27500).toISOString() },
          { id: 'nested-result', kind: 'result', label: '결과 반환', from: grandchild.agentPath, to: children[0].agentPath, taskName: grandchild.taskName, childId: grandchild.id, text: grandchild.result, timestamp: new Date(now - 27000).toISOString() },
        ], metrics: { cumulativeCreated: 1, simultaneousCapacity: 3, currentlyRunning: 0, completedRecords: 1, retainedCount: 1, capacitySource: 'runtime-instruction' } };
        const spawns = children.map((child, index) => ({ callId: 'visual-spawn-' + index, taskName: child.taskName, agentPath: child.agentPath, childId: child.id, status: 'completed', result: child.result, currentlyRetained: index >= 7 }));
        const communications = children.flatMap((child, index) => ([
          { id: 'visual-assignment-' + index, kind: 'assignment', label: '새 작업 배정', from: '/root', to: child.agentPath, taskName: child.taskName, childId: child.id, text: child.delegation.assignment, protected: child.delegation.assignmentProtected, timestamp: new Date(now - 30000 + index * 1000).toISOString() },
          { id: 'visual-started-' + index, kind: 'started', label: '서브에이전트 실행 시작', from: 'Codex 런타임', to: child.agentPath, taskName: child.taskName, childId: child.id, text: 'started', timestamp: new Date(now - 29500 + index * 1000).toISOString() },
          { id: 'visual-result-' + index, kind: 'result', label: '결과 반환', from: child.agentPath, to: '/root', taskName: child.taskName, childId: child.id, text: child.result, timestamp: new Date(now - 29000 + index * 1000).toISOString() },
        ]));
        roots[0].collaboration = {
          capacity: { totalThreads: 4, subagents: 3, source: 'runtime-instruction' },
          spawns,
          communications,
          retainedAgents: children.slice(7).map(child => ({ path: child.agentPath, taskName: child.taskName, name: child.agentName, status: 'completed' })),
          retainedObserved: true,
          metrics: { cumulativeCreated: 10, simultaneousCapacity: 3, currentlyRunning: 0, completedRecords: 10, retainedCount: 3, capacitySource: 'runtime-instruction', cumulativeSource: 'spawn-events' },
        };
        const fixtures = [...roots, ...children, grandchild];
        window.__loadtoagentDensityFixture = { fixtures, focusId: roots[0].id, terminalId: directTerminal.id };
        window.__ensureLoadToAgentDensityFixture = () => {
          const current = window.LoadToAgentApp.state.snapshot && window.LoadToAgentApp.state.snapshot.sessions || [];
          const ids = new Set(current.map(item => item.id));
          for (const fixture of fixtures) if (!ids.has(fixture.id)) current.unshift(fixture);
        };
        window.__ensureLoadToAgentDensityFixture();
        window.LoadToAgentApp.state.graphFocusId = null;
        window.LoadToAgentApp.state.graphExpandedProviders.clear();
        window.LoadToAgentApp.renderSessions();
        document.querySelector('.main-stage')?.scrollTo(0, 0);
        return { focusId: roots[0].id, terminalId: directTerminal.id, alternateTerminalId: alternateTerminal.id };
      })()`);
      const densityFocusId = densitySetup.focusId;
      const commandTerminalId = densitySetup.terminalId;
      const alternateCommandTerminalId = densitySetup.alternateTerminalId;
      await new Promise(resolve => setTimeout(resolve, 250));
      const treeImage = await win.webContents.capturePage();
      const treeOutput = path.join(outputDir, 'loadtoagent-agent-tree.png');
      fs.writeFileSync(treeOutput, treeImage.toPNG());
      const densityMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = null;
        window.LoadToAgentApp.state.graphExpandedProviders.clear();
        window.LoadToAgentApp.renderSessions();
        const grid = document.querySelector('#liveSessionGrid');
        const before = document.querySelectorAll('.agent-flow-row').length;
        const more = document.querySelector('.agent-flow-more[data-graph-provider-more]');
        more?.click();
        const expanded = document.querySelectorAll('.agent-flow-row').length;
        document.querySelector('.agent-flow-more[data-graph-provider-less]')?.click();
        return {
          lanes: document.querySelectorAll('.agent-flow-lane').length,
          visibleFlows: before,
          expandedFlows: expanded,
          moreButtons: document.querySelectorAll('[data-graph-provider-more]').length,
          runtimeSegments: document.querySelectorAll('.runtime-segment').length,
          tmuxRuntimeCards: document.querySelectorAll('.tmux-runtime .live-tmux-card').length,
          tmuxAiPanes: Number(window.LoadToAgentApp.state.snapshot?.tmux?.summary?.aiPanes || 0),
          tmuxFirst: document.querySelector('.runtime-segment:first-child')?.classList.contains('tmux-runtime') || false,
          noHorizontalOverflow: grid ? grid.scrollWidth <= grid.clientWidth + 2 : false,
          subagentTabRemoved: !document.querySelector('[data-view="subagents"]'),
        };
      })()`);
      if (!densityMetrics.subagentTabRemoved || densityMetrics.runtimeSegments !== 2 || densityMetrics.tmuxRuntimeCards !== densityMetrics.tmuxAiPanes || !densityMetrics.tmuxFirst || densityMetrics.lanes < 4 || densityMetrics.visibleFlows > densityMetrics.lanes * 6 || densityMetrics.moreButtons < 1 || densityMetrics.expandedFlows <= densityMetrics.visibleFlows || !densityMetrics.noHorizontalOverflow) {
        throw new Error(`대규모 에이전트 지도 밀도 조절이 올바르지 않습니다: ${JSON.stringify(densityMetrics)}`);
      }
      if (densityFocusId) {
        await win.webContents.executeJavaScript(`(() => {
          window.__ensureLoadToAgentDensityFixture?.();
          window.LoadToAgentApp.renderSessions();
          document.querySelector('[data-graph-focus="${densityFocusId}"]')?.click();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const directMarker = `LOADTOAGENT_AGENT_DIRECT_${Date.now()}`;
      const commandUiMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.renderSessions();
        const session = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === ${JSON.stringify(densityFocusId)});
        const targets = window.LoadToAgentTerminal.agentTargets(session);
        const form = document.querySelector('[data-agent-command-form="${densityFocusId}"]');
        const input = form?.querySelector('[data-agent-command-draft]');
        const picker = form?.querySelector('[data-agent-command-target]');
        const initiallyDisabled = form?.querySelector('[type="submit"]')?.disabled || false;
        if (picker) {
          picker.value = ${JSON.stringify(commandTerminalId)};
          picker.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (input) {
          input.value = ${JSON.stringify(markerCommand(directMarker))};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          form.requestSubmit();
        }
        return {
          formVisible: Boolean(form),
          connected: form?.classList.contains('connected') || false,
          targetCount: targets.length,
          targetIds: targets.map(target => target.terminalId).filter(Boolean),
          pickerVisible: Boolean(picker),
          initiallyDisabled,
          selectedTargetId: picker?.value || '',
          maxLength: input?.maxLength || 0,
        };
      })()`);
      const directReplay = await waitForRenderer(win, `(async () => { const value = await window.loadtoagent.terminalGet(${JSON.stringify(commandTerminalId)}); return value?.replay.includes(${JSON.stringify(directMarker)}) ? value.replay : ''; })()`, 50, 200);
      if (!commandUiMetrics.formVisible || !commandUiMetrics.connected || commandUiMetrics.targetCount !== 2 || !commandUiMetrics.targetIds.includes(commandTerminalId) || !commandUiMetrics.targetIds.includes(alternateCommandTerminalId) || !commandUiMetrics.pickerVisible || !commandUiMetrics.initiallyDisabled || commandUiMetrics.selectedTargetId !== commandTerminalId || commandUiMetrics.maxLength !== 8000 || !directReplay) {
        throw new Error(`선택한 AI의 터미널 직접 지시가 올바르지 않습니다: ${JSON.stringify(commandUiMetrics)}`);
      }
      const openDraft = '이 문장을 터미널 입력창에서 이어서 작성';
      await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.renderSessions();
        const input = document.querySelector('[data-agent-command-draft="${densityFocusId}"]');
        if (input) {
          input.value = ${JSON.stringify(openDraft)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        document.querySelector('[data-agent-terminal-open="${densityFocusId}"]')?.click();
      })()`);
      const terminalOpenReady = await waitForRenderer(win, `(() => window.LoadToAgentApp.state.view === 'terminal' && document.querySelector('.terminal-session-item.active')?.dataset.terminalId === ${JSON.stringify(commandTerminalId)} && document.querySelector('#terminalCommandInput')?.value === ${JSON.stringify(openDraft)})()`);
      if (!terminalOpenReady) throw new Error('선택한 AI에서 정확한 일반 터미널과 지시 초안을 열지 못했습니다.');
      const sessionTerminalMetrics = await win.webContents.executeJavaScript(`(() => ({
        historyVisible: !document.querySelector('#terminalHistoryPanel')?.classList.contains('hidden'),
        historyMessages: document.querySelectorAll('.terminal-history-message').length,
        historyTitle: document.querySelector('#terminalHistoryTitle')?.textContent || '',
        bindingCopy: document.querySelector('#terminalTargetMeta span')?.textContent || '',
        activeTerminalId: document.querySelector('.terminal-session-item.active')?.dataset.terminalId || '',
        inputCopy: document.querySelector('#terminalCommandLabel')?.textContent || '',
        inputEnabled: !document.querySelector('#terminalCommandInput')?.disabled,
        composerVisible: (() => { const rect = document.querySelector('#terminalCommandForm')?.getBoundingClientRect(); return Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight + 2); })(),
        composerRect: (() => { const rect = document.querySelector('#terminalCommandForm')?.getBoundingClientRect(); return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null; })(),
        layoutRect: (() => { const rect = document.querySelector('#terminalSection .terminal-layout')?.getBoundingClientRect(); return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null; })(),
        viewportHeight: window.innerHeight,
        stageScrollTop: document.querySelector('.main-stage')?.scrollTop || 0,
        currentView: document.body.dataset.currentView || '',
        consoleVisible: (() => { const rect = document.querySelector('.terminal-console-pane')?.getBoundingClientRect(); return Boolean(rect && rect.width > 500 && rect.height > 400); })(),
      }))()`);
      if (!sessionTerminalMetrics.historyVisible || sessionTerminalMetrics.historyMessages < 1 || !sessionTerminalMetrics.bindingCopy.includes('기존 AI 세션 유지 중') || sessionTerminalMetrics.activeTerminalId !== commandTerminalId || sessionTerminalMetrics.inputCopy !== 'AI에게 이어서 지시' || !sessionTerminalMetrics.inputEnabled || !sessionTerminalMetrics.composerVisible || !sessionTerminalMetrics.consoleVisible) {
        throw new Error(`기존 AI 세션 대화와 터미널 결합 화면이 올바르지 않습니다: ${JSON.stringify(sessionTerminalMetrics)}`);
      }
      const continuityMetrics = await win.webContents.executeJavaScript(`(async () => {
        const before = await window.loadtoagent.terminalList();
        document.querySelector('[data-terminal-id="${alternateCommandTerminalId}"]')?.click();
        await new Promise(resolve => setTimeout(resolve, 80));
        const alternateInput = document.querySelector('#terminalCommandInput');
        if (alternateInput) {
          alternateInput.value = '다른 터미널 전용 초안';
          alternateInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        document.querySelector('[data-terminal-id="${commandTerminalId}"]')?.click();
        await new Promise(resolve => setTimeout(resolve, 80));
        const after = await window.loadtoagent.terminalList();
        return {
          sameSessionCount: before.length === after.length,
          sameSessionIds: before.every(item => after.some(next => next.id === item.id && next.pid === item.pid)),
          activeTerminalId: document.querySelector('.terminal-session-item.active')?.dataset.terminalId || '',
          restoredDraft: document.querySelector('#terminalCommandInput')?.value || '',
          historyVisibleAfterReturn: !document.querySelector('#terminalHistoryPanel')?.classList.contains('hidden'),
        };
      })()`);
      if (!continuityMetrics.sameSessionCount || !continuityMetrics.sameSessionIds || continuityMetrics.activeTerminalId !== commandTerminalId || continuityMetrics.restoredDraft !== openDraft || !continuityMetrics.historyVisibleAfterReturn) {
        throw new Error(`터미널 탭 이동 후 기존 세션과 입력 초안이 유지되지 않았습니다: ${JSON.stringify(continuityMetrics)}`);
      }
      const sessionTerminalImage = await captureStableState(win,
        `(() => {
          document.querySelector('#runModal')?.classList.add('hidden');
          document.querySelector('#drawerBackdrop')?.classList.add('hidden');
          document.querySelector('#detailDrawer')?.classList.remove('open');
          document.querySelector('.main-stage')?.scrollTo(0, 0);
        })()`,
        `(() => {
          const section = document.querySelector('#terminalSection');
          const composer = document.querySelector('#terminalCommandForm')?.getBoundingClientRect();
          return Boolean(section && !section.classList.contains('hidden')
            && !document.querySelector('#terminalHistoryPanel')?.classList.contains('hidden')
            && document.querySelector('#drawerBackdrop')?.classList.contains('hidden')
            && composer && composer.top >= 0 && composer.bottom <= window.innerHeight + 2);
        })()`, 12);
      const sessionTerminalOutput = path.join(outputDir, 'loadtoagent-session-terminal.png');
      fs.writeFileSync(sessionTerminalOutput, sessionTerminalImage.toPNG());
      setTestWindowSize(win, 1180, 900);
      const terminalCompactImage = await captureStableState(win,
        "document.querySelector('.main-stage')?.scrollTo(0, 0)",
        `(() => {
          const section = document.querySelector('#terminalSection');
          return Boolean(section && !section.classList.contains('hidden')
            && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2);
        })()`, 12);
      const terminalCompactMetrics = await win.webContents.executeJavaScript(`(() => {
        const resource = document.querySelector('#terminalSection .terminal-resource-panel')?.getBoundingClientRect();
        const workbench = document.querySelector('#terminalWorkbench')?.getBoundingClientRect();
        const composer = document.querySelector('#terminalCommandForm')?.getBoundingClientRect();
        const actionButtons = [...document.querySelectorAll('#terminalSection .terminal-key-actions button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
        return {
          width: window.innerWidth,
          resourceRect: resource ? { top: resource.top, bottom: resource.bottom, width: resource.width } : null,
          workbenchRect: workbench ? { top: workbench.top, bottom: workbench.bottom, width: workbench.width } : null,
          composerRect: composer ? { top: composer.top, bottom: composer.bottom, width: composer.width } : null,
          sessionStripAboveWorkbench: Boolean(resource && workbench && resource.bottom <= workbench.top + 2),
          composerVisible: Boolean(composer && composer.top >= 0 && composer.bottom <= window.innerHeight + 2),
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
          historyBesideConsole: (() => {
            const history = document.querySelector('#terminalHistoryPanel')?.getBoundingClientRect();
            const consolePane = document.querySelector('.terminal-console-pane')?.getBoundingClientRect();
            return Boolean(history && consolePane && history.right <= consolePane.left + 2);
          })(),
          actionsVisible: Boolean(workbench && actionButtons.length >= 3 && actionButtons.every(rect => rect.left >= workbench.left - 1 && rect.right <= workbench.right + 1 && rect.top >= workbench.top - 1 && rect.bottom <= workbench.bottom + 1)),
          actionLabels: actionButtons.map(item => item.text),
        };
      })()`);
      if (!terminalCompactMetrics.sessionStripAboveWorkbench || !terminalCompactMetrics.composerVisible || !terminalCompactMetrics.noHorizontalOverflow || !terminalCompactMetrics.historyBesideConsole || !terminalCompactMetrics.actionsVisible || !terminalCompactMetrics.actionLabels.some(label => label.includes('세션 종료'))) throw new Error(`중간 너비 세션 터미널 배치가 올바르지 않습니다: ${JSON.stringify(terminalCompactMetrics)}`);
      const terminalCompactOutput = path.join(outputDir, 'loadtoagent-session-terminal-compact.png');
      fs.writeFileSync(terminalCompactOutput, terminalCompactImage.toPNG());
      setTestWindowSize(win, 1600, 980);
      await new Promise(resolve => setTimeout(resolve, 350));
      await win.webContents.executeJavaScript(`(() => {
        window.LoadToAgentApp.state.agentCommandDrafts.delete(${JSON.stringify(densityFocusId)});
        document.querySelector('[data-view="all"]')?.click();
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.renderSessions();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 300));
      const motionMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = null;
        window.LoadToAgentApp.renderSessions();
        document.querySelector('[data-graph-focus="${densityFocusId}"]')?.click();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        const path = document.querySelector('.agent-workflow-edge');
        window.LoadToAgentApp.openRunModal();
        const modalOpening = document.querySelector('.run-modal')?.getAnimations().some(animation => animation.animationName === 'motion-modal-in') || false;
        window.LoadToAgentApp.closeRunModal();
        window.LoadToAgentApp.openDrawer(${JSON.stringify(densityFocusId)});
        window.LoadToAgentApp.closeDrawer();
        return {
          reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
          preferenceMatches: document.documentElement.dataset.motion === (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full'),
          lastMotion: document.documentElement.dataset.lastMotion,
          keyedElements: document.querySelectorAll('[data-motion-key]').length,
          workflowAnimated: document.querySelector('.agent-workflow-canvas')?.classList.contains('motion-connect') || false,
          pathLength: path?.getAttribute('pathLength') || '',
          edgeAnimation: path?.getAnimations().some(animation => animation.animationName === 'motion-edge-draw') || false,
          modalOpening,
          modalClosingDeferred: document.querySelector('#runModal')?.classList.contains('closing') && !document.querySelector('#runModal')?.classList.contains('hidden'),
          drawerClosingDeferred: document.querySelector('#drawerBackdrop')?.classList.contains('closing') && !document.querySelector('#drawerBackdrop')?.classList.contains('hidden'),
        };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 950));
      const motionClosedMetrics = await win.webContents.executeJavaScript(`(() => ({
        modalHidden: document.querySelector('#runModal')?.classList.contains('hidden') || false,
        drawerBackdropHidden: document.querySelector('#drawerBackdrop')?.classList.contains('hidden') || false,
      }))()`);
      if (!motionMetrics.preferenceMatches || motionMetrics.lastMotion !== 'focus' || motionMetrics.keyedElements < 10 || !motionMetrics.workflowAnimated || motionMetrics.pathLength !== '1' || (!motionMetrics.reduced && !motionMetrics.edgeAnimation) || !motionMetrics.modalOpening || !motionMetrics.modalClosingDeferred || !motionMetrics.drawerClosingDeferred || !motionClosedMetrics.modalHidden || !motionClosedMetrics.drawerBackdropHidden) {
        throw new Error(`부드러운 화면 전환 모션이 올바르지 않습니다: ${JSON.stringify({ ...motionMetrics, ...motionClosedMetrics })}`);
      }
      const focusImage = await captureStableState(win, `(() => {
        document.querySelector('#closeDrawerBtn')?.click();
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.state.expandedCompletedSubagents.delete(${JSON.stringify(densityFocusId)});
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        document.querySelector('.main-stage')?.scrollTo(0, 0);
      })()`, `window.LoadToAgentApp.state.graphFocusId === ${JSON.stringify(densityFocusId)} && document.querySelectorAll('.downstream-column .agent-workflow-node').length === 0 && document.querySelector('[data-subagent-completed-toggle]') && !document.querySelector('[data-completed-subagent-list]') && !document.querySelector('[data-subagent-search], [data-subagent-provider], [data-subagent-status]') && !document.querySelector('#detailDrawer')?.classList.contains('open') && document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`);
      const focusOutput = path.join(outputDir, 'loadtoagent-agent-focus.png');
      fs.writeFileSync(focusOutput, focusImage.toPNG());
      const metrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        if (window.__loadtoagentDensityFixture) window.LoadToAgentApp.state.graphFocusId = window.__loadtoagentDensityFixture.focusId;
        window.LoadToAgentApp.state.expandedCompletedSubagents.add(${JSON.stringify(densityFocusId)});
        window.LoadToAgentApp.renderSessions();
        const start = performance.now();
        for (let index = 0; index < 5; index += 1) window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        const grid = document.querySelector('#liveSessionGrid');
        const upstream = document.querySelector('.upstream-column .agent-workflow-origin, .upstream-column .agent-workflow-node')?.getBoundingClientRect();
        const selected = document.querySelector('.agent-workflow-selected')?.getBoundingClientRect();
        const downstream = document.querySelector('.downstream-column .agent-workflow-node')?.getBoundingClientRect();
        const downstreamCards = [...document.querySelectorAll('.downstream-column .agent-workflow-node')].map(node => node.getBoundingClientRect());
        const upstreamPort = document.querySelector('[data-workflow-port="upstream-output"]')?.getBoundingClientRect();
        const focusInputPort = document.querySelector('[data-workflow-port="focus-input"]')?.getBoundingClientRect();
        const groupPort = document.querySelector('[data-workflow-port="children-group-input"]')?.getBoundingClientRect();
        const downstreamColumns = new Set(downstreamCards.map(rect => Math.round(rect.left / 8))).size;
        const canvasRect = document.querySelector('.agent-workflow-canvas')?.getBoundingClientRect();
        let routeCollisions = 0;
        const routeCollisionDetails = [];
        if (canvasRect) {
          const localCards = downstreamCards.map(rect => ({ left: rect.left - canvasRect.left + 4, right: rect.right - canvasRect.left - 4, top: rect.top - canvasRect.top + 4, bottom: rect.bottom - canvasRect.top - 4 }));
          for (const path of document.querySelectorAll('.agent-workflow-edge.downstream')) {
            const length = path.getTotalLength();
            for (let sample = 1; sample < 20; sample += 1) {
              const point = path.getPointAtLength(length * sample / 20);
              const cardIndex = localCards.findIndex(rect => point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom);
              if (cardIndex >= 0) { routeCollisions += 1; routeCollisionDetails.push({ kind: path.dataset.workflowEdgeKind, cardIndex, x: Math.round(point.x), y: Math.round(point.y) }); break; }
            }
          }
        }
        return {
          averageRenderMs: (performance.now() - start) / 5,
          renderedCards: document.querySelectorAll('.session-card').length,
          liveNodes: document.querySelectorAll('.live-session-grid .agent-node').length,
          graphFocused: Boolean(window.LoadToAgentApp.state.graphFocusId),
          breadcrumbSteps: document.querySelectorAll('#graphBreadcrumbs button').length,
          workflowCanvas: document.querySelectorAll('.agent-workflow-canvas').length,
          upstreamNodes: document.querySelectorAll('.upstream-column .agent-workflow-origin, .upstream-column .agent-workflow-node').length,
          selectedNodes: document.querySelectorAll('.selected-column .agent-node').length,
          downstreamNodes: document.querySelectorAll('.downstream-column .agent-workflow-node').length,
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
          downstreamGroups: document.querySelectorAll('.agent-workflow-edge.downstream.group').length,
          downstreamColumns,
          summaryChips: document.querySelectorAll('.workflow-summary-chip').length,
          routeCollisions,
          routeCollisionDetails,
          ports: document.querySelectorAll('.agent-workflow-port').length,
          groupArrowheads: document.querySelectorAll('.agent-workflow-edge.downstream.group[marker-end]').length,
          upstreamAligned: Boolean(upstreamPort && focusInputPort && Math.abs((upstreamPort.top + upstreamPort.height / 2) - (focusInputPort.top + focusInputPort.height / 2)) <= 12),
          groupPortInsideCanvas: Boolean(canvasRect && groupPort && groupPort.left >= canvasRect.left && groupPort.right <= canvasRect.right && groupPort.top >= canvasRect.top && groupPort.bottom <= canvasRect.bottom),
          collaborationMetrics: [...document.querySelectorAll('[data-collaboration-metric]')].reduce((out, node) => { out[node.dataset.collaborationMetric] = node.querySelector('b')?.textContent?.trim(); return out; }, {}),
          collaborationCommunications: Number(document.querySelector('[data-collaboration-communications]')?.dataset.collaborationCommunications || 0),
          collaborationAssignments: document.querySelectorAll('[data-communication-kind="assignment"]').length,
          collaborationResults: document.querySelectorAll('[data-communication-kind="result"]').length,
          delegatedTaskCards: document.querySelectorAll('.downstream-column .agent-flow-outcome').length,
          readableSessionCards: document.querySelectorAll('.downstream-column .child-session .agent-flow-session-title').length,
          sessionAgentRows: document.querySelectorAll('.downstream-column .child-session .agent-flow-agent').length,
          workingSubagents: document.querySelectorAll('.downstream-column .child-session.work-working').length,
          restingSubagents: document.querySelectorAll('.downstream-column .child-session.work-resting').length,
          conversationCards: document.querySelectorAll('.downstream-column [data-open-subagent-chat]').length,
          nestedFlowCards: document.querySelectorAll('.downstream-column [data-graph-focus]').length,
          completedToggle: Boolean(document.querySelector('[data-subagent-completed-toggle]')),
          completedExpanded: Boolean(document.querySelector('[data-completed-subagent-list]')),
          legacyFilters: document.querySelectorAll('[data-subagent-status], [data-subagent-provider], [data-subagent-search]').length,
          tmuxBadges: document.querySelectorAll('.downstream-column .execution-mode-badge.tmux').length,
          standardBadges: document.querySelectorAll('.downstream-column .execution-mode-badge.standard').length,
          recentSubagents: [...document.querySelectorAll('#sessionGrid [data-session-id]')].filter(node => window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === node.dataset.sessionId)?.parentId).length,
          desktopDirectionFixed: Boolean(upstream && selected && downstream && upstream.right < selected.left && selected.right < downstream.left),
          noHorizontalOverflow: grid ? grid.scrollWidth <= grid.clientWidth + 2 : false,
        };
      })()`);
      if (!metrics.graphFocused || metrics.liveNodes !== 1 || metrics.workflowCanvas !== 1 || metrics.upstreamNodes !== 1 || metrics.selectedNodes !== 1 || metrics.downstreamNodes !== 10 || metrics.connectionPaths !== 2 || metrics.downstreamGroups !== 1 || metrics.groupArrowheads !== 1 || metrics.downstreamColumns < 2 || metrics.summaryChips < 1 || metrics.routeCollisions !== 0 || metrics.ports !== 4 || !metrics.upstreamAligned || !metrics.groupPortInsideCanvas || metrics.collaborationMetrics.created !== '10' || metrics.collaborationMetrics.capacity !== '3' || metrics.collaborationMetrics.running !== '0' || metrics.collaborationMetrics.completed !== '10' || metrics.collaborationCommunications !== 30 || metrics.collaborationAssignments !== 10 || metrics.collaborationResults !== 10 || metrics.delegatedTaskCards !== 10 || metrics.readableSessionCards !== 10 || metrics.sessionAgentRows !== 10 || metrics.workingSubagents !== 0 || metrics.restingSubagents !== 10 || metrics.conversationCards !== 9 || metrics.nestedFlowCards !== 1 || !metrics.completedToggle || !metrics.completedExpanded || metrics.legacyFilters !== 0 || metrics.tmuxBadges !== 1 || metrics.standardBadges !== 9 || metrics.recentSubagents !== 0 || !metrics.desktopDirectionFixed || !metrics.noHorizontalOverflow || metrics.averageRenderMs > 250) throw new Error(`연결형 에이전트 작업 흐름이 올바르지 않습니다: ${JSON.stringify(metrics)}`);

      const communicationImage = await captureStableState(win, `(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        document.querySelector('.agent-communication-panel')?.scrollIntoView({ block: 'start' });
      })()`, `window.LoadToAgentApp.state.graphFocusId === ${JSON.stringify(densityFocusId)} && document.querySelectorAll('.agent-communication-event').length === 30 && (() => { const rect = document.querySelector('.agent-communication-panel')?.getBoundingClientRect(); return rect && rect.bottom > 0 && rect.top < innerHeight; })()`);
      const communicationOutput = path.join(outputDir, 'loadtoagent-agent-communication.png');
      fs.writeFileSync(communicationOutput, communicationImage.toPNG());

      const childClick = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        const child = document.querySelector('.downstream-column [data-graph-focus]');
        child?.click();
        return { childId: child?.dataset.graphFocus || '', immediateFocusId: window.LoadToAgentApp.state.graphFocusId };
      })()`);
      const childFocusId = childClick.childId;
      if (!childFocusId || childClick.immediateFocusId !== childFocusId) throw new Error(`나눠 맡긴 AI 선택 이벤트가 적용되지 않았습니다: ${JSON.stringify(childClick)}`);
      await new Promise(resolve => setTimeout(resolve, 450));
      const childMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(childFocusId)};
        window.LoadToAgentApp.state.expandedCompletedSubagents.add(${JSON.stringify(childFocusId)});
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        const upstream = document.querySelector('.upstream-column .agent-workflow-node')?.getBoundingClientRect();
        const selected = document.querySelector('.agent-workflow-selected')?.getBoundingClientRect();
        return {
          focusId: window.LoadToAgentApp.state.graphFocusId,
          parentId: document.querySelector('.upstream-column [data-graph-focus]')?.dataset.graphFocus || '',
          parentOnLeft: Boolean(upstream && selected && upstream.right < selected.left),
          downstreamNodes: document.querySelectorAll('.downstream-column .agent-workflow-node').length,
          emptyShown: Boolean(document.querySelector('.downstream-column .agent-workflow-empty')),
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
          resumeReady: document.querySelector('.agent-command-panel')?.classList.contains('resume-ready') || false,
          commandEnabled: document.querySelector('[data-agent-command-draft]')?.disabled === false,
          resumeMode: document.querySelector('.agent-command-panel')?.classList.contains('control-resume') || false,
          bridgeCopyVisible: Boolean(document.querySelector('[data-agent-bridge-copy]')),
          communicationEvents: Number(document.querySelector('[data-collaboration-communications]')?.dataset.collaborationCommunications || 0),
        };
      })()`);
      const childFocusImage = await captureStableState(win, `(() => {
        document.querySelector('#closeDrawerBtn')?.click();
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(childFocusId)};
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        document.querySelector('.main-stage')?.scrollTo(0, 0);
      })()`, `window.LoadToAgentApp.state.graphFocusId === ${JSON.stringify(childFocusId)} && document.querySelector('.upstream-column [data-graph-focus]')?.dataset.graphFocus === ${JSON.stringify(densityFocusId)} && !document.querySelector('#detailDrawer')?.classList.contains('open') && document.querySelector('#drawerBackdrop')?.classList.contains('hidden')`);
      const childFocusOutput = path.join(outputDir, 'loadtoagent-agent-child-focus.png');
      fs.writeFileSync(childFocusOutput, childFocusImage.toPNG());
      if (childMetrics.focusId !== childFocusId || childMetrics.parentId !== densityFocusId || !childMetrics.parentOnLeft || childMetrics.downstreamNodes !== 1 || !childMetrics.emptyShown || childMetrics.connectionPaths !== 2 || !childMetrics.resumeReady || !childMetrics.commandEnabled || !childMetrics.resumeMode || childMetrics.bridgeCopyVisible || childMetrics.communicationEvents !== 3) throw new Error(`중첩 도움 AI 선택 후 부모 방향·재개 상태·하위 통신 기록이 올바르지 않습니다: ${JSON.stringify(childMetrics)}`);

      const controlStateMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        const inspect = id => {
          window.LoadToAgentApp.state.graphFocusId = id;
          window.LoadToAgentApp.renderSessions();
          const panel = document.querySelector('.agent-command-panel');
          return {
            classes: panel?.className || '',
            status: panel?.querySelector('header small')?.textContent || '',
            origin: Boolean(panel?.querySelector('[data-agent-open-origin]')),
            bridge: Boolean(panel?.querySelector('[data-agent-bridge-copy]')),
            enabledTextarea: panel?.querySelector('textarea')?.disabled === false,
          };
        };
        const sessions = window.LoadToAgentApp.state.snapshot.sessions || [];
        const connectSession = sessions.find(item => item.id === 'visual-density:child:0');
        const previousConnectStatus = connectSession?.status;
        const previousConnectProvider = connectSession?.provider;
        if (connectSession) connectSession.status = 'running';
        if (connectSession) connectSession.provider = 'grok';
        const connect = inspect('visual-density:child:0');
        if (connectSession) connectSession.status = previousConnectStatus;
        if (connectSession) connectSession.provider = previousConnectProvider;
        const originSession = sessions.find(item => item.id === 'visual-density:child:1');
        const previousOriginStatus = originSession?.status;
        if (originSession) originSession.status = 'running';
        const origin = inspect('visual-density:child:1');
        if (originSession) originSession.status = previousOriginStatus;
        const originResume = inspect('visual-density:child:1');
        const resume = inspect('visual-density:child:2');
        const handoffSession = sessions.find(item => item.id === 'visual-density:child:4');
        const previousHandoffStatus = handoffSession?.status;
        const previousHandoffProvider = handoffSession?.provider;
        if (handoffSession) { handoffSession.status = 'running'; handoffSession.provider = 'codex'; }
        const handoff = inspect('visual-density:child:4');
        if (handoffSession) { handoffSession.status = previousHandoffStatus; handoffSession.provider = previousHandoffProvider; }
        const endedSession = sessions.find(item => item.id === 'visual-density:child:3');
        const previousEndedProvider = endedSession?.provider;
        if (endedSession) endedSession.provider = 'grok';
        const ended = inspect('visual-density:child:3');
        if (endedSession) endedSession.provider = previousEndedProvider;
        return {
          connect,
          origin,
          originResume,
          resume,
          handoff,
          ended,
        };
      })()`);
      if (!controlStateMetrics.connect.classes.includes('control-connect') || !controlStateMetrics.connect.bridge || !controlStateMetrics.origin.classes.includes('control-origin') || !controlStateMetrics.origin.origin || !controlStateMetrics.originResume.classes.includes('control-origin-resume') || !controlStateMetrics.originResume.origin || !controlStateMetrics.originResume.enabledTextarea || !controlStateMetrics.resume.classes.includes('control-resume') || !controlStateMetrics.resume.enabledTextarea || !controlStateMetrics.handoff.classes.includes('control-handoff') || !controlStateMetrics.handoff.enabledTextarea || !controlStateMetrics.ended.classes.includes('control-ended') || controlStateMetrics.ended.origin || controlStateMetrics.ended.bridge || controlStateMetrics.ended.enabledTextarea) throw new Error(`AI 입력·재개 상태 UI가 올바르지 않습니다: ${JSON.stringify(controlStateMetrics)}`);

      const returnClick = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(childFocusId)};
        window.LoadToAgentApp.state.expandedCompletedSubagents.add(${JSON.stringify(childFocusId)});
        window.LoadToAgentApp.renderSessions();
        const parent = document.querySelector('.upstream-column [data-graph-focus]');
        parent?.click();
        return { parentId: parent?.dataset.graphFocus || '', immediateFocusId: window.LoadToAgentApp.state.graphFocusId };
      })()`);
      if (returnClick.parentId !== densityFocusId || returnClick.immediateFocusId !== densityFocusId) throw new Error(`메인 AI로 돌아가기 이벤트가 적용되지 않았습니다: ${JSON.stringify(returnClick)}`);
      await new Promise(resolve => setTimeout(resolve, 450));
      const returnMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        if (window.LoadToAgentApp.state.graphFocusId !== ${JSON.stringify(densityFocusId)}) { window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)}; window.LoadToAgentApp.renderSessions(); }
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        return {
          focusId: window.LoadToAgentApp.state.graphFocusId,
          originVisible: Boolean(document.querySelector('.upstream-column .agent-workflow-origin')),
          downstreamNodes: document.querySelectorAll('.downstream-column .agent-workflow-node').length,
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
          downstreamGroups: document.querySelectorAll('.agent-workflow-edge.downstream.group').length,
        };
      })()`);
      if (returnMetrics.focusId !== densityFocusId || !returnMetrics.originVisible || returnMetrics.downstreamNodes !== 10 || returnMetrics.downstreamGroups !== 1 || returnMetrics.connectionPaths !== 2) throw new Error(`메인 AI로 돌아온 뒤 연결 흐름이 복원되지 않았습니다: ${JSON.stringify(returnMetrics)}`);

      const subagentStateImage = await captureStableState(win, `(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        const child = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'visual-density:child:9');
        if (child) { child.status = 'running'; child.statusDetail = '추가 검증 작업 수행 중'; child.completionObserved = false; child.completedAt = null; }
        const root = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === ${JSON.stringify(densityFocusId)});
        if (root?.collaboration?.metrics) { root.collaboration.metrics.currentlyRunning = 1; root.collaboration.metrics.completedRecords = 9; }
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.state.expandedCompletedSubagents.delete(${JSON.stringify(densityFocusId)});
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        document.querySelector('.main-stage')?.scrollTo(0, 0);
      })()`, `document.querySelectorAll('.child-session.work-working').length === 1 && document.querySelectorAll('.child-session.work-resting').length === 0 && document.querySelector('[data-subagent-completed-toggle]') && document.querySelector('.child-session.work-working .execution-mode-badge.tmux') && !document.querySelector('[data-completed-subagent-list]')`);
      const subagentStateOutput = path.join(outputDir, 'loadtoagent-subagent-work-states.png');
      fs.writeFileSync(subagentStateOutput, subagentStateImage.toPNG());
      await win.webContents.executeJavaScript(`(() => {
        const child = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === 'visual-density:child:9');
        if (child) { child.status = 'completed'; child.statusDetail = '작업 완료'; child.completionObserved = true; child.completedAt = child.updatedAt; }
        const root = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === ${JSON.stringify(densityFocusId)});
        if (root?.collaboration?.metrics) { root.collaboration.metrics.currentlyRunning = 0; root.collaboration.metrics.completedRecords = 10; }
        window.LoadToAgentApp.renderSessions();
      })()`);

      const subagentConversationImage = await captureStableState(win, `(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.state.expandedCompletedSubagents.add(${JSON.stringify(densityFocusId)});
        const root = window.LoadToAgentApp.state.snapshot.sessions.find(item => item.id === ${JSON.stringify(densityFocusId)});
        const longEvent = root?.collaboration?.communications?.find(item => item.childId === 'visual-density:child:2' && item.kind === 'assignment');
        if (longEvent) {
          longEvent.text = '아주 긴 서브에이전트 작업 지시 내용 '.repeat(80);
          longEvent.protected = false;
        }
        window.LoadToAgentApp.renderSessions();
        document.querySelector('.downstream-column [data-open-subagent-chat="visual-density:child:2"]')?.click();
      })()`, `window.LoadToAgentApp.state.graphFocusId === ${JSON.stringify(densityFocusId)} && window.LoadToAgentApp.state.drawerMode === 'subagent' && document.querySelector('[data-subagent-work-messages="1"]') && document.querySelector('[data-subagent-coordination-count="2"]') && document.querySelectorAll('.drawer-tab:not(.hidden)').length === 1 && document.querySelector('[data-resume-agent]')`);
      const subagentConversationOutput = path.join(outputDir, 'loadtoagent-subagent-conversation.png');
      fs.writeFileSync(subagentConversationOutput, subagentConversationImage.toPNG());
      const subagentConversationMetrics = await win.webContents.executeJavaScript(`(() => ({ focusId: window.LoadToAgentApp.state.graphFocusId, drawerMode: window.LoadToAgentApp.state.drawerMode, workMessages: Number(document.querySelector('[data-subagent-work-messages]')?.dataset.subagentWorkMessages || 0), coordinationEvents: document.querySelectorAll('[data-subagent-communication]').length, coordinationCollapsed: !document.querySelector('.subagent-coordination')?.open, visibleTabs: document.querySelectorAll('.drawer-tab:not(.hidden)').length, resumeAvailable: Boolean(document.querySelector('[data-resume-agent]')), actualWorkVisible: document.querySelector('#drawerContent')?.innerText.includes('동시에 실행되는 작업의 상태를 확인하고 있습니다.') || false, placeholderNoise: /보호된 메시지|내용 없이 통신 상태|서브에이전트 실행이 시작/.test(document.querySelector('#drawerContent')?.innerText || ''), drawerOverflow: document.querySelector('#detailDrawer')?.scrollWidth > document.querySelector('#detailDrawer')?.clientWidth + 2 }))()`);
      if (subagentConversationMetrics.focusId !== densityFocusId || subagentConversationMetrics.drawerMode !== 'subagent' || subagentConversationMetrics.workMessages !== 1 || subagentConversationMetrics.coordinationEvents !== 2 || !subagentConversationMetrics.coordinationCollapsed || subagentConversationMetrics.visibleTabs !== 1 || !subagentConversationMetrics.resumeAvailable || !subagentConversationMetrics.actualWorkVisible || subagentConversationMetrics.placeholderNoise || subagentConversationMetrics.drawerOverflow) throw new Error(`서브에이전트 실제 작업 상세가 올바르지 않습니다: ${JSON.stringify(subagentConversationMetrics)}`);
      await win.webContents.executeJavaScript("document.querySelector('#closeDrawerBtn')?.click()");

      setTestWindowSize(win, 1080, 700);
      await new Promise(resolve => setTimeout(resolve, 450));
      const workflowCompactMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.state.expandedCompletedSubagents.add(${JSON.stringify(densityFocusId)});
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        const stage = document.querySelector('.main-stage');
        const selectedTarget = document.querySelector('.agent-workflow-selected');
        if (stage && selectedTarget) {
          const stageTop = stage.getBoundingClientRect().top;
          stage.scrollTo(0, Math.max(0, stage.scrollTop + selectedTarget.getBoundingClientRect().top - stageTop - 12));
        }
        const upstream = document.querySelector('.upstream-column')?.getBoundingClientRect();
        const selected = document.querySelector('.selected-column')?.getBoundingClientRect();
        const downstream = document.querySelector('.downstream-column')?.getBoundingClientRect();
        const selectedCard = document.querySelector('.agent-workflow-selected')?.getBoundingClientRect();
        const selectedCurrent = document.querySelector('.agent-workflow-selected .agent-current')?.getBoundingClientRect();
        const providerRows = [...document.querySelectorAll('.provider-rail-item')];
        const lastProvider = providerRows[providerRows.length - 1]?.getBoundingClientRect();
        const sidebarFooter = document.querySelector('.sidebar-footer')?.getBoundingClientRect();
        const grid = document.querySelector('#liveSessionGrid');
        const canvasRect = document.querySelector('.agent-workflow-canvas')?.getBoundingClientRect();
        let routeCollisions = 0;
        if (canvasRect) {
          const cards = [...document.querySelectorAll('.downstream-column .agent-workflow-node')].map(node => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left - canvasRect.left + 4, right: rect.right - canvasRect.left - 4, top: rect.top - canvasRect.top + 4, bottom: rect.bottom - canvasRect.top - 4 };
          });
          for (const path of document.querySelectorAll('.agent-workflow-edge.downstream')) {
            const length = path.getTotalLength();
            for (let sample = 1; sample < 20; sample += 1) {
              const point = path.getPointAtLength(length * sample / 20);
              if (cards.some(rect => point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom)) { routeCollisions += 1; break; }
            }
          }
        }
        return {
          compactDirection: Boolean(upstream && selected && downstream && upstream.right < selected.left && downstream.top > Math.min(upstream.top, selected.top)),
          selectedVisible: Boolean(selectedCard && selectedCard.top < window.innerHeight && selectedCurrent && selectedCurrent.bottom <= window.innerHeight),
          guideHidden: document.querySelector('#beginnerGuide')?.classList.contains('hidden') || false,
          sidebarNoOverlap: Boolean(lastProvider && sidebarFooter && lastProvider.bottom <= sidebarFooter.top + 1),
          routeCollisions,
          groupArrowheads: document.querySelectorAll('.agent-workflow-edge.downstream.group[marker-end]').length,
          groupPortInsideCanvas: Boolean(canvasRect && (() => { const rect = document.querySelector('[data-workflow-port="children-group-input"]')?.getBoundingClientRect(); return rect && rect.left >= canvasRect.left && rect.right <= canvasRect.right && rect.top >= canvasRect.top && rect.bottom <= canvasRect.bottom; })()),
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
          downstreamGroups: document.querySelectorAll('.agent-workflow-edge.downstream.group').length,
          downstreamColumns: new Set([...document.querySelectorAll('.downstream-column .agent-workflow-node')].map(node => Math.round(node.getBoundingClientRect().left / 8))).size,
          noHorizontalOverflow: grid ? grid.scrollWidth <= grid.clientWidth + 2 : false,
          noBodyOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
        };
      })()`);
      if (!workflowCompactMetrics.compactDirection || !workflowCompactMetrics.selectedVisible || !workflowCompactMetrics.guideHidden || !workflowCompactMetrics.sidebarNoOverlap || workflowCompactMetrics.routeCollisions !== 0 || workflowCompactMetrics.connectionPaths !== 2 || workflowCompactMetrics.downstreamGroups !== 1 || workflowCompactMetrics.groupArrowheads !== 1 || !workflowCompactMetrics.groupPortInsideCanvas || workflowCompactMetrics.downstreamColumns < 1 || !workflowCompactMetrics.noHorizontalOverflow || !workflowCompactMetrics.noBodyOverflow) throw new Error(`최소 창 크기의 연결형 작업 흐름이 올바르지 않습니다: ${JSON.stringify(workflowCompactMetrics)}`);
      const workflowCompactImage = await captureStableState(win, `(() => {
        window.__ensureLoadToAgentDensityFixture?.();
        window.LoadToAgentApp.state.graphFocusId = ${JSON.stringify(densityFocusId)};
        window.LoadToAgentApp.renderSessions();
        window.LoadToAgentApp.drawAgentWorkflowConnections();
        const stage = document.querySelector('.main-stage');
        const selectedTarget = document.querySelector('.agent-workflow-selected');
        if (stage && selectedTarget) {
          const stageTop = stage.getBoundingClientRect().top;
          stage.scrollTo(0, Math.max(0, stage.scrollTop + selectedTarget.getBoundingClientRect().top - stageTop - 12));
        }
      })()`, `(() => {
        const current = document.querySelector('.agent-workflow-selected .agent-current')?.getBoundingClientRect();
        return window.LoadToAgentApp.state.graphFocusId === ${JSON.stringify(densityFocusId)} && document.querySelector('#beginnerGuide')?.classList.contains('hidden') && current && current.bottom <= window.innerHeight;
      })()`, 8);
      const workflowCompactOutput = path.join(outputDir, 'loadtoagent-agent-workflow-compact.png');
      fs.writeFileSync(workflowCompactOutput, workflowCompactImage.toPNG());
      setTestWindowSize(win, 1600, 980);
      await new Promise(resolve => setTimeout(resolve, 400));
      await win.webContents.executeJavaScript("(() => { const target = document.querySelector('[data-open-session]') || document.querySelector('.session-card'); if (target) target.click(); })()");
      await new Promise(resolve => setTimeout(resolve, 1200));
      const drawerImage = await win.webContents.capturePage();
      const drawerOutput = path.join(outputDir, 'loadtoagent-session-detail.png');
      fs.writeFileSync(drawerOutput, drawerImage.toPNG());
      await win.webContents.executeJavaScript(`Promise.all([${JSON.stringify(commandTerminalId)}, ${JSON.stringify(alternateCommandTerminalId)}].map(id => window.loadtoagent.terminalClose(id).catch(() => null)))`);
      process.stdout.write(`${output}\n${compactOutput}\n${settingsOutput}\n${terminalOutput}\n${sessionTerminalOutput}\n${terminalCompactOutput}\n${tmuxOutput}\n${tmuxControlOutput}\n${tmuxFocusOutput}\n${tmuxDetailOutput}\n${structuredOutput}\n${treeOutput}\n${focusOutput}\n${communicationOutput}\n${childFocusOutput}\n${subagentStateOutput}\n${subagentConversationOutput}\n${workflowCompactOutput}\n${drawerOutput}\n${JSON.stringify({ bridge: bridgeInfo, beginner: beginnerMetrics, compact: compactMetrics, settings: settingsMetrics, terminal: terminalMetrics, sessionTerminal: sessionTerminalMetrics, terminalCompact: terminalCompactMetrics, terminalContinuity: continuityMetrics, terminalCommand: commandUiMetrics, controlStates: controlStateMetrics, tmuxControl: tmuxControlMetrics, dashboard: metrics, density: densityMetrics, motion: { ...motionMetrics, ...motionClosedMetrics }, workflowChild: childMetrics, workflowReturn: returnMetrics, subagentConversation: subagentConversationMetrics, workflowCompact: workflowCompactMetrics, tmux: tmuxMetrics, tmuxDetail: tmuxDetailMetrics, structuredDetail: structuredMetrics })}\n`);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      exitCode = 1;
    } finally {
      app.exit(exitCode);
    }
  }, 9000);
  timeout.unref?.();
});
