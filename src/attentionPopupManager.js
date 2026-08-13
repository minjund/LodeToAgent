'use strict';

const { pathToFileURL } = require('url');

const POPUP_WIDTH = 340;
const DEFAULT_HEIGHT = 248;
const MIN_HEIGHT = 96;
const WORK_AREA_RATIO = 0.9;
const EDGE_MARGIN = 8;
const STACK_GAP = 6;
const MAX_TEXT_LENGTH = 10_000;
const MAX_SHORT_TEXT_LENGTH = 1_000;
const REQUEST_TYPES = new Set(['permission', 'question', 'terminal-approval', 'input']);
const DISPLAY_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'];

function popupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, fallback = '', limit = MAX_TEXT_LENGTH) {
  const result = String(value == null ? '' : value).trim();
  return (result || fallback).slice(0, limit);
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function requestType(raw) {
  const supplied = text(raw && (raw.type || raw.kind), '', 64).toLowerCase();
  const aliases = {
    approval: 'permission',
    permission: 'permission',
    question: 'question',
    questions: 'question',
    terminal: 'terminal-approval',
    'terminal-prompt': 'terminal-approval',
    'terminal-approval': 'terminal-approval',
    input: 'input',
    'readonly-input': 'input',
  };
  return aliases[supplied] || supplied;
}

function normalizeOption(option, index) {
  const raw = option && typeof option === 'object' ? option : { label: option, value: option };
  const label = text(raw.label || raw.title || raw.value || raw.id, `선택 ${index + 1}`, MAX_SHORT_TEXT_LENGTH);
  const value = text(raw.value || raw.id || raw.key || label, `option-${index + 1}`, MAX_SHORT_TEXT_LENGTH);
  const id = text(raw.id || raw.key || value, `option-${index + 1}`, MAX_SHORT_TEXT_LENGTH);
  const explicitOther = raw.isOther === true || raw.other === true;
  return {
    id,
    value,
    label,
    description: text(raw.description || raw.detail, '', MAX_SHORT_TEXT_LENGTH),
    isOther: explicitOther || /^(?:other|기타|직접 입력|其他)(?:\b|\s|$)/i.test(label),
  };
}

function normalizeQuestion(question, index) {
  const raw = question && typeof question === 'object' ? question : { question };
  const id = text(raw.id || raw.questionId || raw.header, `question-${index + 1}`, MAX_SHORT_TEXT_LENGTH);
  const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 100).map(normalizeOption);
  const hasOtherOption = options.some(option => option.isOther);
  return {
    id,
    header: text(raw.header, '', MAX_SHORT_TEXT_LENGTH),
    question: text(raw.question || raw.label || raw.prompt, `질문 ${index + 1}`, MAX_TEXT_LENGTH),
    description: text(raw.description || raw.detail, '', MAX_TEXT_LENGTH),
    multiple: Boolean(raw.multiple || raw.multiSelect),
    required: raw.required !== false,
    options,
    allowOther: Boolean(raw.allowOther || raw.other || hasOtherOption),
    placeholder: text(raw.placeholder, '답변을 입력하세요.', MAX_SHORT_TEXT_LENGTH),
  };
}

function normalizeChoice(choice, index) {
  const raw = choice && typeof choice === 'object' ? choice : { label: choice, id: choice };
  const label = text(raw.label || raw.title || raw.value || raw.id || raw.key, `선택 ${index + 1}`, MAX_SHORT_TEXT_LENGTH);
  return {
    id: text(raw.id || raw.key || raw.value || label, `choice-${index + 1}`, MAX_SHORT_TEXT_LENGTH),
    label,
    description: text(raw.description || raw.detail, '', MAX_SHORT_TEXT_LENGTH),
    tone: ['allow', 'deny', 'primary', 'neutral'].includes(raw.tone) ? raw.tone : 'neutral',
  };
}

function normalizePermissionSuggestion(suggestion, index) {
  const raw = suggestion && typeof suggestion === 'object'
    ? suggestion
    : { label: suggestion, id: suggestion };
  const label = text(
    raw.label || raw.title || raw.description || raw.id,
    `항상 허용 ${index + 1}`,
    MAX_SHORT_TEXT_LENGTH,
  );
  return {
    id: text(raw.id || raw.key, `permission-suggestion-${index + 1}`, MAX_SHORT_TEXT_LENGTH),
    label,
    description: text(raw.description || raw.detail, '', MAX_SHORT_TEXT_LENGTH),
  };
}

function normalizeRequest(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') throw popupError('ATTENTION_POPUP_INVALID_REQUEST', 'Popup request must be an object.');
  const id = text(raw.id || raw.requestId || fallbackId, '', MAX_SHORT_TEXT_LENGTH);
  if (!id) throw popupError('ATTENTION_POPUP_INVALID_REQUEST', 'Popup request id is required.');
  const type = requestType(raw);
  if (!REQUEST_TYPES.has(type)) throw popupError('ATTENTION_POPUP_INVALID_REQUEST', `Unsupported popup request type: ${type || '(empty)'}`);

  const questions = type === 'question'
    ? (Array.isArray(raw.questions) && raw.questions.length ? raw.questions : [raw]).slice(0, 50).map(normalizeQuestion)
    : [];
  const suppliedChoices = Array.isArray(raw.choices) ? raw.choices : Array.isArray(raw.options) ? raw.options : [];
  const choices = type === 'terminal-approval' ? suppliedChoices.slice(0, 100).map(normalizeChoice) : [];
  const permissionSuggestions = type === 'permission' && Array.isArray(raw.permissionSuggestions)
    ? raw.permissionSuggestions.slice(0, 20).map(normalizePermissionSuggestion)
    : [];
  if (type === 'question' && !questions.length) throw popupError('ATTENTION_POPUP_INVALID_REQUEST', 'Question popup requires at least one question.');
  if (type === 'terminal-approval' && !choices.length) throw popupError('ATTENTION_POPUP_INVALID_REQUEST', 'Terminal approval popup requires at least one choice.');

  return {
    id,
    type,
    locale: ['ko', 'en', 'zh-CN'].includes(raw.locale) ? raw.locale : 'ko',
    title: text(raw.title, type === 'permission' ? '권한 요청' : type === 'question' ? '질문' : type === 'terminal-approval' ? '터미널 확인' : '입력 필요', MAX_SHORT_TEXT_LENGTH),
    body: text(raw.body || raw.message || raw.summary || raw.question, '', MAX_TEXT_LENGTH),
    detail: text(raw.detail || raw.description, '', MAX_TEXT_LENGTH),
    provider: text(raw.provider, '', 80),
    project: text(raw.project || raw.projectName, '', MAX_SHORT_TEXT_LENGTH),
    meta: text(raw.meta || raw.sessionMeta, '', MAX_SHORT_TEXT_LENGTH),
    toolLabel: text(raw.toolLabel || raw.toolName, '', 100),
    sessionId: text(raw.sessionId, '', MAX_SHORT_TEXT_LENGTH),
    terminalId: text(raw.terminalId, '', MAX_SHORT_TEXT_LENGTH),
    requestId: text(raw.requestId || id, id, MAX_SHORT_TEXT_LENGTH),
    createdAt: text(raw.createdAt || raw.requestedAt, '', 80),
    allowLabel: text(raw.allowLabel, '허용', 100),
    denyLabel: text(raw.denyLabel, '거부', 100),
    submitLabel: text(raw.submitLabel, '답변 보내기', 100),
    openMainLabel: text(raw.openMainLabel, 'LoadToAgent에서 열기', 100),
    canDeny: type === 'question' && raw.canDeny === true,
    questions,
    choices,
    permissionSuggestions,
    dismissible: raw.dismissible !== false,
    openMain: type === 'input' ? raw.openMain !== false : Boolean(raw.openMain),
    closeOnOpenMain: raw.closeOnOpenMain !== false,
    initialHeight: boundedNumber(raw.initialHeight, DEFAULT_HEIGHT, MIN_HEIGHT, 4_000),
    displayId: raw.displayId == null ? null : String(raw.displayId),
    anchorPoint: raw.anchorPoint && Number.isFinite(Number(raw.anchorPoint.x)) && Number.isFinite(Number(raw.anchorPoint.y))
      ? { x: Math.round(Number(raw.anchorPoint.x)), y: Math.round(Number(raw.anchorPoint.y)) }
      : null,
  };
}

function hasAlwaysVisibleTextInput(request) {
  return request.type === 'question' && request.questions.some(question => !question.options.length);
}

function canonicalQuestionDecision(request, supplied) {
  if (!supplied || supplied.action !== 'answer' || !Array.isArray(supplied.answers)) {
    throw popupError('ATTENTION_POPUP_INVALID_DECISION', 'Question response must contain an answers array.');
  }
  const suppliedById = new Map();
  for (const answer of supplied.answers) {
    const questionId = text(answer && answer.questionId, '', MAX_SHORT_TEXT_LENGTH);
    if (!questionId || suppliedById.has(questionId)) throw popupError('ATTENTION_POPUP_INVALID_DECISION', 'Question responses must have unique question ids.');
    suppliedById.set(questionId, answer || {});
  }
  if ([...suppliedById.keys()].some(id => !request.questions.some(question => question.id === id))) {
    throw popupError('ATTENTION_POPUP_INVALID_DECISION', 'Question response contains an unknown question id.');
  }

  const answers = request.questions.map(question => {
    const answer = suppliedById.get(question.id) || {};
    if (!question.options.length) {
      const answerText = text(answer.text, '', MAX_TEXT_LENGTH);
      if (question.required && !answerText) throw popupError('ATTENTION_POPUP_INCOMPLETE_DECISION', `An answer is required for ${question.id}.`);
      return { questionId: question.id, values: [], otherText: '', text: answerText };
    }

    const allowed = new Set(question.options.map(option => option.value));
    const values = [...new Set((Array.isArray(answer.values) ? answer.values : [])
      .map(value => text(value, '', MAX_SHORT_TEXT_LENGTH)).filter(Boolean))];
    if (values.some(value => !allowed.has(value))) throw popupError('ATTENTION_POPUP_INVALID_DECISION', `Unknown choice for ${question.id}.`);
    if (!question.multiple && values.length > 1) throw popupError('ATTENTION_POPUP_INVALID_DECISION', `${question.id} accepts only one choice.`);
    const selectedOther = values.some(value => question.options.some(option => option.value === value && option.isOther));
    const otherText = text(answer.otherText, '', MAX_TEXT_LENGTH);
    if (otherText && !question.allowOther) throw popupError('ATTENTION_POPUP_INVALID_DECISION', `${question.id} does not allow another answer.`);
    if (selectedOther && !otherText) throw popupError('ATTENTION_POPUP_INCOMPLETE_DECISION', `Other answer text is required for ${question.id}.`);
    if (question.required && !values.length && !otherText) throw popupError('ATTENTION_POPUP_INCOMPLETE_DECISION', `An answer is required for ${question.id}.`);
    return { questionId: question.id, values, otherText, text: '' };
  });
  return { action: 'answer', answers };
}

function canonicalDecision(request, supplied) {
  const decision = supplied && typeof supplied === 'object' ? supplied : {};
  if (request.type === 'permission') {
    if (['allow', 'deny'].includes(decision.action)) return { action: decision.action };
    const suggestionId = text(decision.suggestionId, '', MAX_SHORT_TEXT_LENGTH);
    if (decision.action === 'suggestion'
      && suggestionId
      && request.permissionSuggestions.some(suggestion => suggestion.id === suggestionId)) {
      return { action: 'suggestion', suggestionId };
    }
    throw popupError('ATTENTION_POPUP_INVALID_DECISION', 'Permission response must allow, deny, or select an available permission suggestion.');
  }
  if (request.type === 'terminal-approval') {
    const choiceId = text(decision.choiceId, '', MAX_SHORT_TEXT_LENGTH);
    if (decision.action !== 'choice' || !request.choices.some(choice => choice.id === choiceId)) {
      throw popupError('ATTENTION_POPUP_INVALID_DECISION', 'Terminal response must select an available choice.');
    }
    return { action: 'choice', choiceId };
  }
  if (request.type === 'question') {
    if (decision.action === 'deny' && request.canDeny) return { action: 'deny' };
    return canonicalQuestionDecision(request, decision);
  }
  throw popupError('ATTENTION_POPUP_READ_ONLY', 'This request can only be opened in LoadToAgent.');
}

function callbackFailure(result) {
  if (result === false) return 'The response was not accepted.';
  if (result && typeof result === 'object' && result.ok === false) return text(result.error || result.message, 'The response was not accepted.');
  return '';
}

class AttentionPopupManager {
  constructor(options = {}) {
    if (typeof options.BrowserWindow !== 'function') throw new TypeError('BrowserWindow is required.');
    if (!options.screen || typeof options.screen.getPrimaryDisplay !== 'function') throw new TypeError('screen is required.');
    if (!options.preloadPath || !options.htmlPath) throw new TypeError('preloadPath and htmlPath are required.');
    this.BrowserWindow = options.BrowserWindow;
    this.screen = options.screen;
    this.preloadPath = options.preloadPath;
    this.htmlPath = options.htmlPath;
    this.allowedUrl = pathToFileURL(options.htmlPath).href;
    this.onDecide = typeof options.onDecide === 'function' ? options.onDecide : async () => {};
    this.onDismiss = typeof options.onDismiss === 'function' ? options.onDismiss : null;
    this.onOpenMain = typeof options.onOpenMain === 'function' ? options.onOpenMain : async () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.enabled = Boolean(options.enabled);
    this.disposed = false;
    this.sequence = 0;
    this.desired = new Map();
    this.windows = new Map();
    this.suppressed = new Map();
    this.lastError = null;
    this.reflowBound = () => this.reflow();
    if (typeof this.screen.on === 'function') {
      for (const event of DISPLAY_EVENTS) this.screen.on(event, this.reflowBound);
    }
  }

  key(source, id) {
    return `${text(source, 'default', 200)}\u0000${text(id, '', MAX_SHORT_TEXT_LENGTH)}`;
  }

  callbackContext(record) {
    return { source: record.source, key: record.key, context: record.context };
  }

  report(error, phase, record = null) {
    this.lastError = { phase, message: String(error && error.message || error), code: String(error && error.code || '') };
    try { this.onError(error, { phase, key: record && record.key, request: record && record.request }); } catch {}
  }

  recordFor(raw, source, previous = null) {
    const request = normalizeRequest(raw);
    const revision = JSON.stringify(request);
    const createdTimestamp = Date.parse(request.createdAt || '');
    return {
      key: this.key(source, request.id),
      source,
      request,
      context: raw.context,
      revision,
      order: previous ? previous.order : ++this.sequence,
      createdTimestamp: Number.isFinite(createdTimestamp) ? createdTimestamp : (previous ? previous.createdTimestamp : 0),
    };
  }

  setEnabled(enabled) {
    if (this.disposed) return this.snapshot();
    const next = Boolean(enabled);
    if (this.enabled === next) return this.snapshot();
    this.enabled = next;
    if (!next) {
      for (const entry of [...this.windows.values()]) {
        this.notifyDismiss(entry.record, 'disabled', true);
        this.closeEntry(entry);
      }
    } else {
      this.syncWindows();
    }
    return this.snapshot();
  }

  reconcile(sourceOrRequests, maybeRequests) {
    if (this.disposed) return this.snapshot();
    const source = Array.isArray(sourceOrRequests) || sourceOrRequests == null ? 'default' : text(sourceOrRequests, 'default', 200);
    const requests = Array.isArray(sourceOrRequests) ? sourceOrRequests : Array.isArray(maybeRequests) ? maybeRequests : [];
    const incoming = new Map();
    for (const raw of requests) {
      const provisionalId = text(raw && (raw.id || raw.requestId), '', MAX_SHORT_TEXT_LENGTH);
      const provisionalKey = provisionalId ? this.key(source, provisionalId) : '';
      const previous = provisionalKey ? this.desired.get(provisionalKey) : null;
      const record = this.recordFor(raw, source, previous);
      incoming.set(record.key, record);
    }

    for (const [key, record] of [...this.desired]) {
      if (record.source !== source || incoming.has(key)) continue;
      this.desired.delete(key);
      this.suppressed.delete(key);
      const entry = this.windows.get(key);
      if (entry) this.closeEntry(entry);
    }
    for (const record of incoming.values()) this.applyRecord(record);
    this.syncWindows();
    return this.snapshot();
  }

  upsert(raw, source = 'default') {
    if (this.disposed) return this.snapshot();
    const normalizedSource = text(source, 'default', 200);
    const provisionalId = text(raw && (raw.id || raw.requestId), '', MAX_SHORT_TEXT_LENGTH);
    const previous = provisionalId ? this.desired.get(this.key(normalizedSource, provisionalId)) : null;
    const record = this.recordFor(raw, normalizedSource, previous);
    this.applyRecord(record);
    this.syncWindows();
    return this.snapshot();
  }

  applyRecord(record) {
    const previous = this.desired.get(record.key);
    this.desired.set(record.key, record);
    if (this.suppressed.get(record.key) && this.suppressed.get(record.key) !== record.revision) this.suppressed.delete(record.key);
    const entry = this.windows.get(record.key);
    if (!entry) return;
    entry.record = record;
    entry.baseHasTextInput = hasAlwaysVisibleTextInput(record.request);
    if (!previous || previous.revision !== record.revision) {
      this.send(entry, 'attention-popup:request', record.request);
      entry.height = boundedNumber(record.request.initialHeight, entry.height, MIN_HEIGHT, 4_000);
      this.reflow();
    }
  }

  remove(sourceOrId, maybeId) {
    const source = maybeId == null ? 'default' : text(sourceOrId, 'default', 200);
    const id = maybeId == null ? text(sourceOrId, '', MAX_SHORT_TEXT_LENGTH) : text(maybeId, '', MAX_SHORT_TEXT_LENGTH);
    const key = this.key(source, id);
    this.desired.delete(key);
    this.suppressed.delete(key);
    const entry = this.windows.get(key);
    if (entry) this.closeEntry(entry);
    return this.snapshot();
  }

  syncWindows() {
    if (!this.enabled || this.disposed) return;
    for (const record of this.sortedRecords()) {
      if (this.suppressed.get(record.key) === record.revision || this.windows.has(record.key)) continue;
      try { this.createEntry(record); } catch (error) { this.report(error, 'create-window', record); }
    }
    this.reflow();
  }

  sortedRecords() {
    return [...this.desired.values()].sort((left, right) => {
      if (left.createdTimestamp && right.createdTimestamp && left.createdTimestamp !== right.createdTimestamp) {
        return left.createdTimestamp - right.createdTimestamp;
      }
      return left.order - right.order;
    });
  }

  windowOptions(record) {
    const display = this.displayFor(record.request);
    const workArea = display.workArea;
    const width = Math.max(1, Math.min(POPUP_WIDTH, Math.floor(workArea.width * WORK_AREA_RATIO)));
    const maxHeight = Math.max(1, Math.floor(workArea.height * WORK_AREA_RATIO));
    const height = Math.min(record.request.initialHeight, maxHeight);
    return {
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    };
  }

  createEntry(record) {
    const options = this.windowOptions(record);
    const win = new this.BrowserWindow(options);
    const entry = {
      key: record.key,
      record,
      window: win,
      width: options.width,
      height: options.height,
      baseHasTextInput: hasAlwaysVisibleTextInput(record.request),
      hasTextInput: hasAlwaysVisibleTextInput(record.request),
      ready: false,
      presented: false,
      busy: false,
      closing: false,
      failureHandled: false,
      pendingFailure: null,
    };
    this.windows.set(record.key, entry);
    if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(true, 'floating');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof win.setMenuBarVisibility === 'function') win.setMenuBarVisibility(false);
    if (win.webContents && typeof win.webContents.setWindowOpenHandler === 'function') {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    if (win.webContents && typeof win.webContents.on === 'function') {
      win.webContents.on('will-navigate', (event, url) => {
        if (url !== this.allowedUrl && event && typeof event.preventDefault === 'function') event.preventDefault();
      });
      win.webContents.on('render-process-gone', (_event, details) => {
        this.failEntry(
          entry,
          popupError('ATTENTION_POPUP_RENDERER_GONE', `Popup renderer exited: ${details && details.reason || 'unknown'}`),
          'renderer-gone',
        );
      });
    }
    if (typeof win.on === 'function') {
      win.on('closed', () => {
        if (!entry.closing) {
          this.failEntry(
            entry,
            popupError('ATTENTION_POPUP_WINDOW_CLOSED', 'Popup window closed before the request was resolved.'),
            'window-closed',
          );
          return;
        }
        if (this.windows.get(entry.key) === entry) this.windows.delete(entry.key);
      });
    }
    let load;
    try { load = win.loadFile(this.htmlPath); } catch (error) {
      this.failEntry(entry, error, 'load-file');
      return entry;
    }
    if (load && typeof load.catch === 'function') {
      load.catch(error => {
        this.failEntry(entry, error, 'load-file');
      });
    }
    return entry;
  }

  isAlive(entry) {
    if (!entry || !entry.window || entry.closing) return false;
    return typeof entry.window.isDestroyed !== 'function' || !entry.window.isDestroyed();
  }

  closeEntry(entry) {
    if (!entry || entry.closing) return;
    entry.closing = true;
    if (this.windows.get(entry.key) === entry) this.windows.delete(entry.key);
    try {
      if (typeof entry.window.isDestroyed !== 'function' || !entry.window.isDestroyed()) entry.window.close();
    } catch (error) { this.report(error, 'close-window', entry.record); }
  }

  failEntry(entry, error, phase) {
    if (!entry || entry.closing || entry.failureHandled) return false;
    if (entry.busy) {
      if (!entry.pendingFailure) {
        entry.pendingFailure = { error, phase, reported: true };
        this.report(error, phase, entry.record);
      }
      return false;
    }
    const pendingFailure = entry.pendingFailure;
    entry.pendingFailure = null;
    entry.failureHandled = true;
    if (!pendingFailure?.reported) this.report(error, phase, entry.record);
    this.suppressed.set(entry.key, entry.record.revision);
    this.notifyDismiss(entry.record, 'failure', false);
    this.closeEntry(entry);
    this.reflow();
    return true;
  }

  flushPendingFailure(entry) {
    if (!entry || entry.busy || entry.closing || entry.failureHandled || !entry.pendingFailure) return false;
    const pendingFailure = entry.pendingFailure;
    return this.failEntry(entry, pendingFailure.error, pendingFailure.phase);
  }

  displayFor(request, entry = null) {
    let displays = [];
    try { displays = typeof this.screen.getAllDisplays === 'function' ? this.screen.getAllDisplays() : []; } catch {}
    if (request.displayId != null) {
      const selected = displays.find(display => String(display.id) === String(request.displayId));
      if (selected) return selected;
    }
    if (request.anchorPoint && typeof this.screen.getDisplayNearestPoint === 'function') {
      try { return this.screen.getDisplayNearestPoint(request.anchorPoint); } catch {}
    }
    if (entry && entry.window && typeof entry.window.getBounds === 'function' && typeof this.screen.getDisplayMatching === 'function') {
      try { return this.screen.getDisplayMatching(entry.window.getBounds()); } catch {}
    }
    return this.screen.getPrimaryDisplay();
  }

  reflow() {
    if (!this.enabled || this.disposed) return this.snapshot();
    const groups = new Map();
    for (const record of this.sortedRecords()) {
      const entry = this.windows.get(record.key);
      if (!this.isAlive(entry)) continue;
      const display = this.displayFor(record.request, entry);
      const displayKey = String(display.id == null ? 'primary' : display.id);
      if (!groups.has(displayKey)) groups.set(displayKey, { display, entries: [] });
      groups.get(displayKey).entries.push(entry);
    }

    for (const { display, entries } of groups.values()) {
      const workArea = display.workArea;
      const maxWidth = Math.max(1, Math.floor(workArea.width * WORK_AREA_RATIO));
      const maxHeight = Math.max(1, Math.floor(workArea.height * WORK_AREA_RATIO));
      let cursor = workArea.y + workArea.height - EDGE_MARGIN;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        const width = Math.min(POPUP_WIDTH, maxWidth);
        const height = Math.min(Math.max(MIN_HEIGHT, entry.height), maxHeight);
        cursor -= height;
        const bounds = {
          x: Math.round(workArea.x + workArea.width - EDGE_MARGIN - width),
          y: Math.round(Math.max(workArea.y, cursor)),
          width: Math.round(width),
          height: Math.round(height),
        };
        try { entry.window.setBounds(bounds, false); } catch (error) { this.report(error, 'set-bounds', entry.record); }
        entry.width = width;
        cursor -= STACK_GAP;
      }
    }
    return this.snapshot();
  }

  present(entry, force = false) {
    if (!this.enabled || !this.isAlive(entry) || (!force && entry.presented)) return;
    try {
      if (entry.hasTextInput) {
        entry.window.show();
        if (typeof entry.window.focus === 'function') entry.window.focus();
      } else if (typeof entry.window.showInactive === 'function') {
        entry.window.showInactive();
      } else {
        entry.window.show();
      }
      entry.presented = true;
    } catch (error) { this.report(error, 'show-window', entry.record); }
  }

  validateSender(event) {
    const sender = event && event.sender;
    if (!sender) return null;
    for (const entry of this.windows.values()) {
      if (!this.isAlive(entry) || entry.window.webContents !== sender) continue;
      try {
        if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return null;
        const currentUrl = typeof sender.getURL === 'function' ? sender.getURL() : '';
        const frameUrl = event.senderFrame && event.senderFrame.url;
        if (currentUrl !== this.allowedUrl || (frameUrl && frameUrl !== this.allowedUrl)) return null;
      } catch {
        return null;
      }
      return entry;
    }
    return null;
  }

  requireSender(event) {
    const entry = this.validateSender(event);
    if (!entry) throw popupError('ATTENTION_POPUP_UNAUTHORIZED', 'The IPC sender is not an active attention popup.');
    return entry;
  }

  handleReady(event, payload = {}) {
    const entry = this.requireSender(event);
    entry.ready = true;
    entry.hasTextInput = entry.baseHasTextInput || payload.hasTextInput === true;
    this.reflow();
    this.present(entry);
    return { ok: true, request: entry.record.request };
  }

  handleResize(event, payload = {}) {
    const entry = this.validateSender(event);
    if (!entry) return {
      ok: false,
      error: { code: 'ATTENTION_POPUP_STALE', message: 'This popup is no longer active.' },
    };
    const display = this.displayFor(entry.record.request, entry);
    const maxHeight = Math.max(1, Math.floor(display.workArea.height * WORK_AREA_RATIO));
    entry.height = boundedNumber(payload.height, entry.height, Math.min(MIN_HEIGHT, maxHeight), maxHeight);
    const previousInput = entry.hasTextInput;
    entry.hasTextInput = entry.baseHasTextInput || payload.hasTextInput === true;
    this.reflow();
    this.present(entry, !previousInput && entry.hasTextInput);
    return { ok: true, bounds: typeof entry.window.getBounds === 'function' ? entry.window.getBounds() : null };
  }

  async handleDecide(event, supplied) {
    const entry = this.requireSender(event);
    if (entry.busy) return { ok: false, error: { code: 'ATTENTION_POPUP_BUSY', message: 'A response is already being sent.' } };
    const record = entry.record;
    let decision;
    try { decision = canonicalDecision(record.request, supplied); } catch (error) {
      return this.actionFailure(entry, error, 'validate-decision');
    }
    entry.busy = true;
    try {
      const result = await this.onDecide(record.request, decision, this.callbackContext(record));
      const failure = callbackFailure(result);
      if (failure) throw popupError('ATTENTION_POPUP_DECISION_REJECTED', failure);
      this.suppressAndClose(entry, record);
      return { ok: true };
    } catch (error) {
      return this.actionFailure(entry, error, 'decide');
    } finally {
      entry.busy = false;
      this.flushPendingFailure(entry);
    }
  }

  async handleDismiss(event) {
    const entry = this.requireSender(event);
    const record = entry.record;
    if (!record.request.dismissible) {
      return this.actionFailure(entry, popupError('ATTENTION_POPUP_NOT_DISMISSIBLE', 'This request cannot be dismissed.'), 'dismiss');
    }
    if (entry.busy) return { ok: false, error: { code: 'ATTENTION_POPUP_BUSY', message: 'A response is already being sent.' } };
    entry.busy = true;
    try {
      if (this.onDismiss) {
        const meta = { reason: 'user', decision: null, willRestore: false };
        const result = await this.onDismiss(record.request, meta, this.callbackContext(record));
        const failure = callbackFailure(result);
        if (failure) throw popupError('ATTENTION_POPUP_DISMISS_REJECTED', failure);
      }
      this.suppressAndClose(entry, record);
      return { ok: true };
    } catch (error) {
      return this.actionFailure(entry, error, 'dismiss');
    } finally {
      entry.busy = false;
      this.flushPendingFailure(entry);
    }
  }

  async handleOpenMain(event) {
    const entry = this.requireSender(event);
    const record = entry.record;
    if (!record.request.openMain) {
      return this.actionFailure(entry, popupError('ATTENTION_POPUP_OPEN_MAIN_UNAVAILABLE', 'This request cannot be opened in the main window.'), 'open-main');
    }
    if (entry.busy) return { ok: false, error: { code: 'ATTENTION_POPUP_BUSY', message: 'A response is already being sent.' } };
    entry.busy = true;
    try {
      const result = await this.onOpenMain(record.request, this.callbackContext(record));
      const failure = callbackFailure(result);
      if (failure) throw popupError('ATTENTION_POPUP_OPEN_MAIN_REJECTED', failure);
      if (record.request.closeOnOpenMain) this.suppressAndClose(entry, record);
      return { ok: true };
    } catch (error) {
      return this.actionFailure(entry, error, 'open-main');
    } finally {
      entry.busy = false;
      this.flushPendingFailure(entry);
    }
  }

  suppressAndClose(entry, expectedRecord = entry && entry.record) {
    if (!entry || !expectedRecord || entry.record.revision !== expectedRecord.revision) return false;
    const desired = this.desired.get(entry.key);
    if (desired && desired.revision === expectedRecord.revision) {
      this.suppressed.set(entry.key, expectedRecord.revision);
    }
    this.closeEntry(entry);
    this.reflow();
    return true;
  }

  notifyDismiss(record, reason, willRestore) {
    if (!this.onDismiss) return;
    Promise.resolve().then(() => this.onDismiss(
      record.request,
      { reason, decision: null, willRestore: Boolean(willRestore) },
      this.callbackContext(record),
    )).catch(error => this.report(error, `dismiss-${reason}`, record));
  }

  actionFailure(entry, error, phase) {
    this.report(error, phase, entry.record);
    const response = {
      ok: false,
      error: {
        code: String(error && error.code || 'ATTENTION_POPUP_ACTION_FAILED'),
        message: text(error && error.message, '요청을 처리하지 못했습니다.', MAX_SHORT_TEXT_LENGTH),
      },
    };
    this.send(entry, 'attention-popup:error', response.error);
    return response;
  }

  send(entry, channel, payload) {
    if (!entry.ready || !this.isAlive(entry)) return false;
    try {
      entry.window.webContents.send(channel, payload);
      return true;
    } catch (error) {
      this.report(error, 'send-renderer', entry.record);
      return false;
    }
  }

  snapshot() {
    return {
      enabled: this.enabled,
      disposed: this.disposed,
      requestCount: this.desired.size,
      windowCount: this.windows.size,
      suppressedCount: this.suppressed.size,
      requests: this.sortedRecords().map(record => ({
        key: record.key,
        source: record.source,
        id: record.request.id,
        type: record.request.type,
        visible: this.windows.has(record.key),
        suppressed: this.suppressed.get(record.key) === record.revision,
      })),
      lastError: this.lastError,
    };
  }

  status() {
    return this.snapshot();
  }

  dispose() {
    if (this.disposed) return;
    for (const entry of [...this.windows.values()]) {
      this.notifyDismiss(entry.record, 'dispose', false);
      this.closeEntry(entry);
    }
    if (typeof this.screen.removeListener === 'function') {
      for (const event of DISPLAY_EVENTS) this.screen.removeListener(event, this.reflowBound);
    }
    this.desired.clear();
    this.suppressed.clear();
    this.enabled = false;
    this.disposed = true;
  }
}

module.exports = {
  AttentionPopupManager,
  canonicalDecision,
  hasAlwaysVisibleTextInput,
  normalizeRequest,
  POPUP_WIDTH,
  DEFAULT_HEIGHT,
  MIN_HEIGHT,
  EDGE_MARGIN,
  STACK_GAP,
};
