'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  providers: [],
  providerMap: new Map(),
  availability: {},
  workspaces: [],
  snapshot: null,
  activeRuns: [],
  view: 'all',
  provider: 'all',
  workspace: 'all',
  search: '',
  sort: 'recent',
  selectedId: null,
  drawerTab: 'chat',
  runProvider: 'claude',
  details: new Map(),
  detailLoading: false,
  drawerForceLatest: false,
  visibleLimit: 30,
  graphFocusId: null,
  graphExpandedProviders: new Set(),
  tmuxFocus: null,
  agentCommandDrafts: new Map(),
  agentCommandTargets: new Map(),
  agentCommandSending: new Set(),
  platform: { id: 'win32', label: 'Windows', localShell: 'powershell', localShellLabel: 'Windows 명령창', nativeTmux: false },
};

const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionState = {
  ready: false,
  modalTimer: 0,
  toastTimer: 0,
  drawerTimer: 0,
  drawerContentTimer: 0,
  drawerRenderKey: '',
};

document.documentElement.dataset.motion = motionPreference.matches ? 'reduced' : 'full';
motionPreference.addEventListener('change', event => {
  document.documentElement.dataset.motion = event.matches ? 'reduced' : 'full';
});

function captureMotionLayout() {
  const items = new Map();
  $$('[data-motion-key]').forEach(element => {
    const key = element.dataset.motionKey;
    if (!key || items.has(key)) return;
    const rect = element.getBoundingClientRect();
    items.set(key, {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      value: element.dataset.motionValue || '',
    });
  });
  return items;
}

function motionEnterOffset(element, kind) {
  if (kind === 'focus' || kind === 'focus-back') {
    if (element.closest('.upstream-column')) return { x: -18, y: 0 };
    if (element.closest('.downstream-column')) return { x: 18, y: 0 };
  }
  if (kind === 'view') return { x: 0, y: 14 };
  return { x: 0, y: 9 };
}

function playMotionLayout(previous, kind = 'refresh') {
  const elements = $$('[data-motion-key]');
  document.documentElement.dataset.lastMotion = kind;
  if (!motionState.ready) {
    motionState.ready = true;
    return;
  }
  if (motionPreference.matches) return;
  requestAnimationFrame(() => {
    let entered = 0;
    elements.forEach(element => {
      const key = element.dataset.motionKey;
      const before = previous.get(key);
      const after = element.getBoundingClientRect();
      if (before) {
        const dx = before.rect.left - after.left;
        const dy = before.rect.top - after.top;
        if (Math.abs(dx) > .5 || Math.abs(dy) > .5) {
          element.animate([
            { transform: `translate(${dx}px, ${dy}px)`, opacity: .82 },
            { transform: 'translate(0, 0)', opacity: 1 },
          ], { duration: 440, easing: 'cubic-bezier(.22, 1, .36, 1)' });
        }
        if (before.value && before.value !== (element.dataset.motionValue || '')) {
          element.classList.add('motion-updated');
          element.addEventListener('animationend', () => element.classList.remove('motion-updated'), { once: true });
        }
        return;
      }
      const offset = motionEnterOffset(element, kind);
      element.animate([
        { transform: `translate(${offset.x}px, ${offset.y}px) scale(.985)`, opacity: 0 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ], {
        duration: 360,
        delay: Math.min(entered++, 8) * 28,
        easing: 'cubic-bezier(.22, 1, .36, 1)',
        fill: 'backwards',
      });
    });
  });
}

function animateVisibleSections() {
  if (motionPreference.matches) return;
  $$('.main-stage > section:not(.hidden)').forEach((section, index) => {
    section.classList.remove('motion-section-in');
    section.style.setProperty('--motion-section-delay', `${Math.min(index, 4) * 42}ms`);
    requestAnimationFrame(() => section.classList.add('motion-section-in'));
  });
}

const STATUS = {
  starting: '준비 중',
  running: '일하는 중',
  waiting: '내 확인 필요',
  idle: '쉬는 중',
  completed: '완료',
  failed: '문제 발생',
  cancelled: '중지됨',
};

const VIEW_TITLES = {
  all: '최근 대화와 작업',
  active: '진행 중인 작업',
  waiting: '내 확인이 필요한 작업',
  terminal: '일반 명령창',
  tmux: 'tmux 작업',
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function memoryCategoryLabel(value) {
  const labels = { insight: '인사이트', convention: '작업 규칙', failure: '실패 기록', decision: '결정', pattern: '반복 패턴' };
  return labels[String(value || '').toLowerCase()] || String(value || '기록');
}

function jsonValueHtml(value, depth = 0) {
  if (value == null) return '<span class="json-empty">없음</span>';
  if (typeof value === 'boolean') return `<span class="json-primitive">${value ? '예' : '아니요'}</span>`;
  if (typeof value === 'number') return `<span class="json-primitive">${esc(value.toLocaleString('ko-KR'))}</span>`;
  if (typeof value === 'string') return `<span class="json-string">${esc(value)}</span>`;
  if (depth >= 4) return `<span class="json-string">${esc(JSON.stringify(value))}</span>`;
  if (Array.isArray(value)) {
    const shown = value.slice(0, 40);
    return `<ol class="json-array">${shown.map(item => `<li>${jsonValueHtml(item, depth + 1)}</li>`).join('')}${value.length > shown.length ? `<li class="json-more">외 ${value.length - shown.length}개</li>` : ''}</ol>`;
  }
  const entries = Object.entries(value).slice(0, 40);
  return `<dl class="json-object">${entries.map(([key, item]) => `<div><dt>${esc(key)}</dt><dd>${jsonValueHtml(item, depth + 1)}</dd></div>`).join('')}</dl>`;
}

function memoryCandidatesHtml(items) {
  return `<div class="memory-candidates"><div class="structured-heading"><b>저장할 작업 기억</b><span>${items.length}개 항목</span></div>${items.map((item, index) => `<article class="memory-candidate"><header><b>${index + 1}</b><span class="memory-target">${esc(item.target || 'MEMORY')}</span><span class="memory-category">${esc(memoryCategoryLabel(item.category))}</span></header><p>${esc(item.content || '내용 없음')}</p></article>`).join('')}</div>`;
}

function messageContentHtml(message) {
  const text = String(message && message.text || '').trim();
  if (!text) return '<div class="chat-content empty">표시할 내용이 없습니다.</div>';
  if (/^[\[{]/.test(text) && /[\]}]$/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length && parsed.every(item => item && typeof item === 'object' && ('content' in item) && ('target' in item || 'category' in item))) {
        return memoryCandidatesHtml(parsed);
      }
      return `<div class="structured-json"><div class="structured-heading"><b>구조화된 데이터</b><span>${Array.isArray(parsed) ? `${parsed.length}개 항목` : 'JSON'}</span></div>${jsonValueHtml(parsed)}</div>`;
    } catch {}
  }
  return `<div class="chat-content plain">${esc(text)}</div>`;
}

function compact(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return n.toLocaleString('ko-KR');
}

function fullNumber(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function timeAgo(value) {
  const ms = Date.now() - Date.parse(value || 0);
  if (!Number.isFinite(ms)) return '-';
  if (ms < 8_000) return '방금 전';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  return day < 30 ? `${day}일 전` : new Date(value).toLocaleDateString('ko-KR');
}

function timeOnly(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function providerInfo(id) {
  return state.providerMap.get(id) || { id, label: id, company: '', accent: '#8fa2b7', mark: 'AI', docs: '' };
}

function providerStyle(id) {
  return `--provider:${providerInfo(id).accent}`;
}

function agentRoleLabel(value) {
  const labels = { explorer: '자료 조사', reviewer: '검토', worker: '실행', general: '도움', planner: '계획', tester: '시험' };
  return labels[String(value || '').toLowerCase()] || String(value || '도움');
}

function statusClass(status) {
  return ['running', 'waiting', 'failed', 'cancelled'].includes(status) ? status : '';
}

function currentActivity(session) {
  const items = session.lifecycle || [];
  const running = [...items].reverse().find(item => item.status === 'running');
  const last = running || items[items.length - 1];
  if (last) return { title: last.label || '활동', detail: last.detail || session.statusDetail || '', type: last.type || 'activity' };
  const message = (session.messages || [])[session.messages.length - 1];
  return { title: session.statusDetail || '잠시 쉬는 중', detail: message && message.text || '', type: 'activity' };
}

function isLiveSession(session) {
  return session && (session.status === 'running' || session.status === 'starting');
}

function readableActivityDetail(value) {
  const text = String(value || '').trim();
  if (!text || !/^[\[{]/.test(text)) return text;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return text;
    if (parsed.cell_id) return `실행 중인 작업 결과를 기다리는 중${parsed.yield_time_ms ? ` · 최대 ${Math.round(Number(parsed.yield_time_ms) / 1000)}초` : ''}`;
    if (parsed.command) return `명령 실행 · ${String(parsed.command).replace(/\s+/g, ' ').slice(0, 180)}`;
    if (parsed.path || parsed.file_path) return `파일 확인 · ${parsed.path || parsed.file_path}`;
    if (parsed.prompt) return `AI에게 맡긴 일 · ${String(parsed.prompt).replace(/\s+/g, ' ').slice(0, 180)}`;
    const summary = Object.entries(parsed).slice(0, 3).map(([key, item]) => `${key}: ${typeof item === 'object' ? '구조화 데이터' : item}`).join(' · ');
    return summary || text;
  } catch {
    return text;
  }
}

function latestWorkCopy(session) {
  const activity = currentActivity(session);
  if (activity.detail) return readableActivityDetail(activity.detail);
  const messages = session.messages || [];
  const assistant = [...messages].reverse().find(item => item.role === 'assistant' && item.text);
  if (assistant) return assistant.text;
  const tool = [...messages].reverse().find(item => item.role === 'tool');
  if (tool) return `${tool.title || '도구'} 실행 · ${tool.text || '결과를 기다리는 중'}`;
  return activity.title || session.statusDetail || '다음 할 일을 기다리는 중';
}

function statusIcon(type) {
  if (/tool/.test(type)) return '⌘';
  if (/reason/.test(type)) return '◌';
  if (/error|fail/.test(type)) return '!';
  if (/start|turn/.test(type)) return '↗';
  if (/end|complete/.test(type)) return '✓';
  return '·';
}

function renderProviderRail() {
  $('#providerRail').innerHTML = state.providers.map(provider => {
    const available = !!state.availability[provider.id];
    return `<div class="provider-rail-item ${available ? 'connected' : ''}" style="${providerStyle(provider.id)}">
      <span class="provider-mini-mark">${esc(provider.mark)}</span><strong>${esc(provider.label)}</strong>
      <small>${available ? '사용 가능' : '설치 필요'}</small><span class="connection-dot"></span>
    </div>`;
  }).join('');
}

function renderWorkspaces() {
  const list = $('#workspaceList');
  if (!state.workspaces.length) {
    list.innerHTML = '<div class="workspace-empty">＋ 버튼으로 자주 쓰는 작업 폴더를 등록할 수 있습니다.</div>';
    return;
  }
  list.innerHTML = `<div class="workspace-item ${state.workspace === 'all' ? 'selected' : ''}" data-workspace="all"><strong>모든 작업 폴더</strong></div>`
    + state.workspaces.map(item => `<div class="workspace-item ${state.workspace === item.path ? 'selected' : ''}" data-workspace="${esc(item.path)}" title="${esc(item.path)}"><strong>${esc(item.name)}</strong><button data-remove-workspace="${esc(item.path)}" title="목록에서 제거">×</button></div>`).join('');
}

function renderGlobalStats() {
  const totals = state.snapshot && state.snapshot.summary && state.snapshot.summary.totals || {};
  const items = [
    ['전체 대화와 작업', totals.sessions || 0, '개', ''],
    ['지금 일하는 AI', totals.active || 0, '개', 'live'],
    ['내 확인 기다림', totals.waiting || 0, '개', 'alert'],
    ['도움을 맡은 AI', totals.subagents || 0, '개', ''],
    ['사용한 토큰', compact(totals.usage && totals.usage.total), '개', ''],
  ];
  $('#globalStats').innerHTML = items.map(([label, value, unit, cls], index) => `<div class="global-stat ${cls}" data-motion-key="stat:${index}" data-motion-value="${esc(value)}"><span>${label}</span><strong>${esc(value)}</strong><em>${unit}</em></div>`).join('');
  $('#navAllCount').textContent = totals.sessions || 0;
  $('#navActiveCount').textContent = totals.active || 0;
  $('#navWaitingCount').textContent = totals.waiting || 0;
  $('#navTmuxCount').textContent = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.summary && state.snapshot.tmux.summary.aiPanes || 0;
}

function renderProviderOverview() {
  const summaries = state.snapshot && state.snapshot.summary && state.snapshot.summary.providers || state.providers;
  $('#providerOverview').innerHTML = summaries.map(provider => `<article class="provider-overview-card" data-provider-card="${esc(provider.id)}" data-motion-key="provider:${esc(provider.id)}" data-motion-value="${provider.active || 0}:${provider.sessions || 0}:${provider.usage && provider.usage.total || 0}" style="${providerStyle(provider.id)}">
    <div class="poc-head">
      <span class="provider-mark">${esc(provider.mark)}</span>
      <div><strong>${esc(provider.label)}</strong><small>${esc(provider.company)}</small></div>
      <span class="poc-state ${provider.installed ? 'online' : ''}">${provider.installed ? '사용 가능' : '설치 필요'}</span>
    </div>
    <div class="poc-metrics">
      <div><b>${provider.active || 0}</b><span>일하는 중</span></div>
      <div><b>${provider.sessions || 0}</b><span>전체 작업</span></div>
      <div><b>${compact(provider.usage && provider.usage.total)}</b><span>사용 토큰</span></div>
    </div>
  </article>`).join('');
}

function filteredSessions() {
  let sessions = [...(state.snapshot && state.snapshot.sessions || [])];
  if (state.view === 'active') sessions = sessions.filter(session => session.status === 'running' || session.status === 'starting');
  if (state.view === 'waiting') sessions = sessions.filter(session => session.status === 'waiting');
  if (state.provider !== 'all') sessions = sessions.filter(session => session.provider === state.provider);
  if (state.workspace !== 'all') sessions = sessions.filter(session => String(session.cwd || '').toLowerCase().startsWith(state.workspace.toLowerCase()));
  const query = state.search.trim().toLowerCase();
  if (query) {
    sessions = sessions.filter(session => [session.title, session.model, session.cwd, session.agentName, ...(session.messages || []).slice(-12).map(item => item.text)].join(' ').toLowerCase().includes(query));
  }
  if (state.sort === 'tokens') sessions.sort((a, b) => Number(b.usage && b.usage.total || 0) - Number(a.usage && a.usage.total || 0));
  else if (state.sort === 'context') sessions.sort((a, b) => Number(b.context && b.context.percent || 0) - Number(a.context && a.context.percent || 0));
  else sessions.sort((a, b) => {
    const activeA = a.status === 'running' || a.status === 'starting' ? 1 : 0;
    const activeB = b.status === 'running' || b.status === 'starting' ? 1 : 0;
    return activeB - activeA || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  return sessions;
}

function graphFilteredSessions() {
  let sessions = [...(state.snapshot && state.snapshot.sessions || [])];
  if (state.provider !== 'all') sessions = sessions.filter(session => session.provider === state.provider);
  if (state.workspace !== 'all') sessions = sessions.filter(session => String(session.cwd || '').toLowerCase().startsWith(state.workspace.toLowerCase()));
  const query = state.search.trim().toLowerCase();
  if (query) sessions = sessions.filter(session => [session.title, session.model, session.cwd, session.agentName, session.agentRole, ...(session.messages || []).map(item => item.text)].join(' ').toLowerCase().includes(query));
  return sessions;
}

function graphNode(session, options = {}) {
  const provider = providerInfo(session.provider);
  const activity = currentActivity(session);
  const context = session.context || {};
  const usage = session.usage || {};
  const percent = Math.max(0, Math.min(100, Number(context.percent || 0)));
  const running = isLiveSession(session);
  const childCount = (session.childIds || []).length;
  const role = session.parentId
    ? `도움 AI${session.agentName ? ` · ${session.agentName}` : ''}${session.agentRole ? ` / ${agentRoleLabel(session.agentRole)}` : ''}`
    : '일을 맡은 AI';
  return `<article class="agent-node ${running ? 'running' : ''} ${session.parentId ? 'child-agent' : 'root-agent'} ${options.focus ? 'is-focus' : ''}" data-motion-key="agent:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || '')}:${usage.total || 0}:${esc(session.status || '')}" style="${providerStyle(session.provider)}">
    <button class="agent-node-main" type="button" data-graph-focus="${esc(session.id)}" aria-label="${esc(role)} 관계 중심으로 보기">
      <span class="agent-node-top"><span class="provider-mark">${esc(provider.mark)}</span><span class="agent-identity"><b>${esc(role)}</b><small>${esc(provider.label)} · ${esc(session.model || '모델 정보 없음')}</small></span><span class="status-pill ${statusClass(session.status)}">${esc(STATUS[session.status] || session.status)}</span></span>
      <span class="agent-task-label">${session.parentId ? '도움을 맡은 일' : '전체 목표'}</span>
      <strong class="agent-task">${esc(session.title)}</strong>
      <span class="agent-current"><span><i>${statusIcon(activity.type)}</i><b>지금 하는 일</b></span><strong>${esc(latestWorkCopy(session))}</strong></span>
      <span class="agent-node-metrics"><span><small>기억 공간 사용</small><b>${context.window ? `${percent.toFixed(1)}%` : '--'}</b></span><span><small>사용 토큰</small><b>${compact(usage.total)}</b></span><span><small>마지막 활동</small><b>${esc(timeAgo(session.updatedAt))}</b></span></span>
      <span class="agent-node-gauge"><i style="width:${percent}%"></i></span>
    </button>
    <footer class="agent-node-footer"><span>${childCount ? `도움 AI ${childCount}명에게 나눔` : (session.parentId ? '도움을 맡은 AI' : '이 작업의 중심 AI')}</span><button type="button" data-open-session="${esc(session.id)}">대화 내용 보기 <b>↗</b></button></footer>
  </article>`;
}

function graphPath(session, byId) {
  const path = [];
  const seen = new Set();
  let current = session;
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return path;
}

function connectedGraphSessions(sessions) {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const included = new Set(sessions.filter(isLiveSession).map(session => session.id));
  const includeAncestors = session => {
    let current = session;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      included.add(current.id);
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : null;
    }
  };
  sessions.filter(isLiveSession).forEach(includeAncestors);
  for (const id of [...included]) {
    const session = byId.get(id);
    for (const childId of (session && session.childIds || [])) included.add(childId);
  }
  return { byId, included, nodes: sessions.filter(session => included.has(session.id)) };
}

function sortGraphNodes(sessions) {
  return [...sessions].sort((a, b) => {
    const statusA = isLiveSession(a) ? 3 : (a.status === 'waiting' ? 2 : (a.status === 'failed' ? 1 : 0));
    const statusB = isLiveSession(b) ? 3 : (b.status === 'waiting' ? 2 : (b.status === 'failed' ? 1 : 0));
    return statusB - statusA || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
  });
}

function graphChildren(session, model) {
  return sortGraphNodes((session.childIds || []).map(id => model.byId.get(id)).filter(Boolean));
}

function graphDescendantCount(session, model) {
  const queue = [...(session.childIds || [])];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id) || !model.byId.has(id)) continue;
    seen.add(id);
    queue.push(...(model.byId.get(id).childIds || []));
  }
  return seen.size;
}

function compactGraphNode(session, model, label = '') {
  const provider = providerInfo(session.provider);
  const usage = session.usage || {};
  const directChildren = graphChildren(session, model).length;
  const identity = session.parentId ? `도움 AI ${session.agentName || agentRoleLabel(session.agentRole)}` : (session.workspace || '중심 작업');
  return `<button type="button" class="agent-flow-row ${isLiveSession(session) ? 'running' : ''}" data-graph-focus="${esc(session.id)}" data-motion-key="agent:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || '')}:${usage.total || 0}:${esc(session.status || '')}" style="${providerStyle(session.provider)}">
    <span class="agent-flow-state" aria-hidden="true"></span>
    <span class="agent-flow-copy">${label ? `<small>${esc(label)}</small>` : ''}<b>${esc(session.title)}</b><em>${esc(identity)} · ${directChildren ? `도움 AI ${directChildren}명 · ` : ''}${esc(timeAgo(session.updatedAt))}</em></span>
    <span class="agent-flow-provider"><i>${esc(provider.mark)}</i><small>${esc(STATUS[session.status] || session.status)}</small></span>
  </button>`;
}

function providerFlowLane(providerId, roots, model) {
  const provider = providerInfo(providerId);
  const ordered = sortGraphNodes(roots);
  const expanded = state.graphExpandedProviders.has(providerId);
  const shown = expanded ? ordered : ordered.slice(0, 6);
  const hidden = Math.max(0, ordered.length - shown.length);
  const agents = ordered.reduce((total, root) => total + 1 + graphDescendantCount(root, model), 0);
  return `<section class="agent-flow-lane" style="${providerStyle(providerId)}">
    <header class="agent-flow-lane-head"><span class="provider-mark">${esc(provider.mark)}</span><span><b>${esc(provider.label)}</b><small>${ordered.length}개 큰 일 · 참여 AI ${agents}명</small></span><em>${ordered.filter(isLiveSession).length}개 진행 중</em></header>
    <div class="agent-flow-list">${shown.map(root => compactGraphNode(root, model)).join('')}</div>
    ${hidden ? `<button type="button" class="agent-flow-more" data-graph-provider-more="${esc(providerId)}">나머지 ${hidden}개 일도 보기</button>` : (expanded && ordered.length > 6 ? `<button type="button" class="agent-flow-more" data-graph-provider-less="${esc(providerId)}">간단히 보기</button>` : '')}
  </section>`;
}

function workflowCompactNode(session, model, side, label) {
  const port = side === 'upstream' ? '<span class="agent-workflow-port output" data-workflow-port="upstream-output" aria-hidden="true"></span>' : `<span class="agent-workflow-port input" data-workflow-port="child-input:${esc(session.id)}" aria-hidden="true"></span>`;
  return `<div class="agent-workflow-node ${side}" data-workflow-node="${esc(session.id)}">${port}${compactGraphNode(session, model, label)}</div>`;
}

function agentCommandTargets(session) {
  try {
    return window.LodestarTerminal && typeof window.LodestarTerminal.agentTargets === 'function'
      ? window.LodestarTerminal.agentTargets(session) : [];
  } catch {
    return [];
  }
}

function agentControlMode(session, targets) {
  if (targets.length) return 'direct';
  if (session.provider === 'codex' && session.clientKind === 'codex-desktop') return 'origin';
  if (isLiveSession(session)) return 'connect';
  return 'ended';
}

function agentCommandComposer(session) {
  const targets = agentCommandTargets(session);
  const mode = agentControlMode(session, targets);
  const savedTarget = state.agentCommandTargets.get(session.id) || '';
  const targetId = targets.some(target => target.id === savedTarget) ? savedTarget : (targets.length === 1 ? targets[0].id : '');
  if (targetId) state.agentCommandTargets.set(session.id, targetId);
  const target = targets.find(item => item.id === targetId) || null;
  const draft = state.agentCommandDrafts.get(session.id) || '';
  const sending = state.agentCommandSending.has(session.id);
  const canSend = mode === 'direct' && Boolean(target) && !sending;
  const status = mode === 'direct'
    ? `직접 입력 가능 · ${targets.length === 1 ? target.label : `${targets.length}개 터미널 중 선택`}`
    : (mode === 'connect' ? '연결 후 입력 가능 · 현재 세션은 보기 전용' : (mode === 'origin' ? '보기 전용 · 원래 앱에서 계속' : '종료된 세션'));
  const help = mode === 'direct'
    ? 'Enter로 바로 보내고, Shift+Enter로 줄을 바꿀 수 있습니다.'
    : (mode === 'connect'
      ? `임의로 열린 터미널에는 입력하지 않습니다. 새 터미널에서 lodestar run ${session.provider}로 안전하게 연결할 수 있습니다.`
      : (mode === 'origin' ? '이 대화는 Codex 데스크톱 앱에서 시작되어 원래 작업으로 돌아갑니다.' : '실행이 끝난 AI의 기록에는 새 지시를 보내지 않습니다.'));
  const picker = targets.length > 1 ? `<label class="agent-command-target"><span>보낼 터미널</span><select data-agent-command-target="${esc(session.id)}"><option value="">터미널을 선택하세요</option>${targets.map(item => `<option value="${esc(item.id)}" ${item.id === targetId ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>` : '';
  const actions = mode === 'direct'
    ? `<button type="button" data-agent-terminal-open="${esc(session.id)}" ${canSend ? '' : 'disabled'}>터미널에서 열기</button><button type="submit" ${canSend ? '' : 'disabled'}>${sending ? '보내는 중…' : '바로 보내기 ↵'}</button>`
    : (mode === 'connect'
      ? `<button type="button" data-agent-bridge-copy="${esc(session.provider)}">연결 명령 복사</button>`
      : (mode === 'origin' ? `<button type="button" data-agent-open-origin="${esc(session.id)}">원래 Codex 앱에서 계속하기</button>` : ''));
  const placeholder = mode === 'direct' ? '예: 지금 변경한 파일을 테스트하고 실패 원인을 알려줘' : status;
  return `<form class="agent-command-panel ${mode === 'direct' ? 'connected' : 'unavailable'} control-${mode}" data-agent-command-form="${esc(session.id)}">
    <header><span class="agent-command-icon" aria-hidden="true">›_</span><span><b>이 AI에게 바로 지시하기</b><small>${esc(status)}</small></span><i class="${mode === 'direct' ? 'connected' : ''}" aria-hidden="true"></i></header>
    ${picker}
    <label class="agent-command-input"><span class="sr-only">AI에게 보낼 터미널 지시</span><textarea data-agent-command-draft="${esc(session.id)}" maxlength="8000" rows="3" placeholder="${esc(placeholder)}" ${mode === 'direct' ? '' : 'disabled'}>${mode === 'direct' ? esc(draft) : ''}</textarea></label>
    <div class="agent-command-actions"><small aria-live="polite">${esc(help)}</small>${actions}</div>
  </form>`;
}

function focusedGraph(focus, model, motionKind = 'refresh') {
  const parent = focus.parentId ? model.byId.get(focus.parentId) : null;
  const children = graphChildren(focus, model);
  const upstream = parent
    ? workflowCompactNode(parent, model, 'upstream', parent.parentId ? '이전 AI로 돌아가기' : '메인 AI로 돌아가기')
    : `<div class="agent-workflow-origin"><span class="workflow-origin-icon">◎</span><span><b>사용자 요청</b><small>이 작업이 시작된 곳</small></span><span class="agent-workflow-port output" data-workflow-port="upstream-output" aria-hidden="true"></span></div>`;
  const downstream = children.length
    ? children.map(child => workflowCompactNode(child, model, 'downstream', agentRoleLabel(child.agentRole))).join('')
    : '<div class="agent-workflow-empty">아직 다른 AI에게 나눠 맡긴 일이 없습니다.</div>';
  const connectMotion = ['focus', 'focus-back', 'view'].includes(motionKind) ? 'motion-connect' : '';
  return `<div class="agent-workflow-canvas ${connectMotion}" data-workflow-focus="${esc(focus.id)}">
    <svg class="agent-workflow-edges" role="img" aria-label="일을 맡긴 AI에서 선택한 AI를 거쳐 도움 AI로 이어지는 연결"><title>AI 작업 연결</title><desc>왼쪽은 일을 맡긴 곳, 가운데는 선택한 AI, 오른쪽은 나눠 맡긴 AI입니다.</desc><defs><marker id="workflowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"></path></marker></defs><g data-workflow-paths></g></svg>
    <div class="agent-workflow-grid">
      <section class="agent-workflow-column upstream-column"><header><b>${parent ? '이 일을 맡긴 AI' : '작업 시작점'}</b><span>${parent ? '왼쪽을 눌러 이전으로 돌아가요' : '사용자가 처음 맡긴 일'}</span></header><div class="agent-workflow-stack">${upstream}</div></section>
      <section class="agent-workflow-column selected-column"><header><b>지금 선택한 AI</b><span>${focus.parentId ? '도움을 나눠 맡은 AI' : '전체 일을 맡은 메인 AI'}</span></header><div class="agent-workflow-selected-stack"><div class="agent-workflow-selected"><span class="agent-workflow-port input" data-workflow-port="focus-input" aria-hidden="true"></span>${graphNode(focus, { focus: true })}<span class="agent-workflow-port output" data-workflow-port="focus-output" aria-hidden="true"></span></div>${agentCommandComposer(focus)}</div></section>
      <section class="agent-workflow-column downstream-column"><header><b>이 AI가 나눠 맡긴 일</b><span>${children.length}개 · 오른쪽으로 이어져요</span></header><div class="agent-workflow-stack downstream-stack">${downstream}</div></section>
    </div>
  </div>`;
}

let agentWorkflowFrame = 0;

function workflowPortPoint(port, canvasRect) {
  const rect = port.getBoundingClientRect();
  return { x: rect.left - canvasRect.left + rect.width / 2, y: rect.top - canvasRect.top + rect.height / 2 };
}

function workflowCurve(from, to) {
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  if (horizontal) {
    const distance = Math.max(34, Math.abs(to.x - from.x) * .48);
    return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${(from.x + distance).toFixed(1)} ${from.y.toFixed(1)}, ${(to.x - distance).toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
  }
  const distance = Math.max(34, Math.abs(to.y - from.y) * .48);
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${from.x.toFixed(1)} ${(from.y + distance).toFixed(1)}, ${to.x.toFixed(1)} ${(to.y - distance).toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function drawAgentWorkflowConnections() {
  const canvas = document.querySelector('.agent-workflow-canvas');
  if (!canvas || !canvas.isConnected) return;
  const svg = canvas.querySelector('.agent-workflow-edges');
  const paths = svg && svg.querySelector('[data-workflow-paths]');
  const upstream = canvas.querySelector('[data-workflow-port="upstream-output"]');
  const focusInput = canvas.querySelector('[data-workflow-port="focus-input"]');
  const focusOutput = canvas.querySelector('[data-workflow-port="focus-output"]');
  if (!svg || !paths || !upstream || !focusInput || !focusOutput) return;
  const rect = canvas.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
  const edges = [{ from: upstream, to: focusInput, tone: 'upstream' }];
  canvas.querySelectorAll('[data-workflow-port^="child-input:"]').forEach(port => edges.push({ from: focusOutput, to: port, tone: 'downstream' }));
  paths.innerHTML = edges.map(edge => `<path class="agent-workflow-edge ${edge.tone}" pathLength="1" d="${workflowCurve(workflowPortPoint(edge.from, rect), workflowPortPoint(edge.to, rect))}" marker-end="url(#workflowArrow)"></path>`).join('');
}

function scheduleAgentWorkflowConnections() {
  cancelAnimationFrame(agentWorkflowFrame);
  agentWorkflowFrame = requestAnimationFrame(() => requestAnimationFrame(drawAgentWorkflowConnections));
}

function renderAgentMap(sessions, motionKind = 'refresh') {
  const model = connectedGraphSessions(sessions);
  const focus = state.graphFocusId && model.byId.get(state.graphFocusId) && model.included.has(state.graphFocusId)
    ? model.byId.get(state.graphFocusId) : null;
  if (state.graphFocusId && !focus) state.graphFocusId = null;
  const roots = sortGraphNodes(model.nodes.filter(session => !session.parentId || !model.included.has(session.parentId)));
  if (!model.nodes.length) {
    $('#liveSessionGrid').innerHTML = '';
    $('#graphBreadcrumbs').innerHTML = '';
    $('#graphResetBtn').classList.add('hidden');
    return 0;
  }

  if (focus) {
    $('#liveSessionGrid').innerHTML = focusedGraph(focus, model, motionKind);
    const path = graphPath(focus, model.byId);
    $('#graphBreadcrumbs').innerHTML = `<button type="button" data-graph-reset>작업 목록</button>${path.map(item => `<i>›</i><button type="button" data-graph-focus="${esc(item.id)}" class="${item.id === focus.id ? 'current' : ''}">${esc(item.parentId ? (item.agentName || agentRoleLabel(item.agentRole)) : item.title)}</button>`).join('')}`;
    $('#graphResetBtn').classList.remove('hidden');
    scheduleAgentWorkflowConnections();
  } else {
    const providerOrder = [...new Set([...state.providers.map(item => item.id), ...roots.map(item => item.provider)])];
    const lanes = providerOrder.map(providerId => ({ providerId, roots: roots.filter(root => root.provider === providerId) })).filter(item => item.roots.length);
    $('#liveSessionGrid').innerHTML = `<div class="agent-flow-overview">${lanes.map(item => providerFlowLane(item.providerId, item.roots, model)).join('')}</div>`;
    $('#graphBreadcrumbs').innerHTML = `<span class="map-hint"><b>${roots.length}</b>개 큰 일 · <b>${model.nodes.filter(item => item.parentId).length}</b>개 도움 AI · AI별 최근 6개씩 보여주는 중</span>`;
    $('#graphResetBtn').classList.add('hidden');
  }
  return model.nodes.filter(isLiveSession).length;
}

function tmuxEntities(tmux) {
  const distros = new Map();
  const sessions = new Map();
  const windows = new Map();
  const panes = new Map();
  for (const distro of tmux && tmux.distros || []) {
    distros.set(distro.id, distro);
    for (const tmuxSession of distro.sessions || []) {
      sessions.set(tmuxSession.id, { item: tmuxSession, distro });
      for (const window of tmuxSession.windows || []) {
        windows.set(window.id, { item: window, session: tmuxSession, distro });
        for (const pane of window.panes || []) panes.set(pane.id, { item: pane, window, session: tmuxSession, distro });
      }
    }
  }
  return { distros, sessions, windows, panes };
}

function tmuxFocusPath(index) {
  const focus = state.tmuxFocus;
  if (!focus) return [];
  if (focus.type === 'distro') {
    const distro = index.distros.get(focus.id);
    return distro ? [{ type: 'distro', id: distro.id, label: distro.name }] : [];
  }
  if (focus.type === 'session') {
    const found = index.sessions.get(focus.id);
    return found ? [{ type: 'distro', id: found.distro.id, label: found.distro.name }, { type: 'session', id: found.item.id, label: found.item.name }] : [];
  }
  if (focus.type === 'window') {
    const found = index.windows.get(focus.id);
    return found ? [{ type: 'distro', id: found.distro.id, label: found.distro.name }, { type: 'session', id: found.session.id, label: found.session.name }, { type: 'window', id: found.item.id, label: `${found.item.index}:${found.item.name}` }] : [];
  }
  const found = index.panes.get(focus.id);
  return found ? [{ type: 'distro', id: found.distro.id, label: found.distro.name }, { type: 'session', id: found.session.id, label: found.session.name }, { type: 'window', id: found.window.id, label: `${found.window.index}:${found.window.name}` }, { type: 'pane', id: found.item.id, label: `pane ${found.item.index}` }] : [];
}

function tmuxPaneCard(pane) {
  const agent = pane.agent;
  const provider = agent && providerInfo(agent.provider);
  const context = agent && agent.context || {};
  const usage = agent && agent.usage || {};
  const percent = Math.max(0, Math.min(100, Number(context.percent || 0)));
  return `<article class="tmux-pane-node ${pane.active ? 'active' : ''} ${pane.dead ? 'dead' : ''} ${agent ? 'has-agent' : ''}" ${agent ? `style="${providerStyle(agent.provider)}"` : ''}>
    <button type="button" class="tmux-pane-main" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}">
      <span class="tmux-pane-head"><b>나눠진 칸 ${pane.index + 1}</b><span>프로그램 ${pane.pid || '--'}</span><i>${pane.dead ? '끝남' : (pane.active ? '사용 중' : '뒤에서 실행')}</i></span>
      <strong class="tmux-pane-command">${esc(pane.command || 'shell')}</strong>
      <span class="tmux-pane-cwd" title="${esc(pane.cwd)}">${esc(pane.cwd || '경로 미보고')}</span>
      ${agent ? `<span class="tmux-agent-block"><span class="provider-mark">${esc(provider.mark)}</span><span><small>${esc(provider.label)} · 실행 번호 ${agent.pid}</small><strong>${esc(agent.title)}</strong><em>${esc(agent.statusDetail)}</em></span></span>
        <span class="tmux-agent-metrics"><span><small>기억 사용</small><b>${context.window ? `${percent.toFixed(1)}%` : '--'}</b></span><span><small>사용 토큰</small><b>${compact(usage.total)}</b></span><span><small>도움 AI</small><b>${(agent.childIds || []).length}</b></span></span>
        <span class="tmux-context-track"><i style="width:${percent}%"></i></span>` : '<span class="tmux-shell-note">AI가 아닌 일반 명령창입니다.</span>'}
    </button>
    <footer><span>${agent ? (agent.linkedSessionId ? '대화 기록과 연결됨' : 'AI가 실행 중인 것을 확인함') : pane.title || '명령창'}</span><span class="tmux-pane-actions"><button type="button" data-control-tmux="${esc(pane.id)}">이 칸 조작하기 ↓</button>${agent && agent.linkedSessionId ? `<button type="button" data-open-session="${esc(agent.linkedSessionId)}">대화 내용 보기 ↗</button>` : ''}</span></footer>
  </article>`;
}

function tmuxWindowTree(window) {
  return `<div class="tmux-window-tree"><button type="button" class="tmux-window-node ${window.active ? 'active' : ''}" data-tmux-type="window" data-tmux-id="${esc(window.id)}"><small>열린 창</small><strong>${window.index + 1}. ${esc(window.name)}</strong><span>${window.panes.length}개 칸으로 나눔</span></button><div class="tmux-link-line" aria-hidden="true"><i></i></div><div class="tmux-pane-stack">${window.panes.map(tmuxPaneCard).join('')}</div></div>`;
}

function tmuxSessionTree(tmuxSession) {
  return `<div class="tmux-session-tree"><button type="button" class="tmux-session-node ${tmuxSession.attached ? 'attached' : ''}" data-tmux-type="session" data-tmux-id="${esc(tmuxSession.id)}"><small>작업 묶음</small><strong>${esc(tmuxSession.name)}</strong><span>${tmuxSession.attached ? '화면에 연결됨' : '뒤에서 실행 중'} · 열린 창 ${tmuxSession.windows.length}개</span></button><div class="tmux-link-line session-link" aria-hidden="true"><i></i></div><div class="tmux-window-stack">${tmuxSession.windows.map(tmuxWindowTree).join('')}</div></div>`;
}

function filteredTmuxDistros(tmux, index) {
  if (!state.tmuxFocus) return tmux.distros || [];
  const path = tmuxFocusPath(index);
  if (!path.length) {
    state.tmuxFocus = null;
    return tmux.distros || [];
  }
  const distroId = path[0].id;
  return (tmux.distros || []).filter(distro => distro.id === distroId).map(distro => ({
    ...distro,
    sessions: (distro.sessions || []).filter(tmuxSession => {
      const target = path.find(item => item.type === 'session');
      return !target || tmuxSession.id === target.id;
    }).map(tmuxSession => ({
      ...tmuxSession,
      windows: (tmuxSession.windows || []).filter(window => {
        const target = path.find(item => item.type === 'window');
        return !target || window.id === target.id;
      }).map(window => ({
        ...window,
        panes: (window.panes || []).filter(pane => {
          const target = path.find(item => item.type === 'pane');
          return !target || pane.id === target.id;
        }),
      })),
    })),
  }));
}

function renderTmuxMap() {
  const tmux = state.snapshot && state.snapshot.tmux || { available: false, status: '확인 중', distros: [], summary: {} };
  const summary = tmux.summary || {};
  $('#tmuxStats').innerHTML = [['Linux 환경', summary.distros || 0, '개'], ['작업 묶음', summary.sessions || 0, '개'], ['열린 창', summary.windows || 0, '개'], ['나눠진 칸', summary.panes || 0, '개'], ['AI가 일하는 칸', summary.aiPanes || 0, '개'], ['대화 기록 연결', summary.linked || 0, '개']].map(([label, value, unit], index) => `<div class="${index >= 4 ? 'accent' : ''}"><span>${label}</span><strong>${value}</strong><small>${unit}</small></div>`).join('');
  const index = tmuxEntities(tmux);
  const path = tmuxFocusPath(index);
  $('#tmuxBreadcrumbs').innerHTML = path.length ? `<button type="button" data-tmux-reset>전체 목록</button>${path.map(item => `<i>›</i><button type="button" class="${item.type === state.tmuxFocus.type && item.id === state.tmuxFocus.id ? 'current' : ''}" data-tmux-type="${item.type}" data-tmux-id="${esc(item.id)}">${esc(item.label)}</button>`).join('')}` : `<span class="map-hint"><b>${summary.sessions || 0}</b>개 작업 묶음 · <b>${summary.aiPanes || 0}</b>개 칸에서 AI가 일하는 중</span>`;
  $('#tmuxResetBtn').classList.toggle('hidden', !path.length);
  const distros = filteredTmuxDistros(tmux, index);
  if (!distros.length || !Number(summary.sessions || 0)) {
    $('#tmuxMap').innerHTML = `<div class="tmux-empty"><span>▦</span><h3>나눠서 실행 중인 명령창이 없습니다</h3><p>${esc(tmux.status || 'Linux 명령창 상태를 확인하는 중입니다.')}</p><small>이 화면은 tmux를 사용하는 고급 작업이 있을 때 자동으로 채워집니다.</small></div>`;
    return;
  }
  $('#tmuxMap').innerHTML = distros.map(distro => `<section class="tmux-distro-group"><button type="button" class="tmux-distro-node" data-tmux-type="distro" data-tmux-id="${esc(distro.id)}"><span>Linux</span><div><small>실행 환경</small><strong>${esc(distro.name)}</strong><em>${esc(distro.tmuxVersion || 'tmux')}</em></div><b>작업 묶음 ${distro.sessions.length}개</b></button><div class="tmux-distro-line" aria-hidden="true"></div><div class="tmux-session-stack">${distro.sessions.map(tmuxSessionTree).join('')}</div></section>`).join('');
}

function recentConversation(session) {
  const messages = (session.messages || []).filter(message => message && message.text && message.role !== 'system');
  const user = [...messages].reverse().find(message => message.role === 'user');
  const assistant = [...messages].reverse().find(message => message.role === 'assistant');
  const tool = [...messages].reverse().find(message => message.role === 'tool');
  const rows = [];
  if (user) rows.push({ label: '나', text: user.text, tone: 'user' });
  if (assistant) rows.push({ label: providerInfo(session.provider).label, text: assistant.text, tone: 'assistant' });
  else if (tool) rows.push({ label: tool.title || '도구', text: tool.text, tone: 'tool' });
  if (!rows.length) rows.push({ label: '상태', text: session.statusDetail || '대화 이벤트를 기다리는 중입니다.', tone: 'system' });
  return rows.slice(-2);
}

function sessionCard(session, opts = {}) {
  const provider = providerInfo(session.provider);
  const usage = session.usage || {};
  const context = session.context || {};
  const activity = currentActivity(session);
  const running = session.status === 'running' || session.status === 'starting';
  const children = session.childIds || [];
  const model = session.model || '사용 모델 정보 없음';
  const contextPercent = Math.max(0, Math.min(100, Number(context.percent || 0)));
  const remaining = context.window ? Math.max(0, Number(context.window) - Number(context.used || 0)) : 0;
  const gaugeTone = contextPercent >= 90 ? 'critical' : (contextPercent >= 75 ? 'warning' : 'safe');
  const conversation = recentConversation(session);
  const runtime = session.runtimePresence || [];
  return `<article class="session-card ${opts.live ? 'live-card' : ''} ${statusClass(session.status)} ${session.parentId ? 'subagent' : ''}" data-session-id="${esc(session.id)}" data-motion-key="session:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || '')}:${usage.total || 0}:${esc(session.status || '')}" style="${providerStyle(session.provider)}">
    <div class="card-head">
      <span class="provider-mark">${esc(provider.mark)}</span>
      <div class="card-head-main"><div class="card-provider-line"><b>${esc(provider.label)}</b><span>${esc(provider.company)}</span></div></div>
      <span class="status-pill ${statusClass(session.status)}">${esc(STATUS[session.status] || session.status)}</span>
    </div>
    <h3 class="card-title" title="${esc(session.title)}">${esc(session.title)}</h3>
    <div class="card-subtitle"><span>${esc(model)}</span><i></i><span title="${esc(session.cwd)}">${esc(session.workspace || '작업 폴더 미상')}</span>${session.agentName ? `<i></i><span>${esc(session.agentName)}</span>` : ''}</div>
    <div class="now-strip ${running ? 'is-live' : ''}">
      <span class="now-strip-icon">${statusIcon(activity.type)}</span>
      <div><b>${running ? '지금: ' : ''}${esc(activity.title)}</b><span>${esc(latestWorkCopy(session) || session.statusDetail || '새 이벤트 대기')}</span></div>
      ${running ? '<span class="activity-wave"><i></i><i></i><i></i><i></i><i></i></span>' : ''}
    </div>
    ${runtime.length ? `<div class="runtime-strip"><span class="runtime-pulse"></span><b>실제로 실행 중인 프로그램 ${runtime.length}개</b><span>${esc(runtime.map(item => item.label || `프로그램 ${item.pid}`).join(' · '))}</span></div>` : ''}
    <div class="conversation-preview">
      ${conversation.map(row => `<div class="preview-line ${row.tone}"><b>${esc(row.label)}</b><span>${esc(row.text)}</span></div>`).join('')}
    </div>
    <div class="context-meter ${gaugeTone}">
      <div class="context-meter-head"><div><span>AI의 기억 공간 사용량</span><strong>${context.window ? `${fullNumber(context.used)} / ${fullNumber(context.window)}` : `${fullNumber(context.used)} / --`}</strong></div><b>${context.window ? `${contextPercent.toFixed(1)}%` : '--'}</b></div>
      <div class="context-meter-track"><span style="width:${contextPercent}%"></span><i style="left:75%"></i><i style="left:90%"></i></div>
      <div class="context-meter-foot"><span>${context.window ? `아직 ${compact(remaining)} 토큰만큼 기억 가능` : '기억 공간 크기 정보 없음'}</span><span>지금까지 ${compact(usage.total)} 토큰 사용</span></div>
    </div>
    <div class="token-row">
      <div><span>받은 글</span><b>${compact(usage.input)}</b></div><div><span>AI가 쓴 글</span><b>${compact(usage.output)}</b></div><div><span>다시 쓴 기억</span><b>${compact(usage.cachedInput)}</b></div><div class="total"><span>전체 사용</span><b>${compact(usage.total)}</b></div>
    </div>
    ${children.length ? `<div class="child-row"><b>⑂</b><span>도움 AI ${children.length}명과 함께 일함</span><span class="child-dots">${children.slice(0, 4).map(() => '<i></i>').join('')}</span></div>` : ''}
    <footer class="card-footer"><span class="source-tag">${esc(session.sourceLabel || '내 PC의 작업 기록')}</span><span>${esc(timeAgo(session.updatedAt))}</span></footer>
  </article>`;
}

function renderSessions(motionKind = 'refresh', deferMotion = false) {
  const previousLayout = deferMotion ? null : captureMotionLayout();
  const tmuxView = state.view === 'tmux';
  const terminalView = state.view === 'terminal';
  $('#terminalSection').classList.toggle('hidden', !terminalView);
  $('#tmuxSection').classList.toggle('hidden', !tmuxView);
  $('#globalStats').classList.toggle('hidden', tmuxView || terminalView);
  $('#providerOverview').classList.toggle('hidden', tmuxView || terminalView);
  $('#sessionSection').classList.toggle('hidden', tmuxView || terminalView);
  $('#beginnerGuide').classList.toggle('hidden', tmuxView || terminalView);
  if (terminalView) {
    $('#liveSection').classList.add('hidden');
    if (window.LodestarTerminal) window.LodestarTerminal.activate(state.snapshot, state.workspaces, 'general');
    if (!deferMotion) playMotionLayout(previousLayout, motionKind);
    if (motionKind === 'view') animateVisibleSections();
    return;
  }
  if (tmuxView) {
    $('#liveSection').classList.add('hidden');
    renderTmuxMap();
    if (window.LodestarTerminal) window.LodestarTerminal.activate(state.snapshot, state.workspaces, 'tmux');
    if (!deferMotion) playMotionLayout(previousLayout, motionKind);
    if (motionKind === 'view') animateVisibleSections();
    return;
  }
  if (window.LodestarTerminal) window.LodestarTerminal.deactivate();
  const sessions = filteredSessions();
  const showMap = ['all', 'active'].includes(state.view);
  const graphLiveCount = showMap ? renderAgentMap(graphFilteredSessions(), motionKind) : 0;
  const regular = state.view === 'all' ? sessions.filter(session => !isLiveSession(session)) : (state.view === 'active' ? [] : sessions);
  const visible = regular.slice(0, state.visibleLimit);
  $('#liveSection').classList.toggle('hidden', graphLiveCount === 0);
  $('#viewTitle').textContent = VIEW_TITLES[state.view] || '최근 대화와 작업';
  $('#sessionGrid').innerHTML = visible.map(session => sessionCard(session)).join('');
  $('#sessionGrid').classList.toggle('hidden', visible.length === 0);
  $('#loadMoreBtn').classList.toggle('hidden', regular.length <= state.visibleLimit);
  $('#loadMoreBtn').textContent = `작업 더 보기 · ${regular.length - state.visibleLimit}개 남음`;
  $('#emptyState').classList.toggle('hidden', graphLiveCount + regular.length !== 0);
  if (!deferMotion) playMotionLayout(previousLayout, motionKind);
  if (motionKind === 'view') animateVisibleSections();
}

function render(motionKind = 'refresh') {
  const previousLayout = captureMotionLayout();
  renderProviderRail();
  renderWorkspaces();
  renderGlobalStats();
  renderProviderOverview();
  renderSessions(motionKind, true);
  if (state.selectedId && $('#detailDrawer').classList.contains('open')) renderDrawer();
  playMotionLayout(previousLayout, motionKind);
  if (motionKind === 'view') animateVisibleSections();
}

function selectedSession() {
  return state.details.get(state.selectedId)
    || (state.snapshot && state.snapshot.sessions || []).find(session => session.id === state.selectedId)
    || null;
}

function snapshotSession(id) {
  return (state.snapshot && state.snapshot.sessions || []).find(session => session.id === id) || null;
}

function chosenAgentCommandTarget(session) {
  const targets = agentCommandTargets(session);
  const saved = state.agentCommandTargets.get(session.id) || '';
  if (saved) return targets.find(target => target.id === saved) || null;
  return targets.length === 1 ? targets[0] : null;
}

async function dispatchAgentCommand(sessionId, form) {
  const session = snapshotSession(sessionId);
  if (!session || !window.LodestarTerminal) return toast('선택한 AI의 최신 정보를 찾지 못했습니다.');
  const target = chosenAgentCommandTarget(session);
  const input = form.querySelector('[data-agent-command-draft]');
  const command = String(input && input.value || '').trim();
  if (!target) return toast(agentCommandTargets(session).length ? '지시를 보낼 터미널을 먼저 선택하세요.' : '이 AI에 연결된 입력 가능한 터미널이 없습니다.');
  if (!command) return toast('AI에게 보낼 지시를 입력하세요.');
  state.agentCommandSending.add(sessionId);
  const submit = form.querySelector('[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = '보내는 중…'; }
  try {
    await window.LodestarTerminal.dispatchAgentCommand(session, command, target.id);
    state.agentCommandDrafts.delete(sessionId);
    if (input) input.value = '';
    toast(`${target.label}에 지시를 보냈습니다.`);
  } catch (error) {
    toast(error && error.message || '터미널에 지시를 보내지 못했습니다.');
  } finally {
    state.agentCommandSending.delete(sessionId);
    if (submit && submit.isConnected) { submit.disabled = false; submit.textContent = '바로 보내기 ↵'; }
  }
}

async function openAgentTerminal(sessionId) {
  const session = snapshotSession(sessionId);
  if (!session || !window.LodestarTerminal) return toast('선택한 AI의 터미널 정보를 찾지 못했습니다.');
  const target = chosenAgentCommandTarget(session);
  if (!target) return toast(agentCommandTargets(session).length ? '열어볼 터미널을 먼저 선택하세요.' : '이 AI에 연결된 입력 가능한 터미널이 없습니다.');
  state.view = target.kind === 'tmux' ? 'tmux' : 'terminal';
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === state.view));
  renderSessions('view');
  try {
    await window.LodestarTerminal.openForAgent(session, target.id, state.agentCommandDrafts.get(sessionId) || '');
    $('#terminalCommandInput')?.scrollIntoView({ behavior: motionPreference.matches ? 'auto' : 'smooth', block: 'center' });
  } catch (error) {
    toast(error && error.message || 'AI의 터미널을 열지 못했습니다.');
  }
}

async function copyBridgeCommand(provider) {
  try {
    const result = await window.lodestar.bridgeCommand(provider);
    if (!result || !result.ok) throw new Error('연결 명령을 만들지 못했습니다.');
    const command = result.command;
    await window.lodestar.writeClipboard(command);
    toast(`${command} 명령을 복사했습니다.`);
  } catch (error) {
    toast(error && error.message || '연결 명령을 복사하지 못했습니다.');
  }
}

async function openSessionOrigin(sessionId) {
  const session = snapshotSession(sessionId);
  if (!session) return toast('원래 Codex 작업 정보를 찾지 못했습니다.');
  try {
    const result = await window.lodestar.openSessionOrigin(session);
    if (!result || !result.ok) return toast('이 작업은 Codex 앱에서 직접 열 수 없습니다.');
    toast('원래 Codex 작업을 열었습니다.');
  } catch (error) {
    toast(error && error.message || 'Codex 앱을 열지 못했습니다.');
  }
}

async function loadSessionDetail(id, force = false) {
  if (!force && state.details.has(id)) return state.details.get(id);
  state.detailLoading = true;
  renderDrawer();
  try {
    const detail = await window.lodestar.sessionDetail(id);
    if (detail) state.details.set(id, detail);
    return detail;
  } finally {
    state.detailLoading = false;
    if (state.selectedId === id) {
      state.drawerForceLatest = state.drawerTab === 'chat';
      renderDrawer();
    }
  }
}

function openDrawer(id) {
  state.selectedId = id;
  state.drawerTab = 'chat';
  state.drawerForceLatest = true;
  clearTimeout(motionState.drawerTimer);
  $('#drawerBackdrop').classList.remove('hidden');
  $('#drawerBackdrop').classList.remove('closing');
  $('#detailDrawer').classList.add('open');
  $('#detailDrawer').setAttribute('aria-hidden', 'false');
  renderDrawer();
  loadSessionDetail(id, true);
}

function closeDrawer() {
  if (!$('#detailDrawer').classList.contains('open')) return;
  $('#detailDrawer').classList.remove('open');
  $('#detailDrawer').setAttribute('aria-hidden', 'true');
  $('#drawerBackdrop').classList.add('closing');
  clearTimeout(motionState.drawerTimer);
  motionState.drawerTimer = setTimeout(() => {
    $('#drawerBackdrop').classList.add('hidden');
    $('#drawerBackdrop').classList.remove('closing');
  }, motionPreference.matches ? 0 : 260);
}

function chatHtml(session) {
  const messages = session.messages || [];
  if (!messages.length) return '<div class="empty-state"><h3>표시할 대화가 없습니다</h3></div>';
  return `<div class="chat-history-head"><span>시간순 대화 · ${messages.length}개</span><button type="button" data-scroll-latest>가장 최근 대화 ↓</button></div><div class="chat-list">${messages.map(message => {
    const role = message.role === 'assistant' ? 'assistant' : (message.role === 'tool' ? 'tool' : (message.role === 'system' ? 'system' : 'user'));
    const label = role === 'assistant' ? providerInfo(session.provider).label : (role === 'tool' ? (message.title || '도구') : (message.role === 'system' ? '시스템' : '사용자'));
    const avatar = role === 'assistant' ? providerInfo(session.provider).mark : (role === 'tool' ? '⌘' : (role === 'system' ? 'i' : 'ME'));
    return `<div class="chat-row ${role}" data-message-id="${esc(message.id || '')}"><span class="chat-avatar">${esc(avatar)}</span><div class="chat-bubble"><div class="chat-bubble-head"><b>${esc(label)}</b><span>${esc(timeOnly(message.timestamp))}</span>${message.status ? `<span>${esc(message.status)}</span>` : ''}</div>${messageContentHtml(message)}</div></div>`;
  }).join('')}<div class="chat-latest-anchor" aria-label="가장 최근 대화"></div></div>`;
}

function lifecycleHtml(session) {
  const events = session.lifecycle || [];
  if (!events.length) return '<div class="empty-state"><h3>아직 기록된 진행 과정이 없습니다</h3></div>';
  return `<div class="lifecycle-list">${events.map(event => `<div class="lifecycle-event ${esc(event.status)}"><span class="life-node">${statusIcon(event.type)}</span><div class="life-copy"><b>${esc(event.label)}</b><span>${esc(event.detail || event.type)}</span></div><time>${esc(timeOnly(event.timestamp))}</time></div>`).join('')}</div>`;
}

function tokensHtml(session) {
  const usage = session.usage || {};
  const turn = session.turnUsage || {};
  const context = session.context || {};
  const sourceLabel = context.source === 'session' ? '이 작업 기록에서 직접 확인한 기억 공간' : (context.source === 'model-catalog' ? 'AI 모델 정보에 적힌 기억 공간' : '기억 공간 크기 정보 없음');
  return `<div class="token-hero" style="--drawer-provider:${providerInfo(session.provider).accent}">
    <div class="token-hero-head"><span>AI의 기억 공간 사용량</span><b>${context.window ? `${fullNumber(context.used)} / ${fullNumber(context.window)} 토큰` : `${fullNumber(context.used)} 토큰`}</b></div>
    <div class="big-context"><span style="width:${Math.min(100, context.percent || 0)}%"></span></div>
    <div class="context-scale"><span>0</span><span>${(context.percent || 0).toFixed(1)}%</span><span>${context.window ? compact(context.window) : '--'}</span></div>
  </div>
  <div class="token-grid">
    <div class="token-tile"><span>AI가 받은 글</span><strong>${fullNumber(usage.input)}</strong><small>AI에게 전달된 내용의 양</small></div>
    <div class="token-tile"><span>AI가 쓴 글</span><strong>${fullNumber(usage.output)}</strong><small>AI가 답하고 만든 내용의 양</small></div>
    <div class="token-tile"><span>다시 사용한 기억</span><strong>${fullNumber(usage.cachedInput)}</strong><small>전에 읽은 내용을 다시 활용한 양</small></div>
    <div class="token-tile"><span>새로 저장한 기억</span><strong>${fullNumber(usage.cacheWrite)}</strong><small>다음에 다시 쓰도록 저장한 양</small></div>
    <div class="token-tile"><span>생각에 사용</span><strong>${fullNumber(usage.reasoning)}</strong><small>AI가 따로 알려준 경우만 표시</small></div>
    <div class="token-tile"><span>전체 사용량</span><strong>${fullNumber(usage.total)}</strong><small>이 작업에서 사용한 토큰 합계</small></div>
    <div class="token-tile"><span>최근에 받은 글</span><strong>${fullNumber(turn.input)}</strong><small>가장 최근 대화 기준</small></div>
    <div class="token-tile"><span>최근 대화 전체</span><strong>${fullNumber(turn.total)}</strong><small>가장 최근 한 번의 사용량</small></div>
  </div><div class="token-note">${esc(sourceLabel)}입니다. 토큰은 AI가 글을 읽고 쓰는 양을 세는 단위이고, 기억 공간은 AI가 한 번에 기억할 수 있는 양입니다.</div>`;
}

function renderDrawer() {
  const session = selectedSession();
  if (!session) return closeDrawer();
  const provider = providerInfo(session.provider);
  $('#detailDrawer').style.setProperty('--drawer-provider', provider.accent);
  $('#drawerProviderMark').style.setProperty('--provider', provider.accent);
  $('#drawerProviderMark').textContent = provider.mark;
  $('#drawerProvider').textContent = `${provider.company} · ${STATUS[session.status] || session.status}`;
  $('#drawerTitle').textContent = session.title;
  const stop = session.runId && (session.status === 'running' || session.status === 'starting') ? `<button class="meta-chip stop-run" data-stop-run="${esc(session.runId)}">■ 실행 중지</button>` : '';
  const runtime = session.runtimePresence || [];
  $('#drawerMeta').innerHTML = `<span class="meta-chip">사용 모델 <b>${esc(session.model || '정보 없음')}</b></span><span class="meta-chip">작업 폴더 <b title="${esc(session.cwd)}">${esc(session.workspace || session.cwd || '알 수 없음')}</b></span><span class="meta-chip">작업 번호 <b>${esc(session.externalId.slice(0, 12))}</b></span>${session.parentId ? '<span class="meta-chip">⑂ <b>도움을 맡은 AI</b></span>' : ''}${runtime.length ? `<span class="meta-chip runtime-meta">● <b>실행 중인 프로그램 ${runtime.length}개</b></span>` : ''}${stop}`;
  $$('.drawer-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === state.drawerTab));
  const content = $('#drawerContent');
  const previousTop = content.scrollTop;
  const wasNearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 90;
  const renderKey = `${state.selectedId}:${state.drawerTab}:${state.detailLoading ? 'loading' : 'ready'}`;
  const shouldAnimateContent = motionState.drawerRenderKey !== renderKey;
  motionState.drawerRenderKey = renderKey;
  content.innerHTML = state.detailLoading
    ? '<div class="drawer-loading"><span></span><b>전체 작업 기록을 불러오는 중</b><small>잠시만 기다리면 대화와 진행 과정을 볼 수 있어요.</small></div>'
    : (state.drawerTab === 'chat' ? chatHtml(session) : (state.drawerTab === 'lifecycle' ? lifecycleHtml(session) : tokensHtml(session)));
  content.classList.toggle('motion-content-in', shouldAnimateContent && !motionPreference.matches);
  clearTimeout(motionState.drawerContentTimer);
  if (shouldAnimateContent) motionState.drawerContentTimer = setTimeout(() => content.classList.remove('motion-content-in'), motionPreference.matches ? 0 : 520);
  if (!state.detailLoading) requestAnimationFrame(() => {
    if (state.drawerTab === 'chat' && (state.drawerForceLatest || wasNearBottom)) content.scrollTop = content.scrollHeight;
    else content.scrollTop = Math.min(previousTop, Math.max(0, content.scrollHeight - content.clientHeight));
    state.drawerForceLatest = false;
  });
}

function providerPickerHtml() {
  return state.providers.map(provider => {
    const installed = !!state.availability[provider.id];
    return `<button type="button" class="run-provider-option ${state.runProvider === provider.id ? 'selected' : ''}" data-run-provider="${esc(provider.id)}" style="${providerStyle(provider.id)}" ${installed ? '' : 'disabled'}><span class="provider-mini-mark">${esc(provider.mark)}</span><small>${esc(provider.label)}${installed ? '' : ' · 미설치'}</small></button>`;
  }).join('');
}

function openRunModal() {
  const installed = state.providers.find(provider => state.availability[provider.id]);
  if (!state.availability[state.runProvider] && installed) state.runProvider = installed.id;
  $('#runProviderPicker').innerHTML = providerPickerHtml();
  if (!$('#runCwd').value) $('#runCwd').value = state.workspace !== 'all' ? state.workspace : (state.workspaces[0] && state.workspaces[0].path || '');
  $('#runError').classList.add('hidden');
  clearTimeout(motionState.modalTimer);
  $('#runModal').classList.remove('hidden', 'closing');
  setTimeout(() => $('#runPrompt').focus(), 0);
}

function closeRunModal() {
  const modal = $('#runModal');
  if (modal.classList.contains('hidden') || modal.classList.contains('closing')) return;
  modal.classList.add('closing');
  clearTimeout(motionState.modalTimer);
  motionState.modalTimer = setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('closing');
  }, motionPreference.matches ? 0 : 220);
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden', 'leaving');
  clearTimeout(motionState.toastTimer);
  motionState.toastTimer = setTimeout(() => {
    el.classList.add('leaving');
    motionState.toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('leaving');
    }, motionPreference.matches ? 0 : 220);
  }, 3200);
}

async function handleRun(event) {
  event.preventDefault();
  const submit = $('#runForm button[type="submit"]');
  submit.disabled = true;
  $('#runError').classList.add('hidden');
  try {
    const result = await window.lodestar.runAgent({
      provider: state.runProvider,
      cwd: $('#runCwd').value.trim(),
      model: $('#runModel').value.trim(),
      prompt: $('#runPrompt').value.trim(),
      allowWrites: $('#allowWrites').checked,
    });
    if (!result.ok) throw new Error(result.error || '실행을 시작하지 못했습니다.');
    closeRunModal();
    $('#runPrompt').value = '';
    toast(`${providerInfo(state.runProvider).label} 작업을 시작했습니다.`);
  } catch (error) {
    $('#runError').textContent = error.message;
    $('#runError').classList.remove('hidden');
  } finally {
    submit.disabled = false;
  }
}

function bindEvents() {
  $('.view-nav').addEventListener('click', event => {
    const button = event.target.closest('.nav-item');
    if (!button) return;
    state.view = button.dataset.view;
    state.visibleLimit = 30;
    $$('.nav-item').forEach(item => item.classList.toggle('active', item === button));
    renderSessions('view');
  });
  $('#providerOverview').addEventListener('click', event => {
    const card = event.target.closest('[data-provider-card]');
    if (!card) return;
    state.provider = state.provider === card.dataset.providerCard ? 'all' : card.dataset.providerCard;
    state.visibleLimit = 30;
    $('#providerFilter').value = state.provider;
    renderSessions('filter');
  });
  $('#sessionGrid').addEventListener('click', event => {
    const card = event.target.closest('[data-session-id]');
    if (card) openDrawer(card.dataset.sessionId);
  });
  $('#liveSessionGrid').addEventListener('click', event => {
    const bridge = event.target.closest('[data-agent-bridge-copy]');
    if (bridge) {
      event.stopPropagation();
      copyBridgeCommand(bridge.dataset.agentBridgeCopy);
      return;
    }
    const origin = event.target.closest('[data-agent-open-origin]');
    if (origin) {
      event.stopPropagation();
      openSessionOrigin(origin.dataset.agentOpenOrigin);
      return;
    }
    const terminal = event.target.closest('[data-agent-terminal-open]');
    if (terminal) {
      event.stopPropagation();
      openAgentTerminal(terminal.dataset.agentTerminalOpen);
      return;
    }
    const more = event.target.closest('[data-graph-provider-more]');
    if (more) {
      state.graphExpandedProviders.add(more.dataset.graphProviderMore);
      renderSessions('expand');
      return;
    }
    const less = event.target.closest('[data-graph-provider-less]');
    if (less) {
      state.graphExpandedProviders.delete(less.dataset.graphProviderLess);
      renderSessions('expand');
      return;
    }
    const open = event.target.closest('[data-open-session]');
    if (open) {
      event.stopPropagation();
      openDrawer(open.dataset.openSession);
      return;
    }
    const node = event.target.closest('[data-graph-focus]');
    if (!node) return;
    if (state.graphFocusId === node.dataset.graphFocus) openDrawer(node.dataset.graphFocus);
    else {
      state.graphFocusId = node.dataset.graphFocus;
      renderSessions('focus');
    }
  });
  $('#liveSessionGrid').addEventListener('input', event => {
    const input = event.target.closest('[data-agent-command-draft]');
    if (input) state.agentCommandDrafts.set(input.dataset.agentCommandDraft, input.value);
  });
  $('#liveSessionGrid').addEventListener('change', event => {
    const picker = event.target.closest('[data-agent-command-target]');
    if (!picker) return;
    if (picker.value) state.agentCommandTargets.set(picker.dataset.agentCommandTarget, picker.value);
    else state.agentCommandTargets.delete(picker.dataset.agentCommandTarget);
    const form = picker.closest('[data-agent-command-form]');
    const enabled = Boolean(picker.value);
    form && form.querySelectorAll('button').forEach(button => { button.disabled = !enabled; });
  });
  $('#liveSessionGrid').addEventListener('keydown', event => {
    const input = event.target.closest('[data-agent-command-draft]');
    if (!input || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    input.closest('form')?.requestSubmit();
  });
  $('#liveSessionGrid').addEventListener('submit', event => {
    const form = event.target.closest('[data-agent-command-form]');
    if (!form) return;
    event.preventDefault();
    dispatchAgentCommand(form.dataset.agentCommandForm, form);
  });
  $('#graphBreadcrumbs').addEventListener('click', event => {
    if (event.target.closest('[data-graph-reset]')) state.graphFocusId = null;
    else {
      const node = event.target.closest('[data-graph-focus]');
      if (!node) return;
      state.graphFocusId = node.dataset.graphFocus;
    }
    renderSessions('focus-back');
  });
  $('#graphResetBtn').addEventListener('click', () => { state.graphFocusId = null; renderSessions('focus-back'); });
  $('#tmuxMap').addEventListener('click', event => {
    const control = event.target.closest('[data-control-tmux]');
    if (control) {
      event.stopPropagation();
      window.LodestarTerminal?.selectTmuxById(control.dataset.controlTmux);
      $('#tmuxControlSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const open = event.target.closest('[data-open-session]');
    if (open) {
      event.stopPropagation();
      openDrawer(open.dataset.openSession);
      return;
    }
    const node = event.target.closest('[data-tmux-type][data-tmux-id]');
    if (!node) return;
    state.tmuxFocus = { type: node.dataset.tmuxType, id: node.dataset.tmuxId };
    renderTmuxMap();
    if (node.dataset.tmuxType === 'pane') window.LodestarTerminal?.selectTmuxById(node.dataset.tmuxId);
  });
  $('#tmuxBreadcrumbs').addEventListener('click', event => {
    if (event.target.closest('[data-tmux-reset]')) state.tmuxFocus = null;
    else {
      const node = event.target.closest('[data-tmux-type][data-tmux-id]');
      if (!node) return;
      state.tmuxFocus = { type: node.dataset.tmuxType, id: node.dataset.tmuxId };
    }
    renderTmuxMap();
  });
  $('#tmuxResetBtn').addEventListener('click', () => { state.tmuxFocus = null; renderTmuxMap(); });
  $('#loadMoreBtn').addEventListener('click', () => {
    state.visibleLimit += 30;
    renderSessions('load-more');
  });
  $('#workspaceList').addEventListener('click', async event => {
    const remove = event.target.closest('[data-remove-workspace]');
    if (remove) {
      event.stopPropagation();
      state.workspaces = await window.lodestar.removeWorkspace(remove.dataset.removeWorkspace);
      if (state.workspace === remove.dataset.removeWorkspace) state.workspace = 'all';
      render();
      return;
    }
    const item = event.target.closest('[data-workspace]');
    if (item) { state.workspace = item.dataset.workspace; state.visibleLimit = 30; renderWorkspaces(); renderSessions('filter'); }
  });
  let searchTimer = null;
  $('#searchInput').addEventListener('input', event => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => { state.search = value; state.visibleLimit = 30; renderSessions('filter'); }, 120);
  });
  $('#providerFilter').addEventListener('change', event => { state.provider = event.target.value; state.visibleLimit = 30; renderSessions('filter'); });
  $('#sortSelect').addEventListener('change', event => { state.sort = event.target.value; state.visibleLimit = 30; renderSessions('filter'); });
  $('#addWorkspaceBtn').addEventListener('click', async () => { state.workspaces = await window.lodestar.addWorkspaces(); renderWorkspaces(); });
  $('#probeBtn').addEventListener('click', async () => { state.availability = await window.lodestar.probeProviders(); render(); toast('AI CLI 연결 상태를 다시 확인했습니다.'); });
  $('#newRunBtn').addEventListener('click', openRunModal);
  $$('[data-open-run]').forEach(button => button.addEventListener('click', openRunModal));
  $('#closeRunModalBtn').addEventListener('click', closeRunModal);
  $('#cancelRunBtn').addEventListener('click', closeRunModal);
  $('#runModal').addEventListener('click', event => { if (event.target === $('#runModal')) closeRunModal(); });
  $('#runProviderPicker').addEventListener('click', event => {
    const button = event.target.closest('[data-run-provider]');
    if (!button || button.disabled) return;
    state.runProvider = button.dataset.runProvider;
    $('#runProviderPicker').innerHTML = providerPickerHtml();
  });
  $('#pickRunCwdBtn').addEventListener('click', async () => { const folder = await window.lodestar.pickWorkspace(); if (folder) $('#runCwd').value = folder; });
  $('#runForm').addEventListener('submit', handleRun);
  $('#closeDrawerBtn').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('.drawer-tabs').addEventListener('click', event => { const tab = event.target.closest('[data-tab]'); if (tab) { state.drawerTab = tab.dataset.tab; state.drawerForceLatest = tab.dataset.tab === 'chat'; renderDrawer(); } });
  $('#detailDrawer').addEventListener('click', async event => {
    const latest = event.target.closest('[data-scroll-latest]');
    if (latest) {
      const content = $('#drawerContent');
      content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
      return;
    }
    const stop = event.target.closest('[data-stop-run]');
    if (!stop) return;
    const result = await window.lodestar.stopAgent(stop.dataset.stopRun);
    toast(result.ok ? '중지 요청을 보냈습니다.' : result.error);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('#runModal').classList.contains('hidden')) closeRunModal(); else closeDrawer();
  });
  window.addEventListener('resize', scheduleAgentWorkflowConnections);
}

async function init() {
  if (!window.lodestar) {
    $('#emptyState').classList.remove('hidden');
    $('#emptyState p').textContent = 'Lodestar 프로그램에서 열면 이 컴퓨터의 AI 작업 기록을 불러옵니다.';
    return;
  }
  const bootstrap = await window.lodestar.bootstrap();
  state.providers = bootstrap.providers || [];
  state.providerMap = new Map(state.providers.map(provider => [provider.id, provider]));
  state.availability = bootstrap.availability || {};
  state.workspaces = bootstrap.workspaces || [];
  state.snapshot = bootstrap.snapshot;
  state.activeRuns = bootstrap.activeRuns || [];
  state.platform = bootstrap.platform || state.platform;
  $('#providerFilter').innerHTML = '<option value="all">모든 AI</option>' + state.providers.map(provider => `<option value="${esc(provider.id)}">${esc(provider.label)}</option>`).join('');
  bindEvents();
  render();
  $('#lastSync').textContent = timeOnly(state.snapshot && state.snapshot.generatedAt);
  window.lodestar.onSnapshot(snapshot => {
    state.snapshot = snapshot;
    if (window.LodestarTerminal) window.LodestarTerminal.updateSnapshot(snapshot, state.workspaces);
    $('#lastSync').textContent = timeOnly(snapshot.generatedAt);
    render();
    if (state.selectedId && $('#detailDrawer').classList.contains('open') && !state.detailLoading) {
      const card = (snapshot.sessions || []).find(session => session.id === state.selectedId);
      const detail = state.details.get(state.selectedId);
      if (card && detail && card.updatedAt !== detail.updatedAt) loadSessionDetail(state.selectedId, true);
    }
  });
}

init().catch(error => {
  console.error(error);
  $('#lastSync').textContent = '연결 실패';
  toast(`초기화 실패: ${error.message}`);
});
