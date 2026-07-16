'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const PROJECTLESS_WORKSPACE = '__projectless__';
const uiLocale = () => window.LoadToAgentI18n?.getLocaleTag() || 'ko-KR';

const state = {
  providers: [],
  providerMap: new Map(),
  availability: {},
  workspaces: [],
  snapshot: null,
  activeRuns: [],
  versions: {},
  update: null,
  view: 'all',
  provider: 'all',
  workspace: 'all',
  search: '',
  sort: 'recent',
  selectedId: null,
  drawerTab: 'chat',
  drawerMode: 'session',
  runProvider: 'claude',
  details: new Map(),
  detailLoadingIds: new Set(),
  drawerForceLatest: false,
  visibleLimit: 30,
  graphFocusId: null,
  graphExpandedProviders: new Set(),
  expandedCompletedSubagents: new Set(),
  tmuxFocus: null,
  agentCommandDrafts: new Map(),
  agentCommandTargets: new Map(),
  agentCommandSending: new Set(),
  stopRequests: new Set(),
  detailErrors: new Map(),
  guideCompleted: new Set(),
  guideExpanded: true,
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
  drawerTab: '',
  activeDialogTrigger: null,
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
  terminal: '세션 터미널',
  tmux: 'tmux 작업',
  settings: '프로그램 설정',
};

const VIEW_META = {
  all: {
    eyebrow: 'AI 작업 현황',
    title: 'AI 작업을 한눈에 확인하세요.',
    subtitle: '진행 중인 일과 내 확인이 필요한 일을 먼저 보여주고, 나머지 기록은 아래에서 찾을 수 있습니다.',
  },
  active: {
    eyebrow: '지금 진행 중',
    title: '현재 일하고 있는 AI를 확인하세요.',
    subtitle: '무슨 일을 처리 중인지 보고, 작업을 누르면 AI 사이의 역할과 최신 진행 상황을 자세히 볼 수 있습니다.',
  },
  waiting: {
    eyebrow: '내 차례',
    title: '내 확인이 필요한 일을 먼저 처리하세요.',
    subtitle: '답변이나 선택을 기다리는 작업만 모았습니다. 항목을 열어 필요한 내용을 확인하세요.',
  },
  terminal: {
    eyebrow: '기존 대화 이어가기',
    title: 'AI 세션을 터미널에서 이어가세요.',
    subtitle: '이전 대화와 실시간 명령창을 나란히 보며 같은 작업을 계속할 수 있습니다.',
  },
  tmux: {
    eyebrow: '고급 작업 도구',
    title: '여러 명령창 작업을 한곳에서 관리하세요.',
    subtitle: 'tmux를 이미 사용하는 경우에만 필요한 화면입니다. 일반 작업은 홈과 세션 터미널만으로 충분합니다.',
  },
  settings: {
    eyebrow: '프로그램 관리',
    title: '버전과 업데이트를 확인하세요.',
    subtitle: '현재 설치 버전과 최신 정식 버전을 비교하고, 안전하게 검증된 설치 파일을 받을 수 있습니다.',
  },
};

const GUIDE_STORAGE_KEY = 'loadtoagent:start-guide:v1';
const GUIDE_STEPS = ['create', 'active', 'waiting', 'detail'];

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function loadGuideState() {
  try {
    const saved = JSON.parse(localStorage.getItem(GUIDE_STORAGE_KEY) || '{}');
    state.guideCompleted = new Set((saved.completed || []).filter(step => GUIDE_STEPS.includes(step)));
    state.guideExpanded = saved.expanded !== false;
  } catch {
    state.guideCompleted = new Set();
    state.guideExpanded = true;
  }
}

function saveGuideState() {
  try {
    localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify({ completed: [...state.guideCompleted], expanded: state.guideExpanded }));
  } catch {}
}

function renderGuide() {
  const completed = state.guideCompleted.size;
  GUIDE_STEPS.forEach(step => {
    const item = document.querySelector(`[data-guide-step="${step}"]`);
    const done = state.guideCompleted.has(step);
    item?.classList.toggle('completed', done);
    item?.querySelector('button')?.setAttribute('aria-pressed', done ? 'true' : 'false');
  });
  const percent = completed / GUIDE_STEPS.length * 100;
  $('#guideProgressBar').style.width = `${percent}%`;
  const progress = $('.guide-progress');
  progress.setAttribute('aria-valuenow', String(completed));
  $('#guideButtonProgress').textContent = completed === GUIDE_STEPS.length ? '기본 사용법 완료' : `${completed} / ${GUIDE_STEPS.length} 완료`;
  $('#guideProgressText').textContent = completed === GUIDE_STEPS.length
    ? '기본 사용법을 모두 익혔어요. 언제든 다시 열어볼 수 있습니다.'
    : `${GUIDE_STEPS.length - completed}단계 남았어요. 하나씩 눌러 직접 둘러보세요.`;
  $('#guideBtn').setAttribute('aria-expanded', state.guideExpanded ? 'true' : 'false');
}

function markGuideStep(step) {
  if (!GUIDE_STEPS.includes(step) || state.guideCompleted.has(step)) return;
  state.guideCompleted.add(step);
  saveGuideState();
  renderGuide();
}

function syncViewChrome() {
  const meta = VIEW_META[state.view] || VIEW_META.all;
  document.body.dataset.currentView = state.view;
  $('#pageEyebrow').textContent = meta.eyebrow;
  $('#pageTitle').textContent = meta.title;
  $('#pageSubtitle').textContent = meta.subtitle;
  document.title = `${VIEW_TITLES[state.view] || 'LoadToAgent'} · LoadToAgent`;
  $$('.nav-item[data-view]').forEach(item => {
    const active = item.dataset.view === state.view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  const advancedView = ['terminal', 'tmux', 'settings'].includes(state.view);
  $('#mobileMoreBtn')?.classList.toggle('active', advancedView);
  if (advancedView) $('#mobileMoreBtn')?.setAttribute('aria-current', 'page');
  else $('#mobileMoreBtn')?.removeAttribute('aria-current');
}

function selectView(view, options = {}) {
  state.view = view;
  state.visibleLimit = 30;
  if (view === 'active' || view === 'waiting') markGuideStep(view);
  syncViewChrome();
  renderSessions(options.motionKind || 'view');
  $('#mobileToolsMenu')?.classList.add('hidden');
  $('#mobileMoreBtn')?.setAttribute('aria-expanded', 'false');
  document.querySelector('.main-stage')?.scrollTo({ top: 0, behavior: 'auto' });
  if (options.focusMain) $('#mainContent')?.focus({ preventScroll: true });
}

function currentDialog() {
  if (!$('#runModal').classList.contains('hidden')) return $('#runModal');
  if (!$('#tmuxCreateModal').classList.contains('hidden')) return $('#tmuxCreateModal');
  if ($('#detailDrawer').classList.contains('open')) return $('#detailDrawer');
  return null;
}

function dialogFocusable(dialog) {
  return [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.closest('.hidden') && !element.hidden && element.getClientRects().length);
}

function trapDialogFocus(event) {
  if (event.key !== 'Tab') return;
  const dialog = currentDialog();
  if (!dialog) return;
  const focusable = dialogFocusable(dialog);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

function rememberDialogTrigger() {
  motionState.activeDialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restoreDialogTrigger() {
  const trigger = motionState.activeDialogTrigger;
  motionState.activeDialogTrigger = null;
  if (trigger && trigger.isConnected) trigger.focus();
}

window.LoadToAgentA11y = { rememberDialogTrigger, restoreDialogTrigger };

function readablePreview(value, maxCharacters = 120) {
  const full = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (full.length <= maxCharacters) return { full, text: full, truncated: false };
  const sample = full.slice(0, maxCharacters + 1);
  const wordBoundary = sample.lastIndexOf(' ');
  const cut = wordBoundary >= Math.floor(maxCharacters * .72) ? wordBoundary : maxCharacters;
  return { full, text: `${sample.slice(0, cut).trimEnd()}…`, truncated: true };
}

function memoryCategoryLabel(value) {
  const labels = { insight: '인사이트', convention: '작업 규칙', failure: '실패 기록', decision: '결정', pattern: '반복 패턴' };
  return labels[String(value || '').toLowerCase()] || String(value || '기록');
}

function jsonValueHtml(value, depth = 0) {
  if (value == null) return '<span class="json-empty">없음</span>';
  if (typeof value === 'boolean') return `<span class="json-primitive">${value ? '예' : '아니요'}</span>`;
  if (typeof value === 'number') return `<span class="json-primitive">${esc(value.toLocaleString(uiLocale()))}</span>`;
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

function inlineMarkdown(value) {
  return esc(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function markdownHtml(value) {
  const output = [];
  let fence = false;
  let code = [];
  let list = '';
  const closeList = () => { if (list) { output.push(`</${list}>`); list = ''; } };
  for (const line of String(value || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^```/.test(line)) {
      closeList();
      if (fence) { output.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = []; fence = false; } else fence = true;
      continue;
    }
    if (fence) { code.push(line); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const next = bullet ? 'ul' : 'ol';
      if (list !== next) { closeList(); output.push(`<${next}>`); list = next; }
      output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) { output.push('<br>'); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) output.push(`<h${heading[1].length + 2}>${inlineMarkdown(heading[2])}</h${heading[1].length + 2}>`);
    else output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (fence) output.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  return `<div class="chat-content markdown">${output.join('')}</div>`;
}

function roadmapHtml(value) {
  const text = String(value || '').trim();
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const hasRoadmapSignal = /(?:로드맵|작업\s*계획|roadmap|implementation\s+plan|milestone|phase\s*\d+)/i.test(text);
  const steps = lines.filter(line => /^(?:[-*]\s+|\d+[.)]\s+|#{2,3}\s+(?!로드맵|roadmap))/i.test(line));
  if (!hasRoadmapSignal || (text.length < 420 && steps.length < 6)) return '';
  const heading = lines.find(line => /^#{1,3}\s+/.test(line));
  const title = readablePreview((heading || '작업 로드맵').replace(/^#{1,3}\s+/, ''), 72).text;
  const previewSteps = (steps.length ? steps : lines.filter(line => !/^#{1,3}\s+/.test(line))).slice(0, 3)
    .map(line => readablePreview(line.replace(/^(?:[-*]\s+|\d+[.)]\s+|#{2,3}\s+)/, '').replace(/\*\*/g, ''), 92).text);
  const countLabel = steps.length ? `${steps.length}개 단계` : '긴 계획';
  return `<details class="chat-roadmap" data-roadmap-collapsed="true"><summary><span class="chat-roadmap-mark" aria-hidden="true">MAP</span><span><b>${esc(title)}</b><small>${esc(countLabel)} · 접어서 표시</small></span><i aria-hidden="true">↓</i></summary><ol class="chat-roadmap-preview">${previewSteps.map(step => `<li>${esc(step)}</li>`).join('')}</ol><div class="chat-roadmap-full">${markdownHtml(text)}</div></details>`;
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
  const roadmap = message && message.role === 'assistant' ? roadmapHtml(text) : '';
  if (roadmap) return roadmap;
  return markdownHtml(text);
}

function compact(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return n.toLocaleString(uiLocale());
}

function fullNumber(value) {
  return Number(value || 0).toLocaleString(uiLocale());
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
  return day < 30 ? `${day}일 전` : new Date(value).toLocaleDateString(uiLocale());
}

function timeOnly(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
  return ['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(status) ? status : '';
}

function currentActivity(session) {
  const items = session.lifecycle || [];
  const running = isLiveSession(session) ? [...items].reverse().find(item => item.status === 'running') : null;
  const last = running || items[items.length - 1];
  if (last) return { title: last.label || '활동', detail: last.detail || session.statusDetail || '', type: last.type || 'activity' };
  const message = (session.messages || [])[session.messages.length - 1];
  return { title: session.statusDetail || '잠시 쉬는 중', detail: message && message.text || '', type: 'activity' };
}

function isLiveSession(session) {
  return session && (session.status === 'running' || session.status === 'starting');
}

function subagentWorkState(session) {
  if (isLiveSession(session)) return 'working';
  if (session && session.status === 'failed') return 'attention';
  return 'resting';
}

function subagentWorkLabel(session) {
  return ({ working: '일하는 중', resting: '쉬는 중', attention: '확인 필요' })[subagentWorkState(session)];
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
  const delegation = session.delegation || {};
  const completedResult = delegation.result || session.result;
  if (session.status === 'completed' && completedResult) return `완료 결과 · ${completedResult}`;
  if (session.status === 'completed') return '담당 작업을 완료하고 메인 AI에 결과를 반환했습니다.';
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
      <small>${available ? 'CLI 발견됨' : '설치 필요'}</small><span class="connection-dot"></span>
    </div>`;
  }).join('');
}

function isProjectlessSession(session) {
  if (!session || !session.cwd) return true;
  if (typeof session.projectless === 'boolean') return session.projectless;
  const normalized = String(session.cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  return session.provider === 'codex'
    && session.clientKind === 'codex-desktop'
    && /(?:^|\/)Documents\/Codex\/\d{4}-\d{2}-\d{2}\/new-chat$/i.test(normalized);
}

function sessionWorkspaceLabel(session) {
  return isProjectlessSession(session) ? '프로젝트 없음' : (session && session.workspace || '작업 폴더 미상');
}

function matchesWorkspaceFilter(session) {
  if (state.workspace === 'all') return true;
  if (state.workspace === PROJECTLESS_WORKSPACE) return isProjectlessSession(session);
  return !isProjectlessSession(session)
    && String(session && session.cwd || '').toLowerCase().startsWith(state.workspace.toLowerCase());
}

function renderWorkspaces() {
  const list = $('#workspaceList');
  const projectlessCount = (state.snapshot && state.snapshot.sessions || [])
    .filter(session => !session.parentId && isProjectlessSession(session)).length;
  list.innerHTML = `<button type="button" class="workspace-item ${state.workspace === 'all' ? 'selected' : ''}" data-workspace="all" aria-pressed="${state.workspace === 'all' ? 'true' : 'false'}"><strong>모든 작업 폴더</strong></button>`
    + (projectlessCount ? `<button type="button" class="workspace-item projectless ${state.workspace === PROJECTLESS_WORKSPACE ? 'selected' : ''}" data-workspace="${PROJECTLESS_WORKSPACE}" title="특정 프로젝트에 연결되지 않은 세션" aria-pressed="${state.workspace === PROJECTLESS_WORKSPACE ? 'true' : 'false'}"><strong>프로젝트 없음</strong><small>${projectlessCount}</small></button>` : '')
    + state.workspaces.map(item => `<div class="workspace-row"><button type="button" class="workspace-item ${state.workspace === item.path ? 'selected' : ''}" data-workspace="${esc(item.path)}" title="${esc(item.path)}" aria-pressed="${state.workspace === item.path ? 'true' : 'false'}"><strong>${esc(item.name)}</strong></button><button type="button" class="workspace-remove" data-remove-workspace="${esc(item.path)}" aria-label="${esc(item.name)} 작업 폴더를 목록에서 제거" title="목록에서 제거">×</button></div>`).join('')
    + (!state.workspaces.length ? '<div class="workspace-empty">＋ 버튼으로 자주 쓰는 작업 폴더를 등록할 수 있습니다.</div>' : '');
}

function renderGlobalStats() {
  const totals = state.snapshot && state.snapshot.summary && state.snapshot.summary.totals || {};
  const sessions = state.snapshot && state.snapshot.sessions || [];
  const rootCount = sessions.filter(session => !session.parentId).length;
  const helperCount = sessions.filter(session => session.parentId).length;
  const items = [
    ['전체 작업', rootCount, '개', ''],
    ['지금 일하는 AI', totals.active || 0, '개', 'live'],
    ['내 확인 기다림', totals.waiting || 0, '개', 'alert'],
    ['도움 AI 기록', helperCount, '개', ''],
    ['사용한 토큰', compact(totals.usage && totals.usage.total), '개', ''],
  ];
  $('#globalStats').innerHTML = items.map(([label, value, unit, cls], index) => `<div class="global-stat ${cls}" data-motion-key="stat:${index}" data-motion-value="${esc(value)}"><span>${label}</span><strong>${esc(value)}</strong><em>${unit}</em></div>`).join('');
  $('#navAllCount').textContent = rootCount;
  $('#navActiveCount').textContent = totals.active || 0;
  $('#navWaitingCount').textContent = totals.waiting || 0;
  $('#navTmuxCount').textContent = state.snapshot && state.snapshot.tmux && state.snapshot.tmux.summary && state.snapshot.tmux.summary.aiPanes || 0;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function installationTypeLabel(value) {
  return ({ desktop: '데스크톱 설치 파일', npm: 'npm 전역 설치본', source: '로컬 개발 실행본' })[value] || '설치 방식 확인 중';
}

function updatePresentation(update) {
  const status = update && update.status || 'idle';
  const hasAsset = Boolean(update && update.asset);
  const labels = {
    idle: ['·', '버전 상태', '업데이트 확인을 준비하고 있습니다.', 'GitHub의 최신 정식 릴리스를 확인합니다.'],
    checking: ['↻', '최신 버전 확인 중', '최신 버전을 확인하고 있습니다.', 'GitHub의 최신 정식 릴리스 태그를 읽는 중입니다.'],
    current: ['✓', '최신 버전', '현재 최신 버전입니다.', `설치된 v${update && update.currentVersion || '—'}이 GitHub의 최신 정식 버전과 같습니다.`],
    available: ['↟', '업데이트 있음', `v${update && update.latestVersion || '—'} 업데이트가 있습니다.`, hasAsset ? '이 컴퓨터에 맞는 설치 파일을 앱에서 안전하게 받을 수 있습니다.' : '릴리스는 확인했지만 맞는 설치 파일이 아직 준비되지 않았습니다.'],
    downloading: ['↓', '다운로드 중', '업데이트 파일을 받고 있습니다.', '다운로드가 끝날 때까지 앱을 종료하지 마세요.'],
    downloaded: ['✓', '설치 준비 완료', '업데이트 파일이 준비됐습니다.', '설치 파일을 열고 화면의 안내에 따라 업데이트를 마무리하세요.'],
    error: ['!', '확인 실패', '업데이트를 확인하지 못했습니다.', '인터넷 연결을 확인한 뒤 다시 시도할 수 있습니다.'],
    unsupported: ['—', '수동 업데이트', '이 운영체제는 수동 업데이트가 필요합니다.', 'GitHub 릴리스에서 최신 파일을 직접 확인하세요.'],
  };
  return labels[status] || labels.idle;
}

function renderUpdateSettings() {
  const update = state.update || { status: 'idle', currentVersion: state.versions.app || '' };
  const [glyph, label, title, text] = updatePresentation(update);
  const available = ['available', 'downloading', 'downloaded'].includes(update.status);
  const downloading = update.status === 'downloading';
  const downloaded = update.status === 'downloaded';
  const current = update.currentVersion || state.versions.app || '';
  $('#sidebarAppVersion').textContent = current ? `v${current}` : 'v—';
  $('#updatePanel').dataset.updateStatus = update.status || 'idle';
  $('#currentVersion').textContent = current ? `v${current}` : 'v—';
  $('#latestVersion').textContent = update.latestVersion ? `v${update.latestVersion}` : '확인 전';
  $('#installationType').textContent = installationTypeLabel(update.installType);
  $('#releasePublishedAt').textContent = update.publishedAt ? `${new Date(update.publishedAt).toLocaleDateString(uiLocale())} 공개` : '정식 릴리스 기준';
  $('#runtimeVersions').textContent = `Electron ${state.versions.electron || '—'} · Node ${state.versions.node || '—'}`;
  $('#updateStateGlyph').textContent = glyph;
  $('#updateStateLabel').textContent = label;
  $('#updateStateTitle').textContent = title;
  $('#updateStateText').textContent = text;
  $('#checkUpdateBtn').disabled = update.status === 'checking' || downloading;
  $('#checkUpdateBtn').textContent = update.status === 'checking' ? '확인 중…' : '업데이트 확인';
  const install = $('#installUpdateBtn');
  install.classList.toggle('hidden', !(available && (update.asset || downloaded)));
  install.disabled = downloading;
  install.textContent = downloading ? '다운로드 중…' : (downloaded ? '설치 파일 열기' : '업데이트 파일 받기');
  const progress = $('#updateProgress');
  progress.classList.toggle('hidden', !downloading && !downloaded);
  $('#updateProgressLabel').textContent = `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;
  $('#updateProgressBar').style.width = `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;
  $('.update-progress-track').setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Number(update.progress || 0)))));
  $('#updateProgressBytes').textContent = downloaded
    ? `${formatBytes(update.totalBytes || update.downloadedBytes)} · 파일 검증 완료`
    : `${formatBytes(update.downloadedBytes)} / ${update.totalBytes ? formatBytes(update.totalBytes) : '크기 확인 중'}`;
  const error = $('#updateError');
  error.classList.toggle('hidden', !update.error);
  error.textContent = update.error || '';
  const notes = $('#releaseNotes');
  notes.classList.toggle('hidden', !update.latestVersion);
  $('#releaseNotesText').textContent = update.notes && update.notes.trim() || '이 릴리스에 작성된 변경 사항이 없습니다.';
  const notice = $('#updateNotice');
  notice.classList.toggle('hidden', !available || state.view !== 'all');
  $('#updateNoticeTitle').textContent = `새 버전 v${update.latestVersion || '—'}을 사용할 수 있습니다.`;
  $('#updateNoticeText').textContent = downloaded ? '설치 파일 준비가 끝났습니다.' : '설정에서 업데이트 파일을 받을 수 있습니다.';
  $('#navUpdateBadge').classList.toggle('hidden', !available);
}

function renderProviderOverview() {
  const summaries = state.snapshot && state.snapshot.summary && state.snapshot.summary.providers || state.providers;
  const sessions = state.snapshot && state.snapshot.sessions || [];
  $('#providerOverview').innerHTML = summaries.map(provider => {
    const rootCount = sessions.filter(session => session.provider === provider.id && !session.parentId).length;
    return `<button type="button" class="provider-overview-card ${state.provider === provider.id ? 'selected' : ''}" data-provider-card="${esc(provider.id)}" data-motion-key="provider:${esc(provider.id)}" data-motion-value="${provider.active || 0}:${rootCount}:${provider.usage && provider.usage.total || 0}" style="${providerStyle(provider.id)}" aria-pressed="${state.provider === provider.id ? 'true' : 'false'}">
    <div class="poc-head">
      <span class="provider-mark">${esc(provider.mark)}</span>
      <div><strong>${esc(provider.label)}</strong><small>${esc(provider.company)}</small></div>
      <span class="poc-state ${provider.installed ? 'online' : ''}">${provider.installed ? '사용 가능' : '설치 필요'}</span>
    </div>
    <div class="poc-metrics">
      <div><b>${provider.active || 0}</b><span>활동 AI</span></div>
      <div><b>${rootCount}</b><span>메인 작업</span></div>
      <div><b>${compact(provider.usage && provider.usage.total)}</b><span>사용 토큰</span></div>
    </div>
  </button>`;
  }).join('');
}

function filteredSessions() {
  const allSessions = [...(state.snapshot && state.snapshot.sessions || [])];
  let sessions = state.view === 'waiting' ? allSessions : allSessions.filter(session => !session.parentId);
  if (state.view === 'active') sessions = sessions.filter(session => session.status === 'running' || session.status === 'starting');
  if (state.view === 'waiting') sessions = sessions.filter(session => session.status === 'waiting');
  if (state.provider !== 'all') sessions = sessions.filter(session => session.provider === state.provider);
  sessions = sessions.filter(matchesWorkspaceFilter);
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
  sessions = sessions.filter(matchesWorkspaceFilter);
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
  const childMetrics = session.collaboration && session.collaboration.metrics;
  const cumulativeChildren = childMetrics ? childMetrics.cumulativeCreated : childCount;
  const delegation = session.delegation || {};
  const displayedTask = session.parentId && delegation.assignmentObserved && delegation.assignment
    ? delegation.assignment : (session.parentId && (delegation.taskName || session.taskName) ? (delegation.taskName || session.taskName) : session.title);
  const goalPreview = readablePreview(displayedTask, options.focus ? 118 : 96);
  const currentWork = latestWorkCopy(session);
  const currentPreview = readablePreview(currentWork, options.focus ? 132 : 108);
  const role = session.parentId
    ? `도움 AI${session.agentName ? ` · ${session.agentName}` : ''}${session.agentRole ? ` / ${agentRoleLabel(session.agentRole)}` : ''}`
    : '일을 맡은 AI';
  return `<article class="agent-node ${running ? 'running' : ''} ${session.parentId ? 'child-agent' : 'root-agent'} ${options.focus ? 'is-focus' : ''}" data-motion-key="agent:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || '')}:${usage.total || 0}:${esc(session.status || '')}" style="${providerStyle(session.provider)}">
    <button class="agent-node-main" type="button" data-graph-focus="${esc(session.id)}" aria-label="${esc(role)} 관계 중심으로 보기">
      <span class="agent-node-top"><span class="provider-mark">${esc(provider.mark)}</span><span class="agent-identity"><b>${esc(role)}</b><small>${esc(provider.label)} · ${esc(session.model || '모델 정보 없음')}</small></span>${executionModeBadge(session, true)}<span class="status-pill ${statusClass(session.status)}">${esc(STATUS[session.status] || session.status)}</span></span>
      <span class="agent-task-label">${session.parentId ? `담당 작업${delegation.assignmentSource === 'parent-narration' ? ' · 메인 AI 설명 기반' : ''}` : '지금 목표'}</span>
      <strong class="agent-task" title="${esc(goalPreview.full)}">${esc(goalPreview.text)}</strong>
      ${goalPreview.truncated ? '<span class="agent-goal-note">요약 표시 · 전체 내용은 대화 상세에서 확인</span>' : ''}
      <span class="agent-current"><span><i>${statusIcon(activity.type)}</i><b>지금 하는 일</b></span><strong title="${esc(currentPreview.full)}">${esc(currentPreview.text)}</strong></span>
      <span class="agent-node-metrics"><span><small>기억 공간 사용</small><b>${context.window ? `${percent.toFixed(1)}%` : '--'}</b></span><span><small>사용 토큰</small><b>${compact(usage.total)}</b></span><span><small>마지막 활동</small><b>${esc(timeAgo(session.updatedAt))}</b></span></span>
      <span class="agent-node-gauge"><i style="width:${percent}%"></i></span>
    </button>
    <footer class="agent-node-footer"><span>${cumulativeChildren ? `서브에이전트 ${cumulativeChildren}개 누적 생성` : (session.parentId ? '도움을 맡은 AI' : '이 작업의 중심 AI')}</span><button type="button" data-open-session="${esc(session.id)}">대화 내용 보기 <b>↗</b></button></footer>
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

function connectedGraphSessions(sessions, focusId = state.graphFocusId) {
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
  const includeDescendants = session => {
    const queue = [...(session && session.childIds || [])];
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      included.add(id);
      const child = byId.get(id);
      if (child) queue.push(...(child.childIds || []));
    }
  };
  const requestedFocus = focusId && byId.get(focusId);
  if (requestedFocus) {
    includeAncestors(requestedFocus);
    includeDescendants(requestedFocus);
  }
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

function agentExecutionMode(session) {
  const presence = Array.isArray(session && session.runtimePresence) ? session.runtimePresence : [];
  const tmux = presence.find(item => item.kind === 'tmux');
  if (tmux) return {
    kind: 'tmux',
    label: 'TMUX 사용',
    detail: [tmux.distro, tmux.sessionName, tmux.paneNativeId || tmux.paneId].filter(Boolean).join(' · ') || '분할 터미널에서 실행',
  };
  return { kind: 'standard', label: '일반 실행', detail: 'TMUX 미사용' };
}

function executionModeBadge(session, compact = false) {
  const mode = agentExecutionMode(session);
  return `<span class="execution-mode-badge ${mode.kind}" title="${esc(mode.detail)}"><i>${mode.kind === 'tmux' ? '▦' : '›_'}</i><b>${esc(mode.label)}</b>${compact ? '' : `<small>${esc(mode.detail)}</small>`}</span>`;
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
  const delegation = session.delegation || {};
  const taskName = delegation.taskName || session.taskName || '';
  const assignedWork = delegation.assignmentObserved && delegation.assignment ? delegation.assignment : (taskName || session.title);
  const sharedGoal = delegation.sharedGoal || session.sharedGoal || '';
  const outcome = delegation.result || session.result || '';
  const outcomeText = outcome || latestWorkCopy(session);
  const assignedWorkPreview = readablePreview(assignedWork, session.parentId ? 110 : 104);
  const taskLabel = session.parentId ? `${label || agentRoleLabel(session.agentRole)}${taskName ? ` · 담당 ${taskName}` : ''}` : label;
  const assignmentSourceNote = session.parentId && delegation.assignmentSource === 'parent-narration' ? '<span class="agent-flow-assignment-source">메인 AI가 작업 시작 직전에 설명한 내용</span>' : '';
  const sharedGoalCopy = session.parentId && sharedGoal && sharedGoal !== assignedWork ? `<span class="agent-flow-shared">공유 목표 · ${esc(sharedGoal)}</span>` : '';
  const outcomeCopy = session.parentId
    ? `<span class="agent-flow-outcome ${session.status === 'completed' ? 'done' : ''}"><b>${session.status === 'completed' ? '완료 결과' : '현재 작업'}</b><span class="agent-flow-outcome-copy" title="${esc(outcomeText)}">${esc(outcomeText)}</span></span>` : '';
  if (session.parentId) {
    const primaryTask = taskName || assignedWork || session.title;
    const assignmentCopy = assignedWork && assignedWork !== primaryTask
      ? `<span class="agent-flow-assignment"><small>담당 내용</small><strong title="${esc(assignedWork)}">${esc(assignedWork)}</strong></span>` : '';
    const workState = subagentWorkState(session);
    const interaction = directChildren
      ? `data-graph-focus="${esc(session.id)}" aria-label="${esc(primaryTask)}의 하위 서브에이전트 흐름 보기"`
      : `data-open-subagent-chat="${esc(session.id)}" aria-label="${esc(primaryTask)}와 메인 AI의 대화 보기"`;
    const action = directChildren ? `하위 서브에이전트 ${directChildren}개 보기 →` : '메인 AI와의 대화 보기 →';
    return `<button type="button" class="agent-flow-row child-session work-${workState} ${statusClass(session.status)}" ${interaction} data-motion-key="agent:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || '')}:${usage.total || 0}:${esc(session.status || '')}" style="${providerStyle(session.provider)}">
      <span class="agent-flow-state" aria-hidden="true"></span>
      <span class="agent-flow-copy">
        <span class="agent-flow-kicker"><small>${esc(label || agentRoleLabel(session.agentRole))} 세션</small><time>${esc(timeAgo(session.updatedAt))}</time></span>
        <b class="agent-flow-session-title" title="${esc(primaryTask)}">${esc(primaryTask)}</b>
        <span class="agent-flow-agent"><i>${esc(provider.mark)}</i><strong>${esc(session.agentName || '이름 미확인')}</strong><small>${esc(provider.label)}${session.model ? ` · ${esc(session.model)}` : ''}</small></span>
        ${assignmentCopy}${assignmentSourceNote}${outcomeCopy}<span class="agent-flow-child-action">${esc(action)}</span>
      </span>
      <span class="agent-flow-provider">${executionModeBadge(session, true)}<small class="status-pill work-${workState}">${esc(subagentWorkLabel(session))}</small>${session.status === 'completed' ? '<em>최근 작업 완료</em>' : ''}</span>
    </button>`;
  }
  return `<button type="button" class="agent-flow-row ${isLiveSession(session) ? 'running' : ''} ${statusClass(session.status)}" data-graph-focus="${esc(session.id)}" data-motion-key="agent:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || '')}:${usage.total || 0}:${esc(session.status || '')}" style="${providerStyle(session.provider)}">
    <span class="agent-flow-state" aria-hidden="true"></span>
    <span class="agent-flow-copy">${taskLabel ? `<small>${esc(taskLabel)}</small>` : ''}<b title="${esc(assignedWorkPreview.full)}">${esc(assignedWorkPreview.text)}</b><em>${esc(identity)} · ${directChildren ? `도움 AI ${directChildren}명 · ` : ''}${esc(timeAgo(session.updatedAt))}</em>${assignmentSourceNote}${sharedGoalCopy}${outcomeCopy}</span>
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
  const port = side === 'upstream' ? '<span class="agent-workflow-port output" data-workflow-port="upstream-output" aria-hidden="true"></span>' : '';
  return `<div class="agent-workflow-node ${side}" data-workflow-node="${esc(session.id)}">${port}${compactGraphNode(session, model, label)}</div>`;
}

function liveTmuxEntries(tmux = state.snapshot && state.snapshot.tmux) {
  const entries = [];
  for (const distro of tmux && tmux.distros || []) {
    for (const tmuxSession of distro.sessions || []) {
      for (const window of tmuxSession.windows || []) {
        for (const pane of window.panes || []) {
          if (!pane.agent) continue;
          entries.push({ distro, tmuxSession, window, pane, agent: pane.agent });
        }
      }
    }
  }
  return entries.sort((a, b) => Number(b.pane.active) - Number(a.pane.active)
    || Number(a.pane.dead) - Number(b.pane.dead)
    || String(a.tmuxSession.name).localeCompare(String(b.tmuxSession.name)));
}

function liveTmuxPaneCard(entry) {
  const { distro, tmuxSession, window, pane, agent } = entry;
  const provider = providerInfo(agent.provider);
  const linked = agent.linkedSessionId ? snapshotSession(agent.linkedSessionId) : null;
  const title = linked ? linked.title : (pane.title || `${provider.label} TMUX 작업`);
  const stateLabel = pane.dead ? '종료됨' : (pane.active ? '현재 선택된 칸' : '백그라운드 실행');
  return `<article class="live-tmux-card ${pane.active ? 'active' : ''} ${pane.dead ? 'dead' : ''}" style="${providerStyle(agent.provider)}" data-motion-key="live-tmux:${esc(pane.id)}" data-motion-value="${esc(agent.updatedAt || '')}:${pane.pid || 0}">
    <button type="button" class="live-tmux-pane" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}" aria-label="${esc(tmuxSession.name)} TMUX 칸 열기">
      <span class="live-tmux-card-head"><span class="live-tmux-symbol">▦</span><span><small>TMUX 세션</small><b>${esc(tmuxSession.name)}</b></span><em>${esc(stateLabel)}</em></span>
      <strong class="live-tmux-title">${esc(title)}</strong>
      <span class="live-tmux-agent"><i>${esc(provider.mark)}</i><b>${esc(provider.label)}</b><small>${esc(agent.command || pane.command || 'AI')}</small></span>
      <span class="live-tmux-location"><b>${esc(distro.name)}</b><i>›</i><span>${esc(window.name || `창 ${window.index + 1}`)}</span><i>›</i><span>칸 ${pane.index + 1} · ${esc(pane.nativeId || pane.id)}</span></span>
      <span class="live-tmux-cwd" title="${esc(pane.cwd || '')}">${esc(pane.cwd || '작업 폴더 미확인')}</span>
    </button>
    <footer><span>${linked ? '대화 기록과 연결됨' : 'TMUX 프로세스에서 직접 감지'}</span><span>${linked ? `<button type="button" data-graph-focus="${esc(linked.id)}">AI 흐름 보기</button>` : ''}<button type="button" class="live-tmux-pane" data-tmux-type="pane" data-tmux-id="${esc(pane.id)}">TMUX에서 열기 →</button></span></footer>
  </article>`;
}

function runtimeSeparatedOverview(roots, model) {
  const tmux = state.snapshot && state.snapshot.tmux || { distros: [], summary: {} };
  const tmuxEntries = liveTmuxEntries(tmux);
  const tmuxLinkedIds = new Set(tmuxEntries.map(entry => entry.agent.linkedSessionId).filter(Boolean));
  const tmuxRoots = roots.filter(root => agentExecutionMode(root).kind === 'tmux');
  const standardRoots = roots.filter(root => agentExecutionMode(root).kind !== 'tmux');
  const providerOrder = [...new Set([...state.providers.map(item => item.id), ...roots.map(item => item.provider)])];
  const lanesFor = items => providerOrder.map(providerId => ({ providerId, roots: items.filter(root => root.provider === providerId) })).filter(item => item.roots.length);
  const standardLanes = lanesFor(standardRoots);
  const fallbackTmuxLanes = lanesFor(tmuxRoots.filter(root => !tmuxLinkedIds.has(root.id)));
  const summary = tmux.summary || {};
  const standardHtml = standardLanes.length
    ? `<div class="agent-flow-overview">${standardLanes.map(item => providerFlowLane(item.providerId, item.roots, model)).join('')}</div>`
    : '<div class="runtime-segment-empty"><b>일반 실행 AI가 없습니다</b><span>현재 감지된 작업은 모두 TMUX에서 실행 중입니다.</span></div>';
  const tmuxHtml = tmuxEntries.length || fallbackTmuxLanes.length
    ? `${tmuxEntries.length ? `<div class="live-tmux-grid">${tmuxEntries.map(liveTmuxPaneCard).join('')}</div>` : ''}${fallbackTmuxLanes.length ? `<div class="agent-flow-overview live-tmux-fallback">${fallbackTmuxLanes.map(item => providerFlowLane(item.providerId, item.roots, model)).join('')}</div>` : ''}`
    : '<div class="runtime-segment-empty tmux"><b>TMUX에서 실행 중인 AI가 없습니다</b><span>TMUX AI 프로세스가 감지되면 일반 실행과 분리해 여기에 표시합니다.</span></div>';
  return `<div class="agent-runtime-split" data-runtime-split="true">
    <section class="runtime-segment tmux-runtime" data-runtime-segment="tmux">
      <header><span class="runtime-segment-icon">▦</span><span><small>TMUX 전용</small><b>TMUX 세션</b><em>Linux 작업 묶음·창·분할 칸을 유지해서 실행 중인 AI</em></span><strong>${tmuxEntries.length || summary.aiPanes || 0}개</strong><button type="button" class="live-tmux-overview-open">TMUX 전체 화면 →</button></header>
      ${tmuxHtml}
    </section>
    <section class="runtime-segment standard-runtime" data-runtime-segment="standard">
      <header><span class="runtime-segment-icon">›_</span><span><small>TMUX 미사용</small><b>일반 실행 세션</b><em>Codex 앱·외부 터미널에서 실행 중인 메인 AI</em></span><strong>${standardRoots.length}개</strong></header>
      ${standardHtml}
    </section>
  </div>`;
}

function workflowMetrics(session, children) {
  const observed = session.collaboration && session.collaboration.metrics;
  return observed || {
    cumulativeCreated: children.length,
    simultaneousCapacity: 0,
    currentlyRunning: children.filter(isLiveSession).length,
    completedRecords: children.filter(child => child.status === 'completed').length,
    retainedCount: null,
    capacitySource: 'unknown',
    cumulativeSource: 'child-sessions',
  };
}

function workflowChildrenSummary(session, children) {
  if (!children.length && !(session.collaboration && session.collaboration.metrics)) return '';
  const counts = new Map();
  for (const child of children) counts.set(child.provider, (counts.get(child.provider) || 0) + 1);
  const providers = [...counts.entries()].map(([providerId, count]) => {
    const provider = providerInfo(providerId);
    return `<span class="workflow-summary-chip" style="${providerStyle(providerId)}"><i>${esc(provider.mark)}</i><b>${esc(provider.label)}</b><em>${count}</em></span>`;
  }).join('');
  const metrics = workflowMetrics(session, children);
  const capacity = metrics.simultaneousCapacity > 0 ? metrics.simultaneousCapacity : '--';
  const retained = metrics.retainedCount == null ? '현재 목록 유지 수는 관측되지 않음' : `현재 런타임 목록에는 ${metrics.retainedCount}개 유지`;
  const source = metrics.capacitySource === 'runtime-instruction' ? '세션 런타임 한도' : '동시 한도 출처 미확인';
  return `<div class="agent-workflow-summary" data-collaboration-summary="true">
    <div class="workflow-metric-grid">
      <span data-collaboration-metric="created"><small>이 작업에서 누적 생성</small><b>${esc(metrics.cumulativeCreated)}</b><em>개</em></span>
      <span data-collaboration-metric="capacity"><small>동시에 유지 가능</small><b>${esc(capacity)}</b><em>${capacity === '--' ? '' : '개'}</em></span>
      <span data-collaboration-metric="running"><small>현재 실행 중</small><b>${esc(metrics.currentlyRunning)}</b><em>개</em></span>
      <span data-collaboration-metric="completed"><small>작업 완료 기록</small><b>${esc(metrics.completedRecords)}</b><em>개</em></span>
    </div>
    <div class="workflow-summary-evidence"><span>${esc(retained)} · 완료 기록은 삭제하지 않고 기본으로 접어 보관</span><small>${esc(source)} · spawn/완료 이벤트 기준</small></div>
    <div class="workflow-summary-providers">${providers}</div>
  </div>`;
}

function splitSubagents(children) {
  return children.reduce((out, session) => {
    if (session.status === 'completed' || session.completionObserved) out.completed.push(session);
    else out.ongoing.push(session);
    return out;
  }, { ongoing: [], completed: [] });
}

function completedSubagentDisclosure(ownerId, completed, expanded) {
  if (!completed.length) return '';
  return `<div class="completed-subagent-disclosure ${expanded ? 'expanded' : ''}" data-completed-subagent-section>
    <button type="button" data-subagent-completed-toggle="${esc(ownerId)}" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="completed-disclosure-icon">✓</span><span><b>완료된 서브에이전트 ${completed.length}개</b><small>${expanded ? '완료 기록을 펼쳐 보는 중' : '작업 중인 AI에 집중할 수 있도록 기본으로 접어둡니다'}</small></span><i>${expanded ? '접기 ↑' : '펼쳐 보기 ↓'}</i>
    </button>
  </div>`;
}

function agentPathTaskName(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
}

function communicationEndpoint(value, owner, model) {
  const path = String(value || '');
  if (!path) return '대상 미상';
  if (path === 'Codex 런타임') return path;
  if (path === '/root' || path === owner.agentPath || (!owner.agentPath && path === owner.id)) return '메인 AI';
  const taskName = agentPathTaskName(path);
  const session = model.nodes.find(node => node.agentPath === path || node.taskName === taskName);
  if (session) return `${session.agentName || '서브 AI'}${taskName ? ` · ${taskName}` : ''}`;
  return taskName || path;
}

function workflowCommunicationPanel(focus, parent, model) {
  const owner = focus;
  const all = owner.collaboration && owner.collaboration.communications || [];
  const relevant = all.filter(event => ['assignment', 'started', 'followup', 'message', 'result', 'interrupt'].includes(event.kind));
  const events = relevant.slice(-60);
  if (!events.length) {
    return `<section class="agent-communication-panel empty" data-collaboration-communications="0"><header><span><b>메인 AI ↔ 서브에이전트 소통</b><small>배정·추가 지시·결과 반환 기록</small></span></header><p>이 세션 로그에서는 에이전트 간 통신 이벤트가 확인되지 않았습니다.</p></section>`;
  }
  const rows = events.map(event => {
    const text = event.text || (event.protected
      ? `${event.taskName || '이 작업'}을 서브에이전트에게 배정했습니다.`
      : (event.kind === 'started' ? '런타임에서 실행 시작을 확인했습니다.' : '내용 없이 상태만 기록되었습니다.'));
    const sourceLabel = event.assignmentSource === 'parent-narration' ? ' · 작업 시작 직전 메인 AI 설명' : '';
    return `<article class="agent-communication-event ${esc(event.kind)}" data-communication-kind="${esc(event.kind)}">
      <span class="communication-route"><b>${esc(communicationEndpoint(event.from, owner, model))}</b><i>→</i><b>${esc(communicationEndpoint(event.to, owner, model))}</b></span>
      <span class="communication-copy"><small>${esc(event.label)}${event.taskName ? ` · ${esc(event.taskName)}` : ''}${sourceLabel}</small><strong>${esc(text)}</strong></span>
      <time>${esc(timeOnly(event.timestamp))}</time>
    </article>`;
  }).join('');
  const countLabel = relevant.length > events.length ? `최근 ${events.length} / 전체 ${relevant.length}건` : `${events.length}건`;
  return `<section class="agent-communication-panel" data-collaboration-communications="${events.length}" data-collaboration-communications-total="${relevant.length}"><header><span><b>메인 AI ↔ 서브에이전트 소통</b><small>누가 일을 맡겼고, 언제 시작했으며, 어떤 결과를 돌려줬는지 시간순으로 표시</small></span><em>${countLabel}</em></header><div class="agent-communication-list">${rows}</div></section>`;
}

function agentCommandTargets(session) {
  try {
    return window.LoadToAgentTerminal && typeof window.LoadToAgentTerminal.agentTargets === 'function'
      ? window.LoadToAgentTerminal.agentTargets(session) : [];
  } catch {
    return [];
  }
}

function agentResumeSupport(session) {
  try {
    return window.LoadToAgentTerminal && typeof window.LoadToAgentTerminal.resumeSupport === 'function'
      ? window.LoadToAgentTerminal.resumeSupport(session) : { supported: false, reason: '터미널 재개 기능을 준비하는 중입니다.' };
  } catch (error) {
    return { supported: false, reason: error && error.message || '세션 재개 가능 여부를 확인하지 못했습니다.' };
  }
}

function originAppInfo(session) {
  if (session && session.provider === 'codex' && session.clientKind === 'codex-desktop') return { provider: 'Codex', label: 'Codex 데스크톱 앱' };
  if (session && session.provider === 'claude' && session.clientKind === 'claude-desktop') return { provider: 'Claude', label: 'Claude 데스크톱 앱' };
  return null;
}

function agentControlMode(session, targets) {
  if (targets.length) return 'direct';
  if (originAppInfo(session)) return !isLiveSession(session) && agentResumeSupport(session).supported ? 'origin-resume' : 'origin';
  if (agentResumeSupport(session).supported) return isLiveSession(session) ? 'handoff' : 'resume';
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
  const canSend = ((mode === 'direct' && Boolean(target)) || mode === 'resume' || mode === 'handoff' || mode === 'origin-resume') && !sending;
  const origin = originAppInfo(session);
  const status = mode === 'direct' ? `직접 입력 가능 · ${targets.length === 1 ? target.label : `${targets.length}개 터미널 중 선택`}`
    : mode === 'handoff' ? '외부 터미널에서 실행 중 · 같은 대화로 이어받기 가능'
      : mode === 'resume' ? '원래 터미널이 종료됨 · 같은 세션으로 복구 가능'
        : mode === 'origin-resume' ? '쉬는 데스크톱 작업 · 백그라운드 터미널로 이어가기 가능'
          : mode === 'connect' ? '연결 후 입력 가능 · 현재 세션은 보기 전용'
            : mode === 'origin' ? '보기 전용 · 원래 앱에서 계속' : '종료된 세션';
  const help = mode === 'direct' ? '기존 터미널에 바로 보냅니다. 앱 창을 닫아도 백그라운드에서 세션을 계속 유지합니다.'
    : mode === 'handoff' ? '같은 세션 ID와 대화 내역을 LoadToAgent 관리 터미널로 이어받고 백그라운드에서 유지합니다.'
      : mode === 'resume' ? '기존 세션 ID와 대화 맥락을 복구하고, 앱 창을 닫아도 백그라운드에서 유지합니다.'
        : mode === 'origin-resume' ? `원래 ${origin && origin.provider || '데스크톱'} 앱으로 돌아가거나, 같은 세션을 백그라운드 터미널로 이어서 작업할 수 있습니다.`
          : mode === 'connect' ? `새 터미널에서 loadtoagent run ${session.provider}로 시작하면 창을 닫아도 안전하게 유지됩니다.`
            : mode === 'origin' ? `이 대화는 ${origin && origin.label || '데스크톱 앱'}에서 현재 실행 중이므로 원래 작업에서 계속합니다.`
              : (agentResumeSupport(session).reason || '이 제공사의 세션 재개 방식을 확인할 수 없습니다.');
  const picker = targets.length > 1 ? `<label class="agent-command-target"><span>보낼 터미널</span><select data-agent-command-target="${esc(session.id)}"><option value="">터미널을 선택하세요</option>${targets.map(item => `<option value="${esc(item.id)}" ${item.id === targetId ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>` : '';
  const originAction = `<button type="button" data-agent-open-origin="${esc(session.id)}">원래 ${esc(origin && origin.provider || '데스크톱')} 앱에서 계속하기</button>`;
  const actions = mode === 'direct' ? `<button type="button" data-agent-terminal-open="${esc(session.id)}" ${canSend ? '' : 'disabled'}>터미널에서 열기</button><button type="submit" ${canSend ? '' : 'disabled'}>${sending ? '보내는 중…' : '바로 보내기 ↵'}</button>`
    : mode === 'resume' ? `<button type="submit" ${canSend ? '' : 'disabled'}>${sending ? '복구하는 중…' : '같은 세션으로 복구해 보내기 ↵'}</button>`
      : mode === 'handoff' ? `<button type="submit" ${canSend ? '' : 'disabled'}>${sending ? '이어받는 중…' : '관리 터미널로 이어받아 보내기 ↵'}</button>`
        : mode === 'origin-resume' ? `${originAction}<button type="submit" ${canSend ? '' : 'disabled'}>${sending ? '연결하는 중…' : '백그라운드 터미널로 이어서 보내기 ↵'}</button>`
          : mode === 'connect' ? `<button type="button" data-agent-bridge-copy="${esc(session.provider)}">연결 명령 복사</button>`
            : mode === 'origin' ? originAction : '';
  const editable = mode === 'direct' || mode === 'resume' || mode === 'handoff' || mode === 'origin-resume';
  const placeholder = editable ? '예: 이전 작업에 이어서 테스트를 실행하고 결과를 알려줘' : status;
  return `<form class="agent-command-panel ${mode === 'direct' ? 'connected' : (mode === 'resume' || mode === 'handoff' || mode === 'origin-resume' ? 'resume-ready' : 'unavailable')} control-${mode}" data-agent-command-form="${esc(session.id)}">
    <header><span class="agent-command-icon" aria-hidden="true">›_</span><span><b>이 AI에게 바로 지시하기</b><small>${esc(status)}</small></span><i class="${mode === 'direct' ? 'connected' : ''}" aria-hidden="true"></i></header>
    ${picker}
    <label class="agent-command-input"><span class="sr-only">AI에게 보낼 터미널 지시</span><textarea data-agent-command-draft="${esc(session.id)}" maxlength="8000" rows="3" placeholder="${esc(placeholder)}" ${editable ? '' : 'disabled'}>${editable ? esc(draft) : ''}</textarea></label>
    <div class="agent-command-actions"><small aria-live="polite">${esc(help)}</small>${actions}</div>
  </form>`;
}

function focusedGraph(focus, model, motionKind = 'refresh') {
  const parent = focus.parentId ? model.byId.get(focus.parentId) : null;
  const children = graphChildren(focus, model);
  const { ongoing, completed } = splitSubagents(children);
  const completedExpanded = state.expandedCompletedSubagents.has(focus.id);
  const shownChildren = completedExpanded ? [...ongoing, ...completed] : ongoing;
  const metrics = workflowMetrics(focus, children);
  const upstream = parent
    ? workflowCompactNode(parent, model, 'upstream', parent.parentId ? '이전 AI로 돌아가기' : '메인 AI로 돌아가기')
    : `<div class="agent-workflow-origin"><span class="workflow-origin-icon">◎</span><span><b>사용자 요청</b><small>이 작업이 시작된 곳</small></span><span class="agent-workflow-port output" data-workflow-port="upstream-output" aria-hidden="true"></span></div>`;
  const ongoingRows = ongoing.length
    ? ongoing.map(child => workflowCompactNode(child, model, 'downstream', agentRoleLabel(child.agentRole))).join('')
    : (children.length ? '<div class="agent-workflow-empty current-clear"><b>현재 작업 중인 서브에이전트가 없습니다</b><span>완료된 기록은 아래에서 필요할 때만 펼쳐볼 수 있습니다.</span></div>' : '<div class="agent-workflow-empty">아직 다른 AI에게 나눠 맡긴 일이 없습니다.</div>');
  const completedRows = completedExpanded
    ? `<div class="completed-subagent-list" data-completed-subagent-list>${completed.map(child => workflowCompactNode(child, model, 'downstream', agentRoleLabel(child.agentRole))).join('')}</div>` : '';
  const downstream = `${ongoingRows}${completedSubagentDisclosure(focus.id, completed, completedExpanded)}${completedRows}`;
  const connectMotion = ['focus', 'focus-back', 'view'].includes(motionKind) ? 'motion-connect' : '';
  return `<div class="agent-workflow-canvas ${connectMotion}" data-workflow-focus="${esc(focus.id)}">
    <svg class="agent-workflow-edges" role="img" aria-label="일을 맡긴 AI에서 선택한 AI를 거쳐 도움 AI로 이어지는 연결"><title>AI 작업 연결</title><desc>왼쪽은 일을 맡긴 곳, 가운데는 선택한 AI, 오른쪽은 나눠 맡긴 AI입니다.</desc><defs><marker id="workflowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"></path></marker></defs><g data-workflow-paths></g></svg>
    <div class="agent-workflow-grid">
      <section class="agent-workflow-column upstream-column"><header><b>${parent ? '이 일을 맡긴 AI' : '작업 시작점'}</b><span>${parent ? '왼쪽을 눌러 이전으로 돌아가요' : '사용자가 처음 맡긴 일'}</span></header><div class="agent-workflow-stack">${upstream}</div></section>
      <section class="agent-workflow-column selected-column"><header><b>지금 선택한 AI</b><span>${focus.parentId ? '도움을 나눠 맡은 AI' : '전체 일을 맡은 메인 AI'}</span></header><div class="agent-workflow-selected-stack"><div class="agent-workflow-selected"><span class="agent-workflow-port input" data-workflow-port="focus-input" aria-hidden="true"></span>${graphNode(focus, { focus: true })}</div>${agentCommandComposer(focus)}${shownChildren.length ? '<span class="agent-workflow-port output" data-workflow-port="focus-output" aria-hidden="true"></span>' : ''}</div></section>
      <section class="agent-workflow-column downstream-column" data-workflow-child-count="${children.length}" data-workflow-visible-child-count="${shownChildren.length}">${shownChildren.length ? '<span class="agent-workflow-port input group-input" data-workflow-port="children-group-input" aria-hidden="true"></span>' : ''}<header><b>서브에이전트 세션</b><span>진행·대기 ${ongoing.length}개 바로 표시 · 완료 ${completed.length}개 기본 숨김</span></header>${workflowChildrenSummary(focus, children)}<div class="agent-workflow-stack downstream-stack ${shownChildren.length > 3 ? 'density-many' : ''}">${downstream}</div></section>
    </div>
    ${workflowCommunicationPanel(focus, parent, model)}
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
  const childrenGroupInput = canvas.querySelector('[data-workflow-port="children-group-input"]');
  if (!svg || !paths || !upstream || !focusInput) return;
  const rect = canvas.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`);
  const upstreamPath = `<path class="agent-workflow-edge upstream branch" data-workflow-edge-kind="upstream" pathLength="1" d="${workflowCurve(workflowPortPoint(upstream, rect), workflowPortPoint(focusInput, rect))}" marker-end="url(#workflowArrow)"></path>`;
  const downstreamPath = focusOutput && childrenGroupInput
    ? `<path class="agent-workflow-edge downstream group" data-workflow-edge-kind="children-group" pathLength="1" d="${workflowCurve(workflowPortPoint(focusOutput, rect), workflowPortPoint(childrenGroupInput, rect))}" marker-end="url(#workflowArrow)"></path>` : '';
  paths.innerHTML = `${upstreamPath}${downstreamPath}`;
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
    $('#graphBreadcrumbs').innerHTML = `<button type="button" data-graph-reset>작업 목록</button>${path.map(item => {
      const label = item.parentId ? (item.agentName || agentRoleLabel(item.agentRole)) : item.title;
      const preview = readablePreview(label, item.parentId ? 42 : 72);
      return `<i>›</i><button type="button" data-graph-focus="${esc(item.id)}" class="${item.id === focus.id ? 'current' : ''}" title="${esc(preview.full)}">${esc(preview.text)}</button>`;
    }).join('')}`;
    $('#graphResetBtn').classList.remove('hidden');
    scheduleAgentWorkflowConnections();
  } else {
    const tmuxEntries = liveTmuxEntries();
    const standardRoots = roots.filter(root => agentExecutionMode(root).kind !== 'tmux');
    const activeCount = model.nodes.filter(isLiveSession).length + tmuxEntries.filter(entry => !entry.agent.linkedSessionId).length;
    $('#liveSessionGrid').innerHTML = `<details class="runtime-disclosure" ${state.view === 'active' ? 'open' : ''}><summary><span><b>${activeCount}개 AI가 작업 중입니다</b><small>일반 실행과 tmux의 세부 흐름은 필요할 때 펼쳐보세요.</small></span><em>상세 흐름 보기 <i aria-hidden="true">↓</i></em></summary>${runtimeSeparatedOverview(roots, model)}</details>`;
    $('#graphBreadcrumbs').innerHTML = `<span class="map-hint">일반 실행 <b>${standardRoots.length}</b>개 · TMUX AI <b>${tmuxEntries.length}</b>개 · <b>${model.nodes.filter(item => item.parentId).length}</b>개 도움 AI</span>`;
    $('#graphResetBtn').classList.add('hidden');
  }
  return model.nodes.filter(isLiveSession).length + liveTmuxEntries().filter(entry => !entry.agent.linkedSessionId).length;
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
  if (user) rows.push({ label: '나', text: readablePreview(user.text, 140).text, tone: 'user' });
  if (assistant) rows.push({ label: providerInfo(session.provider).label, text: readablePreview(assistant.text, 140).text, tone: 'assistant' });
  else if (tool) rows.push({ label: tool.title || '도구', text: readablePreview(tool.text, 140).text, tone: 'tool' });
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
  const titlePreview = readablePreview(session.title, 96);
  const activityCopy = latestWorkCopy(session) || session.statusDetail || '새 이벤트 대기';
  const activityPreview = readablePreview(activityCopy, 116);
  const accessibleId = `session-${String(session.id || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return `<article class="session-card ${opts.live ? 'live-card' : ''} ${statusClass(session.status)} ${session.parentId ? 'subagent' : ''}" data-session-id="${esc(session.id)}" data-motion-key="session:${esc(session.id)}" data-motion-value="${esc(session.updatedAt || '')}:${usage.total || 0}:${esc(session.status || '')}" style="${providerStyle(session.provider)}" role="button" tabindex="0" aria-labelledby="${accessibleId}-title" aria-describedby="${accessibleId}-summary">
    <div class="card-head">
      <span class="provider-mark">${esc(provider.mark)}</span>
      <div class="card-head-main"><div class="card-provider-line"><b>${esc(provider.label)}</b><span>${esc(provider.company)}</span></div></div>
      ${executionModeBadge(session, true)}
      <span class="status-pill ${statusClass(session.status)}">${esc(STATUS[session.status] || session.status)}</span>
    </div>
    <h3 id="${accessibleId}-title" class="card-title" title="${esc(titlePreview.full)}">${esc(titlePreview.text)}</h3>
    <div class="card-subtitle"><span>${esc(model)}</span><i></i><span title="${esc(isProjectlessSession(session) ? '특정 프로젝트에 연결되지 않은 세션' : session.cwd)}">${esc(sessionWorkspaceLabel(session))}</span>${session.agentName ? `<i></i><span>${esc(session.agentName)}</span>` : ''}</div>
    <div id="${accessibleId}-summary" class="now-strip ${running ? 'is-live' : ''}">
      <span class="now-strip-icon">${statusIcon(activity.type)}</span>
      <div><b>${running ? '지금: ' : ''}${esc(activity.title)}</b><span title="${esc(activityPreview.full)}">${esc(activityPreview.text)}</span></div>
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
    ${children.length ? `<div class="child-row"><b>⑂</b><span>서브에이전트 ${children.length}개 누적 생성</span><span class="child-dots">${children.slice(0, 4).map(() => '<i></i>').join('')}</span></div>` : ''}
    <footer class="card-footer"><span class="source-tag">${esc(session.sourceLabel || '내 PC의 작업 기록')}</span><span>${esc(timeAgo(session.updatedAt))}</span></footer>
  </article>`;
}

function renderSessions(motionKind = 'refresh', deferMotion = false) {
  const previousLayout = deferMotion ? null : captureMotionLayout();
  syncViewChrome();
  renderGuide();
  const tmuxView = state.view === 'tmux';
  const terminalView = state.view === 'terminal';
  const settingsView = state.view === 'settings';
  $('#terminalSection').classList.toggle('hidden', !terminalView);
  $('#tmuxSection').classList.toggle('hidden', !tmuxView);
  $('#settingsSection').classList.toggle('hidden', !settingsView);
  $('#globalStats').classList.toggle('hidden', tmuxView || terminalView || settingsView);
  $('#providerOverview').classList.toggle('hidden', tmuxView || terminalView || settingsView);
  $('#sessionSection').classList.toggle('hidden', tmuxView || terminalView || settingsView);
  const guideVisible = state.view === 'all' && state.guideExpanded && !state.graphFocusId;
  $('#beginnerGuide').classList.toggle('hidden', !guideVisible);
  $('#guideBtn').setAttribute('aria-expanded', guideVisible ? 'true' : 'false');
  renderUpdateSettings();
  if (settingsView) {
    $('#liveSection').classList.add('hidden');
    if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.deactivate();
    if (!deferMotion) playMotionLayout(previousLayout, motionKind);
    if (motionKind === 'view') animateVisibleSections();
    return;
  }
  if (terminalView) {
    $('#liveSection').classList.add('hidden');
    if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.activate(state.snapshot, state.workspaces, 'general');
    if (!deferMotion) playMotionLayout(previousLayout, motionKind);
    if (motionKind === 'view') animateVisibleSections();
    return;
  }
  if (tmuxView) {
    $('#liveSection').classList.add('hidden');
    renderTmuxMap();
    if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.activate(state.snapshot, state.workspaces, 'tmux');
    if (!deferMotion) playMotionLayout(previousLayout, motionKind);
    if (motionKind === 'view') animateVisibleSections();
    return;
  }
  if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.deactivate();
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
  if (graphLiveCount + regular.length === 0) {
    const emptyCopy = state.search
      ? ['검색 결과가 없습니다', '검색어를 지우거나 AI와 작업 폴더 필터를 바꿔보세요.']
      : state.view === 'active'
        ? ['현재 진행 중인 작업이 없습니다', '새 일을 맡기면 진행 상황이 이곳에 바로 표시됩니다.']
        : state.view === 'waiting'
          ? ['모두 확인했습니다', '지금은 내 답변이나 선택을 기다리는 작업이 없습니다.']
          : ['아직 보여줄 작업이 없습니다', 'AI 준비 상태를 확인한 뒤 첫 작업을 시작해보세요.'];
    $('#emptyState h3').textContent = emptyCopy[0];
    $('#emptyState p').textContent = emptyCopy[1];
  }
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

async function resumeAgentTerminal(sessionId, sendDraft = false) {
  if (state.agentCommandSending.has(sessionId)) return;
  const session = snapshotSession(sessionId) || state.details.get(sessionId);
  if (!session || !window.LoadToAgentTerminal) return toast('다시 연결할 AI 세션 정보를 찾지 못했습니다.');
  const support = agentResumeSupport(session);
  if (!support.supported) return toast(support.reason || '이 AI 세션은 터미널에서 다시 연결할 수 없습니다.');
  state.agentCommandSending.add(sessionId);
  try {
    if ($('#detailDrawer').classList.contains('open')) closeDrawer(false);
    selectView('terminal');
    const draft = state.agentCommandDrafts.get(sessionId) || '';
    await window.LoadToAgentTerminal.resumeForAgent(session, draft, sendDraft);
    if (sendDraft && draft.trim()) state.agentCommandDrafts.delete(sessionId);
    document.querySelector('.main-stage')?.scrollTo({ top: 0, behavior: 'auto' });
    toast(`${providerInfo(session.provider).label}의 기존 세션을 터미널에 다시 연결했습니다.`);
  } catch (error) {
    toast(error && error.message || 'AI 세션을 다시 연결하지 못했습니다.');
  } finally {
    state.agentCommandSending.delete(sessionId);
  }
}

async function dispatchAgentCommand(sessionId, form) {
  if (state.agentCommandSending.has(sessionId)) return;
  const session = snapshotSession(sessionId);
  if (!session || !window.LoadToAgentTerminal) return toast('선택한 AI의 최신 정보를 찾지 못했습니다.');
  const mode = agentControlMode(session, agentCommandTargets(session));
  if (mode === 'resume' || mode === 'handoff' || mode === 'origin-resume') {
    const input = form.querySelector('[data-agent-command-draft]');
    if (input) state.agentCommandDrafts.set(sessionId, input.value);
    if (!String(input && input.value || '').trim()) return toast('AI에게 보낼 지시를 입력하세요.');
    return resumeAgentTerminal(sessionId, true);
  }
  const target = chosenAgentCommandTarget(session);
  const input = form.querySelector('[data-agent-command-draft]');
  const command = String(input && input.value || '').trim();
  if (!target) return toast(agentCommandTargets(session).length ? '지시를 보낼 터미널을 먼저 선택하세요.' : '이 AI에 연결된 입력 가능한 터미널이 없습니다.');
  if (!command) return toast('AI에게 보낼 지시를 입력하세요.');
  state.agentCommandSending.add(sessionId);
  const submit = form.querySelector('[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = '보내는 중…'; }
  try {
    await window.LoadToAgentTerminal.dispatchAgentCommand(session, command, target.id);
    state.agentCommandDrafts.delete(sessionId);
    if (input) input.value = '';
    toast(`${target.label}에 지시를 보냈습니다.`);
  } catch (error) {
    const latest = snapshotSession(sessionId) || session;
    const support = agentResumeSupport(latest);
    if (!agentCommandTargets(latest).length && support.supported) {
      try {
        state.agentCommandDrafts.set(sessionId, command);
        await window.LoadToAgentTerminal.resumeForAgent(latest, command, true);
        state.agentCommandDrafts.delete(sessionId);
        if (input) input.value = '';
        toast('원래 터미널 연결이 종료되어 같은 AI 세션으로 복구한 뒤 지시를 보냈습니다.');
        return;
      } catch (resumeError) {
        toast(resumeError && resumeError.message || '터미널 연결이 끊어졌고 세션 복구에도 실패했습니다.');
      }
    } else toast(error && error.message || '터미널에 지시를 보내지 못했습니다.');
  } finally {
    state.agentCommandSending.delete(sessionId);
    if (submit && submit.isConnected) { submit.disabled = false; submit.textContent = '바로 보내기 ↵'; }
  }
}

async function openAgentTerminal(sessionId) {
  const session = snapshotSession(sessionId);
  if (!session || !window.LoadToAgentTerminal) return toast('선택한 AI의 터미널 정보를 찾지 못했습니다.');
  const target = chosenAgentCommandTarget(session);
  if (!target) return toast(agentCommandTargets(session).length ? '열어볼 터미널을 먼저 선택하세요.' : '이 AI에 연결된 입력 가능한 터미널이 없습니다.');
  selectView(target.kind === 'tmux' ? 'tmux' : 'terminal');
  try {
    await window.LoadToAgentTerminal.openForAgent(session, target.id, state.agentCommandDrafts.get(sessionId) || '');
    document.querySelector('.main-stage')?.scrollTo({ top: 0, behavior: 'auto' });
  } catch (error) {
    toast(error && error.message || 'AI의 터미널을 열지 못했습니다.');
  }
}

async function copyBridgeCommand(provider) {
  try {
    const result = await window.loadtoagent.bridgeCommand(provider);
    if (!result || !result.ok) throw new Error('연결 명령을 만들지 못했습니다.');
    const command = result.command;
    await window.loadtoagent.writeClipboard(command);
    toast(`${command} 명령을 복사했습니다.`);
  } catch (error) {
    toast(error && error.message || '연결 명령을 복사하지 못했습니다.');
  }
}

async function openSessionOrigin(sessionId) {
  const session = snapshotSession(sessionId);
  const origin = originAppInfo(session);
  if (!session || !origin) return toast('원래 데스크톱 작업 정보를 찾지 못했습니다.');
  try {
    const result = await window.loadtoagent.openSessionOrigin(session);
    if (!result || !result.ok) return toast(`이 작업은 ${origin.label}에서 직접 열 수 없습니다.`);
    toast(`원래 ${origin.provider} 작업을 열었습니다.`);
  } catch (error) {
    toast(error && error.message || `${origin.label}을 열지 못했습니다.`);
  }
}

async function loadSessionDetail(id, force = false) {
  if (!force && state.details.has(id)) return state.details.get(id);
  state.detailErrors.delete(id);
  state.detailLoadingIds.add(id);
  renderDrawer();
  try {
    const detail = await window.loadtoagent.sessionDetail(id);
    if (detail) state.details.set(id, detail);
    return detail;
  } catch (error) {
    state.detailErrors.set(id, error && error.message || '작업 기록을 불러오지 못했습니다.');
    return null;
  } finally {
    state.detailLoadingIds.delete(id);
    if (state.selectedId === id) {
      state.drawerForceLatest = state.drawerTab === 'chat';
      renderDrawer();
    }
  }
}

function openDrawer(id) {
  rememberDialogTrigger();
  markGuideStep('detail');
  state.selectedId = id;
  state.drawerMode = 'session';
  state.drawerTab = 'chat';
  state.drawerForceLatest = true;
  clearTimeout(motionState.drawerTimer);
  $('#drawerBackdrop').classList.remove('hidden');
  $('#drawerBackdrop').classList.remove('closing');
  $('#detailDrawer').classList.add('open');
  $('#detailDrawer').removeAttribute('inert');
  $('#detailDrawer').setAttribute('aria-hidden', 'false');
  renderDrawer();
  loadSessionDetail(id, true);
  setTimeout(() => $('#closeDrawerBtn').focus(), 0);
}

async function loadSubagentParentDetail(child) {
  if (!child || !child.parentId || state.details.has(child.parentId)) return;
  try {
    const detail = await window.loadtoagent.sessionDetail(child.parentId);
    if (detail) state.details.set(child.parentId, detail);
    if (state.drawerMode === 'subagent' && state.selectedId === child.id) renderDrawer();
  } catch {}
}

function openSubagentConversation(id) {
  const child = snapshotSession(id) || state.details.get(id);
  if (!child || !child.parentId) return openDrawer(id);
  rememberDialogTrigger();
  markGuideStep('detail');
  state.selectedId = id;
  state.drawerMode = 'subagent';
  state.drawerTab = 'chat';
  state.drawerForceLatest = true;
  clearTimeout(motionState.drawerTimer);
  $('#drawerBackdrop').classList.remove('hidden');
  $('#drawerBackdrop').classList.remove('closing');
  $('#detailDrawer').classList.add('open');
  $('#detailDrawer').removeAttribute('inert');
  $('#detailDrawer').setAttribute('aria-hidden', 'false');
  renderDrawer();
  loadSubagentParentDetail(child);
  setTimeout(() => $('#closeDrawerBtn').focus(), 0);
}

function closeDrawer(restoreFocus = true) {
  if (!$('#detailDrawer').classList.contains('open')) return;
  $('#detailDrawer').classList.remove('open');
  $('#detailDrawer').setAttribute('aria-hidden', 'true');
  $('#detailDrawer').setAttribute('inert', '');
  $('#drawerBackdrop').classList.add('closing');
  clearTimeout(motionState.drawerTimer);
  motionState.drawerTimer = setTimeout(() => {
    $('#drawerBackdrop').classList.add('hidden');
    $('#drawerBackdrop').classList.remove('closing');
    if (restoreFocus) restoreDialogTrigger();
    else motionState.activeDialogTrigger = null;
  }, motionPreference.matches ? 0 : 260);
}

function chatHtml(session) {
  const messages = session.messages || [];
  if (!messages.length) return '<div class="empty-state"><h3>표시할 대화가 없습니다</h3></div>';
  const conversation = messages.filter(message => message.role === 'user' || message.role === 'assistant');
  const activities = messages.filter(message => message.role !== 'user' && message.role !== 'assistant');
  const omitted = Number(session.omittedMessages || 0);
  const notice = omitted || session.truncated ? `<div class="chat-truncated">이 작업의 최근 기록을 표시합니다${omitted ? ` · 이전 ${omitted.toLocaleString(uiLocale())}개 메시지 생략` : ''}</div>` : '';
  const statusLabel = value => ({ started: '실행 중', running: '실행 중', done: '완료', completed: '완료', failed: '실패' }[value] || value || '');
  const rows = conversation.map(message => {
    const role = message.role === 'assistant' ? 'assistant' : (message.role === 'tool' ? 'tool' : (message.role === 'system' ? 'system' : 'user'));
    const label = role === 'assistant' ? providerInfo(session.provider).label : (role === 'tool' ? (message.title || '도구') : (message.role === 'system' ? '시스템' : '사용자'));
    const avatar = role === 'assistant' ? providerInfo(session.provider).mark : (role === 'tool' ? '⌘' : (role === 'system' ? 'i' : 'ME'));
    const fullTime = new Date(message.timestamp).toLocaleString(uiLocale());
    return `<div class="chat-row ${role}" data-message-id="${esc(message.id || '')}"><span class="chat-avatar">${esc(avatar)}</span><div class="chat-bubble"><div class="chat-bubble-head"><b>${esc(label)}</b><span title="${esc(fullTime)}">${esc(timeOnly(message.timestamp))}</span>${message.status ? `<span>${esc(statusLabel(message.status))}</span>` : ''}</div>${messageContentHtml(message)}</div></div>`;
  }).join('');
  const activityHtml = activities.length ? `<details class="chat-activities"><summary>도구·시스템 활동 ${activities.length}건 보기</summary><div>${activities.map(message => `<article><header><b>${esc(message.title || (message.role === 'tool' ? '도구 실행' : '시스템'))}</b><span>${esc(statusLabel(message.status))} · ${esc(timeOnly(message.timestamp))}</span></header>${messageContentHtml(message)}</article>`).join('')}</div></details>` : '';
  const emptyConversation = conversation.length ? '' : '<div class="empty-state compact"><h3>사용자와 AI의 대화는 아직 없습니다</h3></div>';
  return `${notice}<div class="chat-history-head"><span>대화 ${conversation.length}개${activities.length ? ` · 활동 ${activities.length}건` : ''}</span><button type="button" data-scroll-latest>가장 최근 대화 ↓</button></div><div class="chat-list">${rows}${emptyConversation}${activityHtml}<div class="chat-latest-anchor" aria-label="가장 최근 대화"></div></div>`;
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

function subagentCommunicationEvents(session) {
  if (!session || !session.parentId) return [];
  const parent = state.details.get(session.parentId) || snapshotSession(session.parentId);
  const all = parent && parent.collaboration && parent.collaboration.communications || [];
  const taskName = session.taskName || session.delegation && session.delegation.taskName || agentPathTaskName(session.agentPath);
  return all.filter(event => ['assignment', 'started', 'followup', 'message', 'result', 'interrupt'].includes(event.kind))
    .filter(event => event.childId === session.id || (taskName && event.taskName === taskName));
}

function subagentTextPreview(value, maxCharacters = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxCharacters) return { text, truncated: false };
  return { text: `${text.slice(0, maxCharacters).trimEnd()}…`, truncated: true };
}

function protectedSubagentEventText(event, taskName) {
  if (event.kind === 'followup') return '보호된 추가 작업 지시를 전달했습니다.';
  if (event.kind === 'message') return '보호된 메시지를 전달했습니다.';
  return `${taskName || '이 작업'}을 서브에이전트에게 배정했습니다.`;
}

function subagentConversationHtml(session) {
  const events = subagentCommunicationEvents(session);
  const taskName = session.taskName || session.delegation && session.delegation.taskName || session.title;
  const childPath = String(session.agentPath || '');
  const endpointIsChild = value => {
    const endpoint = String(value || '');
    return endpoint === childPath || endpoint === session.id || agentPathTaskName(endpoint) === taskName;
  };
  const enriched = events.map(event => ({ ...event, fromChild: event.kind === 'result' || endpointIsChild(event.from) }));
  const received = enriched.filter(event => !event.fromChild && event.kind !== 'started').length;
  const answered = enriched.filter(event => event.fromChild).length;
  if (!events.length) return '<div class="empty-state"><h3>메인 AI와 주고받은 기록이 없습니다</h3><p>세션 로그에서 배정·추가 지시·결과 반환 이벤트를 찾지 못했습니다.</p></div>';
  const provider = providerInfo(session.provider);
  const rows = enriched.map(event => {
    const runtime = event.kind === 'started';
    const role = runtime ? 'system' : (event.fromChild ? 'assistant' : 'user');
    const label = runtime ? '실행 상태' : (event.fromChild ? `서브 AI · ${session.agentName || taskName}` : '메인 AI');
    const avatar = runtime ? '↗' : (event.fromChild ? provider.mark : 'M');
    const route = runtime ? '런타임 → 서브 AI' : (event.fromChild ? '서브 AI → 메인 AI' : '메인 AI → 서브 AI');
    const text = event.protected
      ? protectedSubagentEventText(event, taskName)
      : (event.text || (runtime ? '서브에이전트 실행이 시작되었습니다.' : '내용 없이 통신 상태만 기록되었습니다.'));
    const preview = subagentTextPreview(text);
    const eventLabel = `${event.label || event.kind}${event.assignmentSource === 'parent-narration' ? ' · 작업 시작 직전 메인 AI 설명' : ''}`;
    return `<div class="chat-row ${role} subagent-dialog-row" data-subagent-communication="${esc(event.kind)}">
      <span class="chat-avatar">${esc(avatar)}</span><div class="chat-bubble"><div class="chat-bubble-head"><b>${esc(label)}</b><span class="subagent-route">${esc(route)}</span><span>${esc(timeOnly(event.timestamp))}</span></div><small class="subagent-event-label">${esc(eventLabel)}</small><div class="chat-content subagent-message-preview${preview.truncated ? ' is-truncated' : ''}" data-subagent-message-preview data-truncated="${preview.truncated ? 'true' : 'false'}"><p>${esc(preview.text)}</p></div></div>
    </div>`;
  }).join('');
  return `<div class="subagent-conversation-summary" data-subagent-dialog-count="${events.length}"><span><small>받은 지시·응답</small><b>${received}</b>건</span><span><small>메인에 보낸 답변</small><b>${answered}</b>건</span><span><small>전체 소통</small><b>${events.length}</b>건</span></div>
    <div class="chat-history-head"><span><b>${esc(taskName)}</b>와 메인 AI가 주고받은 내용만 표시</span><button type="button" data-scroll-latest>가장 최근 대화 ↓</button></div>
    <div class="chat-list subagent-dialog-list">${rows}<div class="chat-latest-anchor" aria-label="가장 최근 대화"></div></div>`;
}

function renderDrawer() {
  const session = selectedSession();
  if (!session) return closeDrawer();
  const provider = providerInfo(session.provider);
  const subagentMode = state.drawerMode === 'subagent' && Boolean(session.parentId);
  const detailLoading = !subagentMode && state.detailLoadingIds.has(state.selectedId);
  $('#detailDrawer').style.setProperty('--drawer-provider', provider.accent);
  $('#drawerProviderMark').style.setProperty('--provider', provider.accent);
  $('#drawerProviderMark').textContent = provider.mark;
  $('#drawerProvider').textContent = subagentMode ? `${session.agentName || provider.label} · 메인 AI와의 소통` : `${provider.company} · ${STATUS[session.status] || session.status}`;
  $('#drawerTitle').textContent = subagentMode ? (session.taskName || session.delegation && session.delegation.taskName || session.title) : session.title;
  const stopping = session.runId && state.stopRequests.has(session.runId);
  const stop = session.runId && (session.status === 'running' || session.status === 'starting') ? `<button class="meta-chip stop-run" data-stop-run="${esc(session.runId)}" ${stopping ? 'disabled aria-busy="true"' : ''}>${stopping ? '중지 요청 중…' : '■ 실행 중지'}</button>` : '';
  const runtime = session.runtimePresence || [];
  const resume = !isLiveSession(session) && agentResumeSupport(session).supported
    ? `<button class="meta-chip resume-agent" data-resume-agent="${esc(session.id)}">▶ <b>${originAppInfo(session) ? '백그라운드 터미널로 이어가기' : '터미널로 다시 일 시키기'}</b></button>` : '';
  const communicationCount = subagentMode ? subagentCommunicationEvents(session).length : 0;
  $('#drawerMeta').innerHTML = subagentMode
    ? `<span class="meta-chip work-state ${subagentWorkState(session)}"><b>${esc(subagentWorkLabel(session))}</b></span><span class="meta-chip">사용 모델 <b>${esc(session.model || '정보 없음')}</b></span><span class="meta-chip">메인과 소통 <b>${communicationCount}건</b></span>${resume}`
    : `<span class="meta-chip">사용 모델 <b>${esc(session.model || '정보 없음')}</b></span><span class="meta-chip">작업 폴더 <b title="${esc(isProjectlessSession(session) ? '특정 프로젝트에 연결되지 않은 세션' : session.cwd)}">${esc(sessionWorkspaceLabel(session))}</b></span><span class="meta-chip">작업 번호 <b>${esc(String(session.externalId || '').slice(0, 12) || '정보 없음')}</b></span>${session.parentId ? '<span class="meta-chip">⑂ <b>도움을 맡은 AI</b></span>' : ''}${runtime.length ? `<span class="meta-chip runtime-meta">● <b>실행 중인 프로그램 ${runtime.length}개</b></span>` : ''}${resume}${stop}`;
  $$('.drawer-tab').forEach(tab => {
    const hidden = subagentMode && tab.dataset.tab !== 'chat';
    tab.classList.toggle('hidden', hidden);
    if (tab.dataset.tab === 'chat') tab.textContent = subagentMode ? '메인과의 대화' : '대화 내용';
    const active = tab.dataset.tab === state.drawerTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  });
  const activeTab = $(`.drawer-tab[data-tab="${state.drawerTab}"]`);
  if (activeTab) $('#drawerContent').setAttribute('aria-labelledby', activeTab.id);
  const content = $('#drawerContent');
  const previousTop = content.scrollTop;
  const wasNearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 90;
  const renderKey = `${state.drawerMode}:${state.selectedId}:${state.drawerTab}:${detailLoading ? 'loading' : 'ready'}`;
  const previousRenderKey = motionState.drawerRenderKey;
  const shouldAnimateContent = previousRenderKey !== renderKey;
  const tabChanged = Boolean(motionState.drawerTab) && motionState.drawerTab !== state.drawerTab;
  motionState.drawerRenderKey = renderKey;
  motionState.drawerTab = state.drawerTab;
  const detailError = state.detailErrors.get(state.selectedId);
  content.innerHTML = detailLoading
    ? '<div class="drawer-loading"><span></span><b>전체 작업 기록을 불러오는 중</b><small>잠시만 기다리면 대화와 진행 과정을 볼 수 있어요.</small></div>'
    : (detailError && !subagentMode ? `<div class="drawer-error"><b>작업 기록을 불러오지 못했습니다</b><span>${esc(detailError)}</span><button type="button" data-retry-detail="${esc(state.selectedId)}">다시 시도</button></div>` : (subagentMode ? subagentConversationHtml(session) : (state.drawerTab === 'chat' ? chatHtml(session) : (state.drawerTab === 'lifecycle' ? lifecycleHtml(session) : tokensHtml(session)))));
  content.classList.toggle('motion-content-in', shouldAnimateContent && !motionPreference.matches);
  clearTimeout(motionState.drawerContentTimer);
  if (shouldAnimateContent) motionState.drawerContentTimer = setTimeout(() => content.classList.remove('motion-content-in'), motionPreference.matches ? 0 : 520);
  if (!detailLoading) requestAnimationFrame(() => {
    const forceLatest = state.drawerForceLatest;
    if (state.drawerTab === 'chat' && forceLatest) {
      const rows = [...content.querySelectorAll('.chat-row')];
      const latest = rows[rows.length - 1];
      if (latest && latest.offsetHeight > content.clientHeight - 90) {
        const contentTop = content.getBoundingClientRect().top;
        const stickyHeight = content.querySelector('.chat-history-head')?.getBoundingClientRect().height || 0;
        content.scrollTop = Math.max(0, content.scrollTop + latest.getBoundingClientRect().top - contentTop - stickyHeight - 12);
      } else content.scrollTop = content.scrollHeight;
    }
    else if (tabChanged) content.scrollTop = 0;
    else if (state.drawerTab === 'chat' && wasNearBottom) content.scrollTop = content.scrollHeight;
    else content.scrollTop = Math.min(previousTop, Math.max(0, content.scrollHeight - content.clientHeight));
    state.drawerForceLatest = false;
  });
}

function providerPickerHtml() {
  return state.providers.map(provider => {
    const installed = !!state.availability[provider.id];
    const selected = state.runProvider === provider.id;
    return `<button type="button" class="run-provider-option ${selected ? 'selected' : ''}" data-run-provider="${esc(provider.id)}" style="${providerStyle(provider.id)}" aria-pressed="${selected ? 'true' : 'false'}" ${installed ? '' : 'disabled'}><span class="provider-mini-mark">${esc(provider.mark)}</span><span class="run-provider-copy"><b>${esc(provider.label)}</b><small>${esc(installed ? `${provider.company} · CLI 발견됨` : '설치 필요')}</small></span><span class="run-provider-check" aria-hidden="true">✓</span></button>`;
  }).join('');
}

function runProviderHelpHtml() {
  const available = state.providers.filter(provider => state.availability[provider.id]);
  if (available.length) return '';
  const docs = state.providers.map(provider => `<button type="button" data-provider-docs="${esc(provider.id)}"><span class="provider-mini-mark" style="${providerStyle(provider.id)}">${esc(provider.mark)}</span><span><b>${esc(provider.label)} 설치 안내</b><small>공식 문서에서 CLI 설치와 로그인을 확인하세요.</small></span><i aria-hidden="true">↗</i></button>`).join('');
  return `<div class="run-provider-help-copy"><b>먼저 AI CLI 한 개를 준비해 주세요</b><p>1. 아래 공식 설치 안내 열기 → 2. 터미널에서 로그인 → 3. 설치 확인을 누르면 됩니다.</p></div><div class="run-provider-docs">${docs}</div><button type="button" class="provider-recheck" data-provider-recheck>↻ 설치 상태 다시 확인</button>`;
}

function runWorkspaceSuggestionsHtml() {
  const selected = String($('#runCwd') && $('#runCwd').value || '');
  return state.workspaces.slice(0, 4).map(workspace => {
    const path = workspace.path || workspace.name || '';
    const active = path === selected;
    return `<button type="button" data-run-workspace="${esc(path)}" class="${active ? 'selected' : ''}" title="${esc(path)}"><span aria-hidden="true">⌘</span>${esc(workspace.name || path.split(/[\\/]/).filter(Boolean).pop() || '작업 폴더')}</button>`;
  }).join('');
}

function syncRunComposer() {
  const prompt = $('#runPrompt');
  const count = $('#runPromptCount');
  if (prompt && count) count.textContent = `${prompt.value.length.toLocaleString(uiLocale())} / 8,000`;
  const submitLabel = $('#runSubmitLabel');
  const submit = $('#runForm button[type="submit"]');
  const hasProvider = Boolean(state.availability[state.runProvider]);
  const providerHelp = $('#runProviderHelp');
  if (providerHelp) {
    providerHelp.innerHTML = runProviderHelpHtml();
    providerHelp.classList.toggle('hidden', state.providers.some(provider => state.availability[provider.id]));
  }
  if (submit) submit.disabled = submit.dataset.submitting === 'true' || !hasProvider;
  if (submitLabel && submit.dataset.submitting !== 'true') submitLabel.textContent = hasProvider ? `${providerInfo(state.runProvider).label}에게 맡기기` : 'AI 설치가 필요합니다';
  const writeIntent = /(고치|수정|추가|구현|변경|삭제|작성|리팩터|fix|implement|update|edit|refactor)/i.test(prompt && prompt.value || '');
  const permissionHint = $('#runPermissionHint');
  const permissionNeeded = writeIntent && !$('#allowWrites').checked;
  permissionHint.classList.toggle('hidden', !permissionNeeded);
  if (permissionNeeded) $('#allowWrites').setAttribute('aria-describedby', 'runPermissionHint');
  else $('#allowWrites').removeAttribute('aria-describedby');
  const suggestions = $('#runWorkspaceSuggestions');
  if (suggestions) suggestions.innerHTML = runWorkspaceSuggestionsHtml();
}

function setRunSubmitting(submitting) {
  const submit = $('#runForm button[type="submit"]');
  if (!submit) return;
  submit.dataset.submitting = submitting ? 'true' : 'false';
  submit.disabled = submitting || !state.availability[state.runProvider];
  submit.setAttribute('aria-busy', submitting ? 'true' : 'false');
  const label = $('#runSubmitLabel');
  if (label) label.textContent = submitting ? 'AI 작업을 준비하는 중…' : `${providerInfo(state.runProvider).label}에게 맡기기`;
}

function openRunModal() {
  rememberDialogTrigger();
  const installed = state.providers.find(provider => state.availability[provider.id]);
  if (!state.availability[state.runProvider] && installed) state.runProvider = installed.id;
  $('#runProviderPicker').innerHTML = providerPickerHtml();
  if (!$('#runCwd').value) $('#runCwd').value = state.workspace !== 'all' ? state.workspace : (state.workspaces[0] && state.workspaces[0].path || '');
  $('#runCwd').placeholder = state.platform.id === 'win32' ? 'D:\\project' : '/Users/me/project';
  const advanced = $('#runForm .run-advanced');
  if (advanced) advanced.open = Boolean($('#runModel').value.trim());
  $('#runError').classList.add('hidden');
  syncRunComposer();
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
    restoreDialogTrigger();
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
  if (!state.availability[state.runProvider]) {
    $('#runError').textContent = '준비된 AI CLI가 없습니다. 공식 설치 안내를 따라 설치·로그인한 뒤 다시 확인해 주세요.';
    $('#runError').classList.remove('hidden');
    return;
  }
  setRunSubmitting(true);
  $('#runError').classList.add('hidden');
  try {
    const result = await window.loadtoagent.runAgent({
      provider: state.runProvider,
      cwd: $('#runCwd').value.trim(),
      model: $('#runModel').value.trim(),
      prompt: $('#runPrompt').value.trim(),
      allowWrites: $('#allowWrites').checked,
    });
    if (!result.ok) throw new Error(result.error || '실행을 시작하지 못했습니다.');
    markGuideStep('create');
    closeRunModal();
    $('#runPrompt').value = '';
    syncRunComposer();
    toast(`${providerInfo(state.runProvider).label} 작업을 시작했습니다. ‘진행 중’ 화면에서 상태를 확인하세요.`);
  } catch (error) {
    $('#runError').textContent = error.message;
    $('#runError').classList.remove('hidden');
  } finally {
    setRunSubmitting(false);
  }
}

function bindEvents() {
  $('.view-nav').addEventListener('click', event => {
    const button = event.target.closest('.nav-item');
    if (!button || !button.dataset.view) return;
    selectView(button.dataset.view);
  });
  $('#updateNoticeBtn').addEventListener('click', () => {
    selectView('settings');
  });
  $('#guideBtn').addEventListener('click', () => {
    state.guideExpanded = !state.guideExpanded || state.view !== 'all';
    saveGuideState();
    if (state.view !== 'all') selectView('all');
    else renderSessions('guide');
    if (state.guideExpanded) setTimeout(() => $('#beginnerGuide').scrollIntoView({ behavior: motionPreference.matches ? 'auto' : 'smooth', block: 'start' }), 0);
  });
  $('#dismissGuideBtn').addEventListener('click', () => {
    state.guideExpanded = false;
    saveGuideState();
    renderSessions('guide');
    $('#guideBtn').focus();
  });
  $('#beginnerGuide').addEventListener('click', event => {
    const action = event.target.closest('[data-guide-action]')?.dataset.guideAction;
    if (!action) return;
    if (action === 'create') return openRunModal();
    if (action === 'active' || action === 'waiting') return selectView(action, { focusMain: true });
    if (action === 'detail') {
      const first = filteredSessions()[0] || (state.snapshot && state.snapshot.sessions || [])[0];
      if (first) openDrawer(first.id);
      else {
        toast('아직 열어볼 작업이 없어요. 먼저 AI에게 첫 일을 맡겨보세요.');
        openRunModal();
      }
    }
  });
  $('#mobileMoreBtn').addEventListener('click', () => {
    const menu = $('#mobileToolsMenu');
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    $('#mobileMoreBtn').setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) setTimeout(() => menu.querySelector('button')?.focus(), 0);
  });
  $('#mobileToolsMenu').addEventListener('click', event => {
    const button = event.target.closest('[data-mobile-view]');
    if (button) selectView(button.dataset.mobileView, { focusMain: true });
  });
  $('#checkUpdateBtn').addEventListener('click', async () => {
    try {
      state.update = { ...(state.update || {}), status: 'checking', error: '' };
      renderUpdateSettings();
      state.update = await window.loadtoagent.checkForUpdate();
      renderUpdateSettings();
    } catch (error) {
      toast(error && error.message || '업데이트를 확인하지 못했습니다.');
    }
  });
  $('#installUpdateBtn').addEventListener('click', async () => {
    try {
      if (state.update && state.update.status === 'downloaded') {
        await window.loadtoagent.openDownloadedUpdate();
        toast('설치 파일을 열었습니다. 화면의 안내에 따라 업데이트를 마무리하세요.');
      } else {
        state.update = await window.loadtoagent.downloadUpdate();
        renderUpdateSettings();
      }
    } catch (error) {
      toast(error && error.message || '업데이트 파일을 준비하지 못했습니다.');
    }
  });
  $('#openReleaseBtn').addEventListener('click', async () => {
    try { await window.loadtoagent.openUpdateRelease(); } catch (error) { toast(error && error.message || 'GitHub 릴리스 페이지를 열지 못했습니다.'); }
  });
  $('#providerOverview').addEventListener('click', event => {
    const card = event.target.closest('[data-provider-card]');
    if (!card) return;
    state.provider = state.provider === card.dataset.providerCard ? 'all' : card.dataset.providerCard;
    state.visibleLimit = 30;
    $('#providerFilter').value = state.provider;
    renderProviderOverview();
    renderSessions('filter');
  });
  $('#sessionGrid').addEventListener('click', event => {
    const card = event.target.closest('[data-session-id]');
    if (card) openDrawer(card.dataset.sessionId);
  });
  $('#sessionGrid').addEventListener('keydown', event => {
    const card = event.target.closest('[data-session-id]');
    if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDrawer(card.dataset.sessionId); }
  });
  $('#liveSessionGrid').addEventListener('click', event => {
    const tmuxPane = event.target.closest('.live-tmux-pane[data-tmux-type="pane"][data-tmux-id]');
    const tmuxOverview = event.target.closest('.live-tmux-overview-open');
    if (tmuxPane || tmuxOverview) {
      event.stopPropagation();
      if (tmuxPane) state.tmuxFocus = { type: 'pane', id: tmuxPane.dataset.tmuxId };
      selectView('tmux');
      if (tmuxPane) window.LoadToAgentTerminal?.selectTmuxById(tmuxPane.dataset.tmuxId);
      return;
    }
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
    const completedToggle = event.target.closest('[data-subagent-completed-toggle]');
    if (completedToggle) {
      const ownerId = completedToggle.dataset.subagentCompletedToggle;
      if (state.expandedCompletedSubagents.has(ownerId)) state.expandedCompletedSubagents.delete(ownerId);
      else state.expandedCompletedSubagents.add(ownerId);
      renderSessions('expand');
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
    const subagentChat = event.target.closest('[data-open-subagent-chat]');
    if (subagentChat) {
      event.stopPropagation();
      openSubagentConversation(subagentChat.dataset.openSubagentChat);
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
    if (!input || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
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
      window.LoadToAgentTerminal?.selectTmuxById(control.dataset.controlTmux);
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
    if (node.dataset.tmuxType === 'pane') window.LoadToAgentTerminal?.selectTmuxById(node.dataset.tmuxId);
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
      state.workspaces = await window.loadtoagent.removeWorkspace(remove.dataset.removeWorkspace);
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
  $('#addWorkspaceBtn').addEventListener('click', async () => { state.workspaces = await window.loadtoagent.addWorkspaces(); renderWorkspaces(); });
  $('#probeBtn').addEventListener('click', async () => { state.availability = await window.loadtoagent.probeProviders(); render(); toast('AI CLI 연결 상태를 다시 확인했습니다.'); });
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
    syncRunComposer();
  });
  $('#runProviderHelp').addEventListener('click', async event => {
    const docs = event.target.closest('[data-provider-docs]');
    if (docs) {
      const provider = providerInfo(docs.dataset.providerDocs);
      if (provider.docs) await window.loadtoagent.openExternal(provider.docs);
      return;
    }
    if (event.target.closest('[data-provider-recheck]')) {
      state.availability = await window.loadtoagent.probeProviders();
      const installed = state.providers.find(provider => state.availability[provider.id]);
      if (installed) state.runProvider = installed.id;
      $('#runProviderPicker').innerHTML = providerPickerHtml();
      renderProviderRail();
      syncRunComposer();
      toast(installed ? `${installed.label} CLI를 찾았습니다. 이제 작업을 시작할 수 있어요.` : '아직 설치된 AI CLI를 찾지 못했습니다. 설치와 로그인을 확인해 주세요.');
    }
  });
  $('#runPrompt').addEventListener('input', syncRunComposer);
  $('.run-prompt-examples').addEventListener('click', event => {
    const example = event.target.closest('[data-run-prompt-example]');
    if (!example) return;
    const input = $('#runPrompt');
    const text = example.dataset.runPromptExample;
    if (!input.value.trim()) input.value = text;
    else input.setRangeText(`${input.selectionStart ? '\n\n' : ''}${text}`, input.selectionStart, input.selectionEnd, 'end');
    syncRunComposer();
    input.focus();
  });
  $('#runWorkspaceSuggestions').addEventListener('click', event => {
    const workspace = event.target.closest('[data-run-workspace]');
    if (!workspace) return;
    $('#runCwd').value = workspace.dataset.runWorkspace;
    syncRunComposer();
  });
  $('#runCwd').addEventListener('input', syncRunComposer);
  $('#allowWrites').addEventListener('change', syncRunComposer);
  $('#pickRunCwdBtn').addEventListener('click', async () => { const folder = await window.loadtoagent.pickWorkspace(); if (folder) { $('#runCwd').value = folder; syncRunComposer(); } });
  $('#runForm').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      $('#runForm').requestSubmit();
    }
  });
  $('#runForm').addEventListener('submit', handleRun);
  $('#closeDrawerBtn').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('.drawer-tabs').addEventListener('click', event => { const tab = event.target.closest('[data-tab]'); if (tab) { state.drawerTab = tab.dataset.tab; state.drawerForceLatest = tab.dataset.tab === 'chat'; renderDrawer(); } });
  $('.drawer-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = $$('.drawer-tab:not(.hidden)');
    const current = Math.max(0, tabs.indexOf(event.target.closest('.drawer-tab')));
    const next = event.key === 'Home' ? 0 : (event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length);
    event.preventDefault();
    state.drawerTab = tabs[next].dataset.tab;
    state.drawerForceLatest = state.drawerTab === 'chat';
    renderDrawer();
    $(`.drawer-tab[data-tab="${state.drawerTab}"]`)?.focus();
  });
  $('#detailDrawer').addEventListener('click', async event => {
    const resume = event.target.closest('[data-resume-agent]');
    if (resume) { await resumeAgentTerminal(resume.dataset.resumeAgent); return; }
    const retry = event.target.closest('[data-retry-detail]');
    if (retry) { loadSessionDetail(retry.dataset.retryDetail, true); return; }
    const latest = event.target.closest('[data-scroll-latest]');
    if (latest) {
      const content = $('#drawerContent');
      content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
      return;
    }
    const stop = event.target.closest('[data-stop-run]');
    if (!stop) return;
    const runId = stop.dataset.stopRun;
    if (state.stopRequests.has(runId)) return;
    state.stopRequests.add(runId);
    renderDrawer();
    try {
      const result = await window.loadtoagent.stopAgent(runId);
      toast(result.ok ? '중지 요청을 보냈습니다.' : result.error);
    } catch (error) {
      toast(error && error.message || '중지 요청을 보내지 못했습니다.');
    } finally {
      state.stopRequests.delete(runId);
      if (state.selectedId) renderDrawer();
    }
  });
  document.addEventListener('keydown', event => {
    trapDialogFocus(event);
    if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if ($('#runModal').classList.contains('hidden')) openRunModal();
      return;
    }
    if (event.key !== 'Escape') return;
    if (!$('#mobileToolsMenu').classList.contains('hidden')) {
      $('#mobileToolsMenu').classList.add('hidden');
      $('#mobileMoreBtn').setAttribute('aria-expanded', 'false');
      $('#mobileMoreBtn').focus();
    } else if (!$('#runModal').classList.contains('hidden')) closeRunModal(); else closeDrawer();
  });
  window.addEventListener('resize', scheduleAgentWorkflowConnections);
}

async function init() {
  loadGuideState();
  if (!window.loadtoagent) {
    $('#emptyState').classList.remove('hidden');
    $('#emptyState p').textContent = 'LoadToAgent 프로그램에서 열면 이 컴퓨터의 AI 작업 기록을 불러옵니다.';
    return;
  }
  const bootstrap = await window.loadtoagent.bootstrap();
  if (window.loadtoagent.setLocale) await window.loadtoagent.setLocale(window.LoadToAgentI18n?.getLocale() || 'ko');
  state.providers = bootstrap.providers || [];
  state.providerMap = new Map(state.providers.map(provider => [provider.id, provider]));
  state.availability = bootstrap.availability || {};
  state.workspaces = bootstrap.workspaces || [];
  state.snapshot = bootstrap.snapshot;
  state.activeRuns = bootstrap.activeRuns || [];
  state.platform = bootstrap.platform || state.platform;
  state.versions = bootstrap.versions || {};
  state.update = bootstrap.update || { status: 'idle', currentVersion: state.versions.app || '' };
  $('#providerFilter').innerHTML = '<option value="all">모든 AI</option>' + state.providers.map(provider => `<option value="${esc(provider.id)}">${esc(provider.label)}</option>`).join('');
  bindEvents();
  render();
  $('#lastSync').textContent = timeOnly(state.snapshot && state.snapshot.generatedAt);
  window.loadtoagent.onSnapshot(snapshot => {
    state.snapshot = snapshot;
    if (window.LoadToAgentTerminal) window.LoadToAgentTerminal.updateSnapshot(snapshot, state.workspaces);
    $('#lastSync').textContent = timeOnly(snapshot.generatedAt);
    render();
    if (state.selectedId && $('#detailDrawer').classList.contains('open') && !state.detailLoadingIds.has(state.selectedId)) {
      const card = (snapshot.sessions || []).find(session => session.id === state.selectedId);
      const detail = state.details.get(state.selectedId);
      if (card && detail && card.updatedAt !== detail.updatedAt) loadSessionDetail(state.selectedId, true);
    }
  });
  if (window.loadtoagent.onUpdateState) window.loadtoagent.onUpdateState(update => {
    state.update = update;
    renderUpdateSettings();
  });
}

window.addEventListener('loadtoagent:locale-changed', event => {
  if (window.loadtoagent?.setLocale) Promise.resolve(window.loadtoagent.setLocale(event.detail.locale)).catch(() => {});
  if (!state.snapshot) {
    syncViewChrome();
    return;
  }
  render('locale');
  $('#lastSync').textContent = timeOnly(state.snapshot.generatedAt);
});

init().catch(error => {
  console.error(error);
  $('#lastSync').textContent = '연결 실패';
  toast(`초기화 실패: ${error.message}`);
});
