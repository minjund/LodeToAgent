'use strict';

(() => {
  const COMMANDS = Object.freeze({
    model: Object.freeze({ value: '/model', descriptionKey: 'terminal.slash.command.model' }),
    status: Object.freeze({ value: '/status', descriptionKey: 'terminal.slash.command.status' }),
    compact: Object.freeze({ value: '/compact', descriptionKey: 'terminal.slash.command.compact' }),
    review: Object.freeze({ value: '/review', descriptionKey: 'terminal.slash.command.review' }),
    diff: Object.freeze({ value: '/diff', descriptionKey: 'terminal.slash.command.diff' }),
    new: Object.freeze({ value: '/new', descriptionKey: 'terminal.slash.command.new' }),
    context: Object.freeze({ value: '/context', descriptionKey: 'terminal.slash.command.context' }),
    help: Object.freeze({ value: '/help', descriptionKey: 'terminal.slash.command.help' }),
    clear: Object.freeze({ value: '/clear', descriptionKey: 'terminal.slash.command.clear' }),
  });

  const PROVIDER_COMMANDS = Object.freeze({
    codex: Object.freeze(['model', 'status', 'compact', 'review', 'diff', 'new']),
    claude: Object.freeze(['model', 'status', 'compact', 'context', 'help', 'clear']),
    generic: Object.freeze(['model', 'status', 'compact']),
  });

  function normalizeProvider(value) {
    const provider = String(value || '').trim().toLowerCase();
    if (provider.includes('claude') || provider.includes('anthropic')) return 'claude';
    if (provider.includes('codex') || provider.includes('openai') || provider === 'gpt') return 'codex';
    return 'generic';
  }

  function commandsForProvider(provider) {
    return PROVIDER_COMMANDS[normalizeProvider(provider)].map(key => COMMANDS[key]);
  }

  function slashQuery(value, selectionStart = String(value || '').length) {
    const text = String(value || '');
    const caret = Math.max(0, Math.min(text.length, Number(selectionStart) || 0));
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    if (!/^\/[a-z0-9-]*$/i.test(before) || !/^[a-z0-9-]*$/i.test(after)) return null;
    return before.slice(1).toLowerCase();
  }

  function filterCommands(provider, query = '') {
    const normalized = String(query || '').toLowerCase();
    return commandsForProvider(provider).filter(command => command.value.slice(1).includes(normalized));
  }

  function isLongDraft(value, measuredHeight = 0) {
    const text = String(value || '');
    return text.length >= 560 || text.split(/\r?\n/).length >= 7 || Number(measuredHeight) > 168;
  }

  function createTerminalComposer(context = {}) {
    const {
      $, state, currentTargetId, isAiTarget, providerForTarget,
      esc = value => String(value ?? ''),
    } = context;
    const t = (key, params) => window.LoadToAgentI18n.t(key, params);
    let bound = false;
    let menuOpen = false;
    let activeIndex = 0;
    let filtered = [];
    let longDraftExpanded = false;
    let lastTargetId = '';
    let dismissedValue = '';

    function provider() {
      return normalizeProvider(providerForTarget?.());
    }

    function providerName() {
      const value = provider();
      if (value === 'claude') return 'Claude';
      if (value === 'codex') return 'Codex';
      return 'AI';
    }

    function setMenuOpen(next) {
      const menu = $('#terminalSlashMenu');
      const input = $('#terminalCommandInput');
      const form = $('#terminalCommandForm');
      menuOpen = Boolean(next && menu && input && !input.disabled);
      menu?.classList.toggle('hidden', !menuOpen);
      input?.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
      form?.setAttribute('data-slash-open', menuOpen ? 'true' : 'false');
      if (!menuOpen) input?.removeAttribute('aria-activedescendant');
    }

    function syncActiveOption() {
      const input = $('#terminalCommandInput');
      const options = Array.from($('#terminalSlashMenuList')?.querySelectorAll('[data-terminal-slash-command]') || []);
      if (!options.length) {
        input?.removeAttribute('aria-activedescendant');
        return;
      }
      activeIndex = Math.max(0, Math.min(activeIndex, options.length - 1));
      options.forEach((option, index) => {
        const selected = index === activeIndex;
        option.classList.toggle('active', selected);
        option.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
      input?.setAttribute('aria-activedescendant', options[activeIndex].id);
      options[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function renderMenu(query) {
      const list = $('#terminalSlashMenuList');
      const title = $('#terminalSlashMenuTitle');
      const status = $('#terminalSlashMenuStatus');
      if (!list || !title || !status) return;
      filtered = filterCommands(provider(), query);
      activeIndex = Math.max(0, Math.min(activeIndex, filtered.length - 1));
      title.textContent = t('terminal.slash.title', { provider: providerName() });
      status.textContent = t('terminal.slash.result_count', { count: filtered.length });
      list.innerHTML = filtered.length
        ? filtered.map((command, index) => `
          <button id="terminal-slash-option-${index}" type="button" role="option" tabindex="-1"
            data-terminal-slash-command="${esc(command.value)}" aria-selected="${index === activeIndex ? 'true' : 'false'}">
            <span class="terminal-slash-command-token"><i aria-hidden="true">/</i><b>${esc(command.value.slice(1))}</b></span>
            <span class="terminal-slash-command-description">${esc(t(command.descriptionKey))}</span>
            <kbd aria-hidden="true">↵</kbd>
          </button>`).join('')
        : `<div class="terminal-slash-empty"><span aria-hidden="true">⌕</span><b>${esc(t('terminal.slash.no_results'))}</b><small>${esc(t('terminal.slash.no_results_hint'))}</small></div>`;
      syncActiveOption();
    }

    function syncMenu(options = {}) {
      const input = $('#terminalCommandInput');
      if (!input || !isAiTarget?.() || input.disabled) {
        setMenuOpen(false);
        return;
      }
      if (input.value !== dismissedValue) dismissedValue = '';
      const query = slashQuery(input.value, input.selectionStart);
      if (query == null || (!options.forceMenu && dismissedValue === input.value)) {
        setMenuOpen(false);
        return;
      }
      renderMenu(query);
      setMenuOpen(true);
      syncActiveOption();
    }

    function lineCount(value) {
      return String(value || '').split(/\r?\n/).length;
    }

    function syncLongDraft() {
      const form = $('#terminalCommandForm');
      const input = $('#terminalCommandInput');
      const meta = $('#terminalLongDraftMeta');
      const summary = $('#terminalLongDraftSummary');
      const toggle = $('#terminalLongDraftToggle');
      if (!form || !input || !meta || !summary || !toggle) return;
      const targetId = String(currentTargetId?.() || '');
      if (targetId !== lastTargetId) {
        lastTargetId = targetId;
        longDraftExpanded = false;
      }
      input.style.height = 'auto';
      const measuredHeight = input.scrollHeight;
      const longDraft = isLongDraft(input.value, measuredHeight);
      if (!longDraft) longDraftExpanded = false;
      form.dataset.longDraft = longDraft ? 'true' : 'false';
      form.dataset.longDraftExpanded = longDraft && longDraftExpanded ? 'true' : 'false';
      meta.classList.toggle('hidden', !longDraft);
      summary.textContent = longDraft ? t('terminal.composer.long_summary', {
        count: input.value.length.toLocaleString(),
        lines: lineCount(input.value).toLocaleString(),
      }) : '';
      toggle.textContent = t(longDraftExpanded ? 'terminal.composer.collapse' : 'terminal.composer.expand');
      toggle.setAttribute('aria-expanded', longDraftExpanded ? 'true' : 'false');
      const maximum = longDraft ? (longDraftExpanded ? 260 : 112) : 164;
      input.style.height = `${Math.max(64, Math.min(measuredHeight || 64, maximum))}px`;
    }

    function syncMode() {
      const form = $('#terminalCommandForm');
      const trigger = $('#terminalSlashTrigger');
      const attachTrigger = $('#terminalAttachTrigger');
      const hint = $('#terminalCommandModeHint');
      if (!form || !trigger || !hint) return;
      const aiTarget = Boolean(isAiTarget?.());
      const targetProvider = providerName();
      form.dataset.aiTarget = aiTarget ? 'true' : 'false';
      trigger.classList.toggle('hidden', !aiTarget);
      trigger.disabled = !aiTarget;
      attachTrigger?.classList.toggle('hidden', !aiTarget);
      if (attachTrigger) attachTrigger.disabled = !aiTarget;
      hint.textContent = t(aiTarget ? 'terminal.composer.ai_hint' : 'terminal.composer.shell_hint', {
        provider: targetProvider,
      });
      if (aiTarget) {
        trigger.setAttribute('aria-label', `${targetProvider}에게 보낼 질문 예시 보기`);
        const label = trigger.querySelector('span');
        if (label) label.textContent = '질문 예시 보기';
        attachTrigger?.setAttribute('aria-label', `${targetProvider}에게 보낼 파일 첨부`);
      }
      const submit = form.querySelector('.terminal-command-submit');
      const submitLabel = submit?.querySelector('span');
      if (submit) submit.setAttribute('aria-label', aiTarget ? `${targetProvider}에게 보내기` : '컴퓨터에서 실행하기');
      if (submitLabel) submitLabel.textContent = aiTarget ? `${targetProvider}에게 보내기` : '컴퓨터에서 실행하기';
    }

    function sync(options = {}) {
      syncMode();
      syncLongDraft();
      syncMenu(options);
    }

    function closeMenu() {
      dismissedValue = $('#terminalCommandInput')?.value || '';
      setMenuOpen(false);
    }

    function selectCommand(index = activeIndex) {
      const input = $('#terminalCommandInput');
      const command = filtered[index];
      if (!input || !command) return false;
      input.value = command.value;
      dismissedValue = command.value;
      setMenuOpen(false);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      window.LoadToAgentA11y?.announce(t('terminal.slash.selected', { command: command.value }));
      return true;
    }

    function handleKeydown(event) {
      if (!menuOpen) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return true;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!filtered.length) return true;
        if (event.key === 'Home') activeIndex = 0;
        else if (event.key === 'End') activeIndex = filtered.length - 1;
        else activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
        syncActiveOption();
        return true;
      }
      if (!['Enter', 'Tab'].includes(event.key) || !filtered.length || event.isComposing || event.keyCode === 229) return false;
      const input = $('#terminalCommandInput');
      const selected = filtered[activeIndex];
      if (event.key === 'Enter' && input?.value === selected?.value) {
        setMenuOpen(false);
        return false;
      }
      event.preventDefault();
      selectCommand();
      return true;
    }

    function openMenu() {
      const input = $('#terminalCommandInput');
      if (!input || input.disabled || !isAiTarget?.()) return;
      if (slashQuery(input.value, input.selectionStart) == null) input.value = '/';
      dismissedValue = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      sync({ forceMenu: true });
    }

    function toggleLongDraft() {
      if ($('#terminalCommandForm')?.dataset.longDraft !== 'true') return;
      longDraftExpanded = !longDraftExpanded;
      syncLongDraft();
      $('#terminalCommandInput')?.focus({ preventScroll: true });
      window.LoadToAgentA11y?.announce(t(longDraftExpanded ? 'terminal.composer.expanded_announcement' : 'terminal.composer.collapsed_announcement'));
    }

    function bind() {
      if (bound) return;
      bound = true;
      $('#terminalSlashTrigger')?.addEventListener('click', openMenu);
      $('#terminalAttachTrigger')?.addEventListener('click', openMenu);
      $('#terminalLongDraftToggle')?.addEventListener('click', toggleLongDraft);
      $('#terminalSlashMenu')?.addEventListener('mousedown', event => {
        if (event.target.closest('[data-terminal-slash-command]')) event.preventDefault();
      });
      $('#terminalSlashMenu')?.addEventListener('click', event => {
        const option = event.target.closest('[data-terminal-slash-command]');
        if (!option) return;
        const index = filtered.findIndex(command => command.value === option.dataset.terminalSlashCommand);
        if (index >= 0) selectCommand(index);
      });
      $('#terminalCommandInput')?.addEventListener('blur', () => {
        setTimeout(() => {
          if (!$('#terminalCommandForm')?.contains(document.activeElement)) setMenuOpen(false);
        }, 0);
      });
      window.addEventListener('resize', () => syncLongDraft());
      sync();
    }

    return {
      bind,
      sync,
      closeMenu,
      handleKeydown,
      isMenuOpen: () => menuOpen,
    };
  }

  window.LoadToAgentTerminalComposer = Object.freeze({
    create: createTerminalComposer,
    commandsForProvider,
    filterCommands,
    slashQuery,
    isLongDraft,
    normalizeProvider,
  });
})();
