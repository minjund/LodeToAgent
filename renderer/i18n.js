'use strict';

(() => {
  const STORAGE_KEY = 'loadtoagent:locale:v1';
  const SUPPORTED_LOCALES = Object.freeze(['ko', 'en', 'zh-CN']);
  const SUPPORTED = new Set(SUPPORTED_LOCALES);
  const LOCALE_TAGS = Object.freeze({ ko: 'ko-KR', en: 'en-US', 'zh-CN': 'zh-CN' });
  const TRANSLATED_ATTRIBUTES = Object.freeze(['aria-label', 'placeholder', 'title']);
  const OBSERVED_MESSAGE_KEYS = Object.freeze({
    '활동': 'observed.activity',
    '제목을 불러오는 중': 'observed.loading_title',
    '로컬 세션': 'observed.local_session',
    '표시할 대화 메시지가 아직 없습니다.': 'observed.no_messages_yet',
    'LoadToAgent 실행': 'observed.loadtoagent_run',
    '작업 폴더 미상': 'workspace.unknown',
    '외부 환경': 'observed.external_environment',
    '프로젝트 없음': 'ui.no_project',
    'CLI 시작 중': 'observed.cli_starting',
    '실행 준비': 'observed.preparing_run',
    '에이전트 루프 실행 중': 'observed.agent_loop_running',
    '세션 시작': 'observed.session_started',
    '응답 스트리밍 중': 'observed.response_streaming',
    '도구 실행': 'observed.tool_running',
    '실행 실패': 'observed.run_failed',
    '작업 완료': 'observed.task_completed',
    '세션 완료': 'observed.session_completed',
    '스레드 시작': 'observed.thread_started',
    '턴 실행 중': 'observed.turn_running',
    '턴 시작': 'observed.turn_started',
    '추론': 'observed.reasoning',
    '작업 항목': 'observed.work_item',
    '턴 완료': 'observed.turn_completed',
    '요청 처리 중': 'observed.request_processing',
    '도구 완료': 'observed.tool_completed',
    '경고 또는 오류': 'observed.warning_or_error',
    '세션 실행 중': 'observed.session_running',
    '구조화 이벤트 연결됨': 'observed.structured_events_connected',
    'CLI 프로세스 시작': 'observed.cli_process_started',
    '프로세스 오류': 'observed.process_error',
    '사용자가 중지함': 'observed.stopped_by_user',
    '프로세스 완료': 'observed.process_completed',
    '프로세스 중지': 'observed.process_stopped',
    '프로세스 실패': 'observed.process_failed',
    'CLI 상태': 'observed.cli_status',
    '중지 요청 중': 'observed.stop_requested',
    '프로세스 감지': 'observed.process_detected',
    'AI CLI 프로세스 감지': 'observed.ai_cli_detected',
    'LoadToAgent 외부 터미널 브리지': 'observed.external_bridge',
    '도구 실패': 'observed.tool_failed',
    'Claude 데스크톱 앱': 'observed.claude_desktop',
    '응답 생성 중': 'observed.generating_response',
    '도구 실행 또는 스트리밍 중': 'observed.tool_or_streaming',
    '응답 또는 권한 확인 필요': 'observed.response_or_permission_needed',
    '마지막 응답 기록이 종료됨': 'observed.last_response_ended',
    '다음 요청 대기': 'observed.waiting_for_request',
    'Codex 데스크톱 앱': 'observed.codex_desktop',
    '서브에이전트 실행 시작': 'observed.subagent_started',
    '서브에이전트 상태 변경': 'observed.subagent_status_changed',
    '판단 중': 'observed.deciding',
    '다음 작업을 판단하고 결과를 정리하는 중': 'observed.deciding_next',
    '메인 AI 작업 지시': 'observed.main_assignment',
    '새 작업 배정': 'observed.new_assignment',
    '추가 작업 지시': 'observed.followup_assignment',
    '메시지 전달': 'observed.message_delivery',
    '작업 중단 요청': 'observed.interrupt_requested',
    '결과 반환': 'observed.result_returned',
    '작업 전달': 'observed.assignment_delivered',
    '에이전트 메시지': 'observed.agent_message',
    '오류 발생': 'observed.error_occurred',
    '실시간 이벤트 수신 중': 'observed.receiving_events',
    '서브에이전트 작업': 'observed.subagent_work',
    '작업 완료 기록': 'observed.completion_record',
    '실행 시작 관측': 'observed.start_observed',
    '상태 기록만 확인됨': 'observed.status_only',
    'Codex 협업 이벤트': 'observed.codex_collaboration',
    '작업 배정 확인': 'observed.assignment_confirmed',
    '결과 반환 확인': 'observed.result_confirmed',
    '확인 중': 'observed.checking',
    '연결됨': 'observed.connected',
    'tmux 설치됨 · 실행 세션 없음': 'observed.tmux_no_sessions',
    'tmux 미설치 또는 서버 없음': 'observed.tmux_unavailable',
    'WSL 배포판 없음': 'observed.no_wsl_distro',
    '로컬 환경 없음': 'observed.no_local_environment',
  });
  const messages = window.LoadToAgentMessages || {};
  let locale = readLocale();

  function readLocale() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED.has(saved) ? saved : 'ko';
    } catch (error) {
      window.LoadToAgentRendererUtils?.reportRecoverableError('locale-storage-read', error);
      return 'ko';
    }
  }

  function interpolate(template, params = {}) {
    return String(template).replace(/\{([a-zA-Z][\w]*)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  }

  /** Resolve a stable message key for the active locale. */
  function t(key, params) {
    const message = messages[key];
    if (!message) return String(key ?? '');
    return interpolate(message[locale] ?? message.ko ?? key, params);
  }

  /** Keep useful native errors, but never leak Korean backend copy into another locale. */
  function errorText(error, fallbackKey, params) {
    const message = String(error?.message || error || '').trim();
    if (message && (locale === 'ko' || !/[가-힣]/.test(message))) return message;
    return t(fallbackKey, params);
  }

  /** Translate only known app-generated observation copy; user-authored text stays unchanged. */
  function observedText(value) {
    const text = String(value ?? '');
    const key = OBSERVED_MESSAGE_KEYS[text];
    if (key) return t(key);
    let match = text.match(/^(tmux에서 AI 프로세스 실행 중|안전하게 연결된 외부 터미널|AI CLI 프로세스 실행 중) · PID (\d+)$/);
    if (match) {
      const prefixKeys = {
        'tmux에서 AI 프로세스 실행 중': 'observed.tmux_ai_running',
        '안전하게 연결된 외부 터미널': 'observed.external_terminal_connected',
        'AI CLI 프로세스 실행 중': 'observed.ai_cli_running',
      };
      return t('observed.pid_status', { status: t(prefixKeys[match[1]]), pid: match[2] });
    }
    match = text.match(/^CLI 종료 코드 (\d+)(.*)$/);
    if (match) return t('observed.cli_exit_code', { code: match[1], signal: match[2] || '' });
    return text;
  }

  function readParams(element) {
    const serialized = element.dataset.i18nParams;
    if (!serialized) return undefined;
    try {
      return JSON.parse(serialized);
    } catch (_nonJsonTranslationValue) {
      // Plain strings are the common case; only serialized objects need parsing.
      return undefined;
    }
  }

  function translateElement(element) {
    if (!(element instanceof Element)) return;
    const params = readParams(element);
    const textKey = element.dataset.i18n;
    if (textKey) element.textContent = t(textKey, params);
    for (const attribute of TRANSLATED_ATTRIBUTES) {
      const key = element.getAttribute(`data-i18n-${attribute}`);
      if (key) element.setAttribute(attribute, t(key, params));
    }
  }

  /** Translate only elements that opt in with explicit data-i18n keys. */
  function translateTree(root = document.documentElement) {
    if (!(root instanceof Element) && !(root instanceof Document)) return;
    if (root instanceof Element && root.matches('[data-i18n], [data-i18n-aria-label], [data-i18n-placeholder], [data-i18n-title]')) {
      translateElement(root);
    }
    root.querySelectorAll?.('[data-i18n], [data-i18n-aria-label], [data-i18n-placeholder], [data-i18n-title]')
      .forEach(translateElement);
  }

  function syncDocument() {
    document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : locale;
    document.documentElement.dataset.locale = locale;
    const select = document.querySelector('#languageSelect');
    if (select) select.value = locale;
  }

  function setLocale(nextLocale) {
    if (!SUPPORTED.has(nextLocale)) return false;
    const changed = nextLocale !== locale;
    locale = nextLocale;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch (error) {
      window.LoadToAgentRendererUtils?.reportRecoverableError?.('locale-save', error);
    }
    syncDocument();
    translateTree();
    if (changed) {
      window.dispatchEvent(new CustomEvent('loadtoagent:locale-changed', {
        detail: { locale, localeTag: LOCALE_TAGS[locale] },
      }));
    }
    return changed;
  }

  const explicitNodeObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') translateElement(record.target);
      else record.addedNodes.forEach(node => {
        if (node instanceof Element) translateTree(node);
      });
    }
  });

  window.LoadToAgentI18n = Object.freeze({
    getLocale: () => locale,
    getLocaleTag: () => LOCALE_TAGS[locale],
    getSupportedLocales: () => [...SUPPORTED_LOCALES],
    setLocale,
    t,
    errorText,
    observedText,
    translateTree,
  });

  syncDocument();
  translateTree();
  explicitNodeObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-i18n', 'data-i18n-params', 'data-i18n-aria-label', 'data-i18n-placeholder', 'data-i18n-title'],
  });
  document.addEventListener('change', event => {
    if (event.target?.id === 'languageSelect') setLocale(event.target.value);
  });
})();
