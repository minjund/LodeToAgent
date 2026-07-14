'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

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
    const image = await win.webContents.capturePage();
    if (await win.webContents.executeJavaScript(verifyExpression)) return image;
  }
  throw new Error('검증할 화면 상태가 유지되는 동안 캡처하지 못했습니다.');
}

app.whenReady().then(() => {
  const timeout = setTimeout(async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('Lodestar 창을 찾을 수 없습니다.');
      win.setSize(1600, 980);
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const tmuxReady = await win.webContents.executeJavaScript(`(() => {
          const summary = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.summary || {};
          const totals = state.snapshot && state.snapshot.summary && state.snapshot.summary.totals || {};
          return Number(summary.aiPanes || 0) > 0
            && Number(summary.linked || 0) === Number(summary.aiPanes || 0)
            && Number(totals.sessions || 0) > 0;
        })()`);
        if (tmuxReady) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await win.webContents.executeJavaScript("document.fonts.ready.then(() => { state.view = 'all'; state.graphFocusId = null; document.querySelectorAll('.view-nav .nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'all')); renderSessions(); document.querySelector('.main-stage')?.scrollTo(0, 0); })");
      await new Promise(resolve => setTimeout(resolve, 500));
      const bridgeInfo = await win.webContents.executeJavaScript(`(async () => {
        const bootstrap = await window.lodestar.bootstrap();
        const command = await window.lodestar.bridgeCommand('codex');
        return { launcher: bootstrap.bridgeCli, command };
      })()`);
      if (!bridgeInfo.launcher || !bridgeInfo.launcher.path || !fs.existsSync(bridgeInfo.launcher.path) || !bridgeInfo.command || !bridgeInfo.command.ok || !bridgeInfo.command.command.includes('run codex')) throw new Error(`외부 터미널 브리지 실행기가 준비되지 않았습니다: ${JSON.stringify(bridgeInfo)}`);
      const image = await win.webContents.capturePage();
      const outputDir = path.join(__dirname, '..', 'artifacts');
      fs.mkdirSync(outputDir, { recursive: true });
      const output = path.join(outputDir, 'lodestar-dashboard.png');
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
      if (!beginnerMetrics.guideVisible || beginnerMetrics.guideSteps !== 3 || !beginnerMetrics.homeActive || !beginnerMetrics.navLabels.includes('홈') || !beginnerMetrics.navLabels.includes('내 확인 필요') || !beginnerMetrics.navLabels.includes('일반 명령창') || !beginnerMetrics.navLabels.includes('tmux 작업') || beginnerMetrics.primaryAction !== '＋ AI에게 새 일 맡기기' || beginnerMetrics.oldJargonVisible.length || !beginnerMetrics.noHorizontalOverflow) {
        throw new Error(`초보자용 기본 화면이 올바르지 않습니다: ${JSON.stringify(beginnerMetrics)}`);
      }
      win.setSize(1080, 700);
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
      const compactOutput = path.join(outputDir, 'lodestar-beginner-compact.png');
      fs.writeFileSync(compactOutput, compactImage.toPNG());
      win.setSize(1600, 980);
      await new Promise(resolve => setTimeout(resolve, 350));

      await win.webContents.executeJavaScript("document.querySelector('[data-view=\"terminal\"]')?.click(); document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 300));
      await win.webContents.executeJavaScript("document.querySelector('#newPowerShellBtn')?.click()");
      const powerShellId = await waitForRenderer(win, "document.querySelector('.terminal-tab.active')?.dataset.terminalId || ''", 50, 200);
      if (!powerShellId) throw new Error('PowerShell PTY 터미널이 생성되지 않았습니다.');
      await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#terminalCommandInput'); input.value = 'Write-Output LODESTAR_PTY_OK'; document.querySelector('#terminalCommandForm').requestSubmit(); })()`);
      const powerShellReplay = await waitForRenderer(win, `(async () => { const value = await window.lodestar.terminalGet(${JSON.stringify(powerShellId)}); return value && value.replay.includes('LODESTAR_PTY_OK') ? value.replay : ''; })()`, 50, 200);
      if (!powerShellReplay) throw new Error('PowerShell PTY에 보낸 명령 결과를 수신하지 못했습니다.');

      await win.webContents.executeJavaScript("document.querySelector('#newWslBtn')?.click()");
      const wslId = await waitForRenderer(win, `(() => { const id = document.querySelector('.terminal-tab.active')?.dataset.terminalId || ''; return id && id !== ${JSON.stringify(powerShellId)} ? id : ''; })()`, 50, 200);
      if (!wslId) throw new Error('WSL PTY 터미널이 생성되지 않았습니다.');
      await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('#terminalCommandInput'); input.value = 'printf LODESTAR_WSL_OK'; document.querySelector('#terminalCommandForm').requestSubmit(); })()`);
      const wslReplay = await waitForRenderer(win, `(async () => { const value = await window.lodestar.terminalGet(${JSON.stringify(wslId)}); return value && value.replay.includes('LODESTAR_WSL_OK') ? value.replay : ''; })()`, 50, 200);
      if (!wslReplay) throw new Error('WSL PTY에 보낸 명령 결과를 수신하지 못했습니다.');
      const terminalMetrics = await win.webContents.executeJavaScript(`(async () => {
        const terminalSessions = await window.lodestar.terminalList();
        return {
          sectionVisible: !document.querySelector('#terminalSection')?.classList.contains('hidden'),
          appView: state.view,
          activeNav: document.querySelector('.view-nav .nav-item.active')?.dataset.view || '',
          sectionClass: document.querySelector('#terminalSection')?.className || '',
          sessions: document.querySelectorAll('.terminal-session-item').length,
          tabs: document.querySelectorAll('.terminal-tab').length,
          xterms: document.querySelectorAll('.terminal-screen .xterm').length,
          selectedTitle: document.querySelector('#terminalTargetMeta b')?.textContent || '',
          workbenchInGeneral: document.querySelector('#terminalSection')?.contains(document.querySelector('#terminalWorkbench')) || false,
          tmuxSectionHidden: document.querySelector('#tmuxSection')?.classList.contains('hidden') || false,
          tmuxControlsMixedIn: Boolean(document.querySelector('#terminalSection #terminalTmuxList') || document.querySelector('#terminalSection #newTmuxSessionBtn')),
          onlyGeneralTabs: [...document.querySelectorAll('.terminal-tab')].every(tab => terminalSessions.find(item => item.id === tab.dataset.terminalId)?.type !== 'tmux'),
        };
      })()`);
      if (!terminalMetrics.sectionVisible || terminalMetrics.sessions < 2 || terminalMetrics.xterms < 2 || !terminalMetrics.workbenchInGeneral || !terminalMetrics.tmuxSectionHidden || terminalMetrics.tmuxControlsMixedIn || !terminalMetrics.onlyGeneralTabs) throw new Error(`일반 명령창 분리가 불완전합니다: ${JSON.stringify(terminalMetrics)}`);
      await win.webContents.executeJavaScript("document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 250));
      const terminalImage = await win.webContents.capturePage();
      const terminalOutput = path.join(outputDir, 'lodestar-terminal-control.png');
      fs.writeFileSync(terminalOutput, terminalImage.toPNG());
      await win.webContents.executeJavaScript("window.lodestar.terminalList().then(items => Promise.all(items.map(item => window.lodestar.terminalClose(item.id))))");
      await new Promise(resolve => setTimeout(resolve, 250));

      await win.webContents.executeJavaScript("document.querySelector('[data-view=\"tmux\"]')?.click(); document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 500));
      const tmuxImage = await win.webContents.capturePage();
      const tmuxOutput = path.join(outputDir, 'lodestar-tmux-map.png');
      fs.writeFileSync(tmuxOutput, tmuxImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.tmux-pane-node.has-agent [data-control-tmux]')?.click()");
      await new Promise(resolve => setTimeout(resolve, 650));
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
      const tmuxControlOutput = path.join(outputDir, 'lodestar-tmux-control.png');
      fs.writeFileSync(tmuxControlOutput, tmuxControlImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 200));
      await win.webContents.executeJavaScript("document.querySelector('.tmux-pane-node.has-agent [data-tmux-type=\"pane\"]')?.click()");
      await new Promise(resolve => setTimeout(resolve, 500));
      const tmuxFocusImage = await win.webContents.capturePage();
      const tmuxFocusOutput = path.join(outputDir, 'lodestar-tmux-focus.png');
      fs.writeFileSync(tmuxFocusOutput, tmuxFocusImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.tmux-pane-node.has-agent [data-open-session]')?.click()");
      const tmuxDetailReady = await waitForRenderer(win, `(() => document.querySelector('#detailDrawer')?.classList.contains('open') && !document.querySelector('.drawer-loading'))()`, 120, 250);
      if (!tmuxDetailReady) throw new Error('여러 창 작업에서 연결된 AI의 대화 상세를 불러오지 못했습니다.');
      const tmuxDetailImage = await win.webContents.capturePage();
      const tmuxDetailOutput = path.join(outputDir, 'lodestar-tmux-detail.png');
      fs.writeFileSync(tmuxDetailOutput, tmuxDetailImage.toPNG());
      const tmuxDetailMetrics = await win.webContents.executeJavaScript(`(() => ({
        drawerOpen: document.querySelector('#detailDrawer')?.classList.contains('open'),
        title: document.querySelector('#drawerTitle')?.textContent || '',
        loading: Boolean(document.querySelector('.drawer-loading')),
      }))()`);
      await win.webContents.executeJavaScript("document.querySelector('#closeDrawerBtn')?.click()");
      const tmuxMetrics = await win.webContents.executeJavaScript(`(() => ({
        summary: state.snapshot && state.snapshot.tmux && state.snapshot.tmux.summary,
        distroNodes: document.querySelectorAll('.tmux-distro-node').length,
        sessionNodes: document.querySelectorAll('.tmux-session-node').length,
        windowNodes: document.querySelectorAll('.tmux-window-node').length,
        paneNodes: document.querySelectorAll('.tmux-pane-node').length,
        aiPaneNodes: document.querySelectorAll('.tmux-pane-node.has-agent').length,
        breadcrumbSteps: document.querySelectorAll('#tmuxBreadcrumbs button').length,
        focused: Boolean(state.tmuxFocus),
        linkedCommandTargets: (state.snapshot && state.snapshot.sessions || []).filter(session => window.LodestarTerminal.agentTargets(session).some(target => target.kind === 'tmux')).length,
      }))()`);
      if (Number(tmuxMetrics.summary?.linked || 0) > 0 && tmuxMetrics.linkedCommandTargets < 1) throw new Error(`연결된 tmux AI를 직접 지시 대상으로 찾지 못했습니다: ${JSON.stringify(tmuxMetrics)}`);
      await win.webContents.executeJavaScript("document.querySelector('[data-view=\"all\"]')?.click(); document.querySelector('.main-stage')?.scrollTo(0, 0)");
      await new Promise(resolve => setTimeout(resolve, 350));
      const structuredSessionId = await win.webContents.executeJavaScript(`(() => {
        const base = (state.snapshot && state.snapshot.sessions || []).find(item => item.provider === 'claude') || {};
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
        state.details.set(id, fixture);
        state.selectedId = id;
        state.detailLoading = false;
        state.drawerTab = 'chat';
        state.drawerForceLatest = true;
        document.querySelector('#drawerBackdrop').classList.remove('hidden');
        document.querySelector('#detailDrawer').classList.add('open');
        document.querySelector('#detailDrawer').setAttribute('aria-hidden', 'false');
        renderDrawer();
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
      const structuredOutput = path.join(outputDir, 'lodestar-structured-detail.png');
      fs.writeFileSync(structuredOutput, structuredImage.toPNG());
      await win.webContents.executeJavaScript("document.querySelector('#closeDrawerBtn')?.click()");
      if (structuredSessionId && structuredMetrics.candidates === 0) throw new Error('구조화 JSON 메시지가 읽기 쉬운 카드로 렌더링되지 않았습니다.');
      if (structuredSessionId && !structuredMetrics.atBottom) throw new Error(`상세 대화가 최신 메시지 위치로 이동하지 않았습니다. gap=${structuredMetrics.bottomGap}`);
      const densitySetup = await win.webContents.executeJavaScript(`(async () => {
        const sessions = state.snapshot && state.snapshot.sessions || [];
        const base = sessions.find(item => !item.parentId && isLiveSession(item)) || sessions[0];
        if (!base) return { focusId: '', terminalId: '' };
        const directTerminal = await window.lodestar.terminalCreate({ type: 'powershell', title: 'AI 직접 지시 검증', cols: 120, rows: 32 });
        const alternateTerminal = await window.lodestar.terminalCreate({ type: 'powershell', title: 'AI 지시 대상 선택 검증', cols: 120, rows: 32 });
        await window.LodestarTerminal.refresh();
        const providerIds = state.providers.map(item => item.id);
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
          childIds: index === 0 ? Array.from({ length: 9 }, (_, childIndex) => 'visual-density:child:' + childIndex) : [],
          context: { used: 54000 + index * 100, window: 258400, percent: 21 + index / 10, source: 'session' },
          usage: { input: 70000 + index * 100, cachedInput: 42000, output: 3200, reasoning: 900, total: 116100 + index * 100 },
          messages: [{ role: 'assistant', text: '동시에 실행되는 작업의 상태를 확인하고 있습니다.', timestamp: new Date(now - index * 1000).toISOString() }],
          lifecycle: [],
          runtimePresence: index === 0 ? [
            { id: 'visual-terminal:' + directTerminal.id, kind: 'windows', label: directTerminal.title, provider: base.provider, pid: directTerminal.pid, parentPid: directTerminal.pid, terminalId: directTerminal.id },
            { id: 'visual-terminal:' + alternateTerminal.id, kind: 'windows', label: alternateTerminal.title, provider: base.provider, pid: alternateTerminal.pid, parentPid: alternateTerminal.pid, terminalId: alternateTerminal.id },
          ] : [],
        }));
        const children = Array.from({ length: 9 }, (_, index) => ({
          ...roots[0],
          id: 'visual-density:child:' + index,
          externalId: 'visual-density-child-' + index,
          parentId: roots[0].id,
          depth: 1,
          agentName: ['Atlas', 'Nova', 'Echo', 'Iris', 'Orion', 'Sage', 'Flux', 'Luna', 'Pico'][index],
          agentRole: index % 2 ? 'reviewer' : 'explorer',
          title: '연결된 서브에이전트 작업 ' + (index + 1),
          provider: index === 1 ? 'codex' : roots[0].provider,
          clientKind: index === 1 ? 'codex-desktop' : 'external-cli',
          status: index === 2 ? 'completed' : 'running',
          childIds: [],
          runtimePresence: [],
          updatedAt: new Date(now - index * 700).toISOString(),
        }));
        const fixtures = [...roots, ...children];
        window.__lodestarDensityFixture = { fixtures, focusId: roots[0].id, terminalId: directTerminal.id };
        window.__ensureLodestarDensityFixture = () => {
          const current = state.snapshot && state.snapshot.sessions || [];
          const ids = new Set(current.map(item => item.id));
          for (const fixture of fixtures) if (!ids.has(fixture.id)) current.unshift(fixture);
        };
        window.__ensureLodestarDensityFixture();
        state.graphFocusId = null;
        state.graphExpandedProviders.clear();
        renderSessions();
        document.querySelector('.main-stage')?.scrollTo(0, 0);
        return { focusId: roots[0].id, terminalId: directTerminal.id, alternateTerminalId: alternateTerminal.id };
      })()`);
      const densityFocusId = densitySetup.focusId;
      const commandTerminalId = densitySetup.terminalId;
      const alternateCommandTerminalId = densitySetup.alternateTerminalId;
      await new Promise(resolve => setTimeout(resolve, 250));
      const treeImage = await win.webContents.capturePage();
      const treeOutput = path.join(outputDir, 'lodestar-agent-tree.png');
      fs.writeFileSync(treeOutput, treeImage.toPNG());
      const densityMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = null;
        state.graphExpandedProviders.clear();
        renderSessions();
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
          noHorizontalOverflow: grid ? grid.scrollWidth <= grid.clientWidth + 2 : false,
          subagentTabRemoved: !document.querySelector('[data-view="subagents"]'),
        };
      })()`);
      if (!densityMetrics.subagentTabRemoved || densityMetrics.lanes < 4 || densityMetrics.visibleFlows > densityMetrics.lanes * 6 || densityMetrics.moreButtons < 1 || densityMetrics.expandedFlows <= densityMetrics.visibleFlows || !densityMetrics.noHorizontalOverflow) {
        throw new Error(`대규모 에이전트 지도 밀도 조절이 올바르지 않습니다: ${JSON.stringify(densityMetrics)}`);
      }
      if (densityFocusId) {
        await win.webContents.executeJavaScript(`(() => {
          window.__ensureLodestarDensityFixture?.();
          renderSessions();
          document.querySelector('[data-graph-focus="${densityFocusId}"]')?.click();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const directMarker = `LODESTAR_AGENT_DIRECT_${Date.now()}`;
      const commandUiMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = ${JSON.stringify(densityFocusId)};
        renderSessions();
        const session = state.snapshot.sessions.find(item => item.id === ${JSON.stringify(densityFocusId)});
        const targets = window.LodestarTerminal.agentTargets(session);
        const form = document.querySelector('[data-agent-command-form="${densityFocusId}"]');
        const input = form?.querySelector('[data-agent-command-draft]');
        const picker = form?.querySelector('[data-agent-command-target]');
        const initiallyDisabled = form?.querySelector('[type="submit"]')?.disabled || false;
        if (picker) {
          picker.value = ${JSON.stringify(commandTerminalId)};
          picker.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (input) {
          input.value = ${JSON.stringify(`Write-Output ${directMarker}`)};
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
      const directReplay = await waitForRenderer(win, `(async () => { const value = await window.lodestar.terminalGet(${JSON.stringify(commandTerminalId)}); return value?.replay.includes(${JSON.stringify(directMarker)}) ? value.replay : ''; })()`, 50, 200);
      if (!commandUiMetrics.formVisible || !commandUiMetrics.connected || commandUiMetrics.targetCount !== 2 || !commandUiMetrics.targetIds.includes(commandTerminalId) || !commandUiMetrics.targetIds.includes(alternateCommandTerminalId) || !commandUiMetrics.pickerVisible || !commandUiMetrics.initiallyDisabled || commandUiMetrics.selectedTargetId !== commandTerminalId || commandUiMetrics.maxLength !== 8000 || !directReplay) {
        throw new Error(`선택한 AI의 터미널 직접 지시가 올바르지 않습니다: ${JSON.stringify(commandUiMetrics)}`);
      }
      const openDraft = '이 문장을 터미널 입력창에서 이어서 작성';
      await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = ${JSON.stringify(densityFocusId)};
        renderSessions();
        const input = document.querySelector('[data-agent-command-draft="${densityFocusId}"]');
        if (input) {
          input.value = ${JSON.stringify(openDraft)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        document.querySelector('[data-agent-terminal-open="${densityFocusId}"]')?.click();
      })()`);
      const terminalOpenReady = await waitForRenderer(win, `(() => state.view === 'terminal' && document.querySelector('.terminal-tab.active')?.dataset.terminalId === ${JSON.stringify(commandTerminalId)} && document.querySelector('#terminalCommandInput')?.value === ${JSON.stringify(openDraft)})()`);
      if (!terminalOpenReady) throw new Error('선택한 AI에서 정확한 일반 터미널과 지시 초안을 열지 못했습니다.');
      await win.webContents.executeJavaScript(`(() => {
        state.agentCommandDrafts.delete(${JSON.stringify(densityFocusId)});
        document.querySelector('[data-view="all"]')?.click();
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = ${JSON.stringify(densityFocusId)};
        renderSessions();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 300));
      const motionMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = null;
        renderSessions();
        document.querySelector('[data-graph-focus="${densityFocusId}"]')?.click();
        drawAgentWorkflowConnections();
        const path = document.querySelector('.agent-workflow-edge');
        openRunModal();
        const modalOpening = document.querySelector('.run-modal')?.getAnimations().some(animation => animation.animationName === 'motion-modal-in') || false;
        closeRunModal();
        openDrawer(${JSON.stringify(densityFocusId)});
        closeDrawer();
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
      await new Promise(resolve => setTimeout(resolve, 650));
      const motionClosedMetrics = await win.webContents.executeJavaScript(`(() => ({
        modalHidden: document.querySelector('#runModal')?.classList.contains('hidden') || false,
        drawerBackdropHidden: document.querySelector('#drawerBackdrop')?.classList.contains('hidden') || false,
      }))()`);
      if (!motionMetrics.preferenceMatches || motionMetrics.lastMotion !== 'focus' || motionMetrics.keyedElements < 10 || !motionMetrics.workflowAnimated || motionMetrics.pathLength !== '1' || (!motionMetrics.reduced && !motionMetrics.edgeAnimation) || !motionMetrics.modalOpening || !motionMetrics.modalClosingDeferred || !motionMetrics.drawerClosingDeferred || !motionClosedMetrics.modalHidden || !motionClosedMetrics.drawerBackdropHidden) {
        throw new Error(`부드러운 화면 전환 모션이 올바르지 않습니다: ${JSON.stringify({ ...motionMetrics, ...motionClosedMetrics })}`);
      }
      const focusImage = await captureStableState(win, `(() => {
        document.querySelector('#closeDrawerBtn')?.click();
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = ${JSON.stringify(densityFocusId)};
        renderSessions();
        drawAgentWorkflowConnections();
        document.querySelector('.main-stage')?.scrollTo(0, 0);
      })()`, `state.graphFocusId === ${JSON.stringify(densityFocusId)} && document.querySelectorAll('.downstream-column .agent-workflow-node').length === 9 && !document.querySelector('#detailDrawer')?.classList.contains('open')`);
      const focusOutput = path.join(outputDir, 'lodestar-agent-focus.png');
      fs.writeFileSync(focusOutput, focusImage.toPNG());
      const metrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        if (window.__lodestarDensityFixture) state.graphFocusId = window.__lodestarDensityFixture.focusId;
        renderSessions();
        const start = performance.now();
        for (let index = 0; index < 5; index += 1) renderSessions();
        drawAgentWorkflowConnections();
        const grid = document.querySelector('#liveSessionGrid');
        const upstream = document.querySelector('.upstream-column .agent-workflow-origin, .upstream-column .agent-workflow-node')?.getBoundingClientRect();
        const selected = document.querySelector('.agent-workflow-selected')?.getBoundingClientRect();
        const downstream = document.querySelector('.downstream-column .agent-workflow-node')?.getBoundingClientRect();
        return {
          averageRenderMs: (performance.now() - start) / 5,
          renderedCards: document.querySelectorAll('.session-card').length,
          liveNodes: document.querySelectorAll('.live-session-grid .agent-node').length,
          graphFocused: Boolean(state.graphFocusId),
          breadcrumbSteps: document.querySelectorAll('#graphBreadcrumbs button').length,
          workflowCanvas: document.querySelectorAll('.agent-workflow-canvas').length,
          upstreamNodes: document.querySelectorAll('.upstream-column .agent-workflow-origin, .upstream-column .agent-workflow-node').length,
          selectedNodes: document.querySelectorAll('.selected-column .agent-node').length,
          downstreamNodes: document.querySelectorAll('.downstream-column .agent-workflow-node').length,
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
          ports: document.querySelectorAll('.agent-workflow-port').length,
          desktopDirectionFixed: Boolean(upstream && selected && downstream && upstream.right < selected.left && selected.right < downstream.left),
          noHorizontalOverflow: grid ? grid.scrollWidth <= grid.clientWidth + 2 : false,
        };
      })()`);
      if (!metrics.graphFocused || metrics.liveNodes !== 1 || metrics.workflowCanvas !== 1 || metrics.upstreamNodes !== 1 || metrics.selectedNodes !== 1 || metrics.downstreamNodes !== 9 || metrics.connectionPaths !== 10 || metrics.ports !== 12 || !metrics.desktopDirectionFixed || !metrics.noHorizontalOverflow || metrics.averageRenderMs > 250) throw new Error(`연결형 에이전트 작업 흐름이 올바르지 않습니다: ${JSON.stringify(metrics)}`);

      const childClick = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = ${JSON.stringify(densityFocusId)};
        renderSessions();
        drawAgentWorkflowConnections();
        const child = document.querySelector('.downstream-column [data-graph-focus]');
        child?.click();
        return { childId: child?.dataset.graphFocus || '', immediateFocusId: state.graphFocusId };
      })()`);
      const childFocusId = childClick.childId;
      if (!childFocusId || childClick.immediateFocusId !== childFocusId) throw new Error(`나눠 맡긴 AI 선택 이벤트가 적용되지 않았습니다: ${JSON.stringify(childClick)}`);
      await new Promise(resolve => setTimeout(resolve, 450));
      const childMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        if (state.graphFocusId !== ${JSON.stringify(childFocusId)}) { state.graphFocusId = ${JSON.stringify(childFocusId)}; renderSessions(); }
        drawAgentWorkflowConnections();
        const upstream = document.querySelector('.upstream-column .agent-workflow-node')?.getBoundingClientRect();
        const selected = document.querySelector('.agent-workflow-selected')?.getBoundingClientRect();
        return {
          focusId: state.graphFocusId,
          parentId: document.querySelector('.upstream-column [data-graph-focus]')?.dataset.graphFocus || '',
          parentOnLeft: Boolean(upstream && selected && upstream.right < selected.left),
          downstreamNodes: document.querySelectorAll('.downstream-column .agent-workflow-node').length,
          emptyShown: Boolean(document.querySelector('.downstream-column .agent-workflow-empty')),
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
          commandUnavailable: document.querySelector('.agent-command-panel')?.classList.contains('unavailable') || false,
          commandDisabled: document.querySelector('[data-agent-command-draft]')?.disabled || false,
          connectMode: document.querySelector('.agent-command-panel')?.classList.contains('control-connect') || false,
          bridgeCopyVisible: Boolean(document.querySelector('[data-agent-bridge-copy]')),
        };
      })()`);
      const childFocusImage = await captureStableState(win, `(() => {
        document.querySelector('#closeDrawerBtn')?.click();
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = ${JSON.stringify(childFocusId)};
        renderSessions();
        drawAgentWorkflowConnections();
        document.querySelector('.main-stage')?.scrollTo(0, 0);
      })()`, `state.graphFocusId === ${JSON.stringify(childFocusId)} && document.querySelector('.upstream-column [data-graph-focus]')?.dataset.graphFocus === ${JSON.stringify(densityFocusId)} && !document.querySelector('#detailDrawer')?.classList.contains('open')`);
      const childFocusOutput = path.join(outputDir, 'lodestar-agent-child-focus.png');
      fs.writeFileSync(childFocusOutput, childFocusImage.toPNG());
      if (childMetrics.focusId !== childFocusId || childMetrics.parentId !== densityFocusId || !childMetrics.parentOnLeft || childMetrics.downstreamNodes !== 0 || !childMetrics.emptyShown || childMetrics.connectionPaths !== 1 || !childMetrics.commandUnavailable || !childMetrics.commandDisabled || !childMetrics.connectMode || !childMetrics.bridgeCopyVisible) throw new Error(`도움 AI 선택 후 부모 방향 또는 터미널 안전 상태가 올바르지 않습니다: ${JSON.stringify(childMetrics)}`);

      const controlStateMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        const inspect = id => {
          state.graphFocusId = id;
          renderSessions();
          const panel = document.querySelector('.agent-command-panel');
          return {
            classes: panel?.className || '',
            status: panel?.querySelector('header small')?.textContent || '',
            origin: Boolean(panel?.querySelector('[data-agent-open-origin]')),
            bridge: Boolean(panel?.querySelector('[data-agent-bridge-copy]')),
            enabledTextarea: panel?.querySelector('textarea')?.disabled === false,
          };
        };
        return {
          connect: inspect('visual-density:child:0'),
          origin: inspect('visual-density:child:1'),
          ended: inspect('visual-density:child:2'),
        };
      })()`);
      if (!controlStateMetrics.connect.classes.includes('control-connect') || !controlStateMetrics.connect.bridge || !controlStateMetrics.origin.classes.includes('control-origin') || !controlStateMetrics.origin.origin || !controlStateMetrics.ended.classes.includes('control-ended') || controlStateMetrics.ended.origin || controlStateMetrics.ended.bridge || controlStateMetrics.ended.enabledTextarea) throw new Error(`AI 입력 상태 UI가 올바르지 않습니다: ${JSON.stringify(controlStateMetrics)}`);

      const returnClick = await win.webContents.executeJavaScript(`(() => {
        const parent = document.querySelector('.upstream-column [data-graph-focus]');
        parent?.click();
        return { parentId: parent?.dataset.graphFocus || '', immediateFocusId: state.graphFocusId };
      })()`);
      if (returnClick.parentId !== densityFocusId || returnClick.immediateFocusId !== densityFocusId) throw new Error(`메인 AI로 돌아가기 이벤트가 적용되지 않았습니다: ${JSON.stringify(returnClick)}`);
      await new Promise(resolve => setTimeout(resolve, 450));
      const returnMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        if (state.graphFocusId !== ${JSON.stringify(densityFocusId)}) { state.graphFocusId = ${JSON.stringify(densityFocusId)}; renderSessions(); }
        drawAgentWorkflowConnections();
        return {
          focusId: state.graphFocusId,
          originVisible: Boolean(document.querySelector('.upstream-column .agent-workflow-origin')),
          downstreamNodes: document.querySelectorAll('.downstream-column .agent-workflow-node').length,
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
        };
      })()`);
      if (returnMetrics.focusId !== densityFocusId || !returnMetrics.originVisible || returnMetrics.downstreamNodes !== 9 || returnMetrics.connectionPaths !== 10) throw new Error(`메인 AI로 돌아온 뒤 연결 흐름이 복원되지 않았습니다: ${JSON.stringify(returnMetrics)}`);

      win.setSize(1080, 700);
      await new Promise(resolve => setTimeout(resolve, 450));
      const workflowCompactMetrics = await win.webContents.executeJavaScript(`(() => {
        window.__ensureLodestarDensityFixture?.();
        state.graphFocusId = ${JSON.stringify(densityFocusId)};
        renderSessions();
        drawAgentWorkflowConnections();
        const upstream = document.querySelector('.upstream-column')?.getBoundingClientRect();
        const selected = document.querySelector('.selected-column')?.getBoundingClientRect();
        const downstream = document.querySelector('.downstream-column')?.getBoundingClientRect();
        const grid = document.querySelector('#liveSessionGrid');
        return {
          verticalDirection: Boolean(upstream && selected && downstream && upstream.bottom < selected.top && selected.bottom < downstream.top),
          connectionPaths: document.querySelectorAll('.agent-workflow-edge').length,
          noHorizontalOverflow: grid ? grid.scrollWidth <= grid.clientWidth + 2 : false,
        };
      })()`);
      if (!workflowCompactMetrics.verticalDirection || workflowCompactMetrics.connectionPaths !== 10 || !workflowCompactMetrics.noHorizontalOverflow) throw new Error(`최소 창 크기의 연결형 작업 흐름이 올바르지 않습니다: ${JSON.stringify(workflowCompactMetrics)}`);
      const workflowCompactImage = await win.webContents.capturePage();
      const workflowCompactOutput = path.join(outputDir, 'lodestar-agent-workflow-compact.png');
      fs.writeFileSync(workflowCompactOutput, workflowCompactImage.toPNG());
      win.setSize(1600, 980);
      await new Promise(resolve => setTimeout(resolve, 400));
      await win.webContents.executeJavaScript("(() => { const target = document.querySelector('[data-open-session]') || document.querySelector('.session-card'); if (target) target.click(); })()");
      await new Promise(resolve => setTimeout(resolve, 1200));
      const drawerImage = await win.webContents.capturePage();
      const drawerOutput = path.join(outputDir, 'lodestar-session-detail.png');
      fs.writeFileSync(drawerOutput, drawerImage.toPNG());
      await win.webContents.executeJavaScript(`Promise.all([${JSON.stringify(commandTerminalId)}, ${JSON.stringify(alternateCommandTerminalId)}].map(id => window.lodestar.terminalClose(id).catch(() => null)))`);
      process.stdout.write(`${output}\n${compactOutput}\n${terminalOutput}\n${tmuxOutput}\n${tmuxControlOutput}\n${tmuxFocusOutput}\n${tmuxDetailOutput}\n${structuredOutput}\n${treeOutput}\n${focusOutput}\n${childFocusOutput}\n${workflowCompactOutput}\n${drawerOutput}\n${JSON.stringify({ bridge: bridgeInfo, beginner: beginnerMetrics, compact: compactMetrics, terminal: terminalMetrics, terminalCommand: commandUiMetrics, controlStates: controlStateMetrics, tmuxControl: tmuxControlMetrics, dashboard: metrics, density: densityMetrics, motion: { ...motionMetrics, ...motionClosedMetrics }, workflowChild: childMetrics, workflowReturn: returnMetrics, workflowCompact: workflowCompactMetrics, tmux: tmuxMetrics, tmuxDetail: tmuxDetailMetrics, structuredDetail: structuredMetrics })}\n`);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  }, 9000);
  timeout.unref?.();
});
