'use strict';

(() => {
  const STORAGE_KEY = 'loadtoagent:theme:v1';
  const THEMES = new Set(['dark', 'light']);

  function readTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return THEMES.has(saved) ? saved : 'dark';
    } catch (_error) {
      return 'dark';
    }
  }

  let theme = readTheme();
  document.documentElement.dataset.theme = theme;

  function label(key, fallback) {
    return window.LoadToAgentI18n?.t?.(key) || fallback;
  }

  function syncControls() {
    const light = theme === 'light';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const nextLabel = light
        ? label('settings.theme.switch_to_dark', '어두운 색상으로 바꾸기')
        : label('settings.theme.switch_to_light', '밝은 색상으로 바꾸기');
      button.setAttribute('aria-label', nextLabel);
      button.setAttribute('title', nextLabel);
      button.setAttribute('aria-pressed', light ? 'true' : 'false');
      const visibleLabel = button.querySelector('[data-theme-toggle-label]');
      if (visibleLabel) {
        visibleLabel.textContent = light
          ? label('settings.theme.switch_to_dark', '어두운 모드로 전환')
          : label('settings.theme.switch_to_light', '밝은 모드로 전환');
      }
    });
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const selected = button.dataset.themeChoice === theme;
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.classList.toggle('active', selected);
    });
    const settingsTitle = document.querySelector('#themeSettingsTitle');
    if (settingsTitle) {
      settingsTitle.textContent = light
        ? label('settings.theme.current_light', '현재 화면 모드: 밝은 모드')
        : label('settings.theme.current_dark', '현재 화면 모드: 어두운 모드');
    }
  }

  function setTheme(nextTheme, options = {}) {
    if (!THEMES.has(nextTheme)) return false;
    const changed = theme !== nextTheme;
    theme = nextTheme;
    document.documentElement.dataset.theme = theme;
    if (options.persist !== false) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch (error) {
        window.LoadToAgentRendererUtils?.reportRecoverableError?.('theme-save', error);
      }
    }
    syncControls();
    if (changed) {
      window.dispatchEvent(new CustomEvent('loadtoagent:theme-changed', {
        detail: { theme },
      }));
    }
    return changed;
  }

  function bindControls() {
    syncControls();
    document.addEventListener('click', event => {
      const toggle = event.target.closest('[data-theme-toggle]');
      if (toggle) {
        setTheme(theme === 'light' ? 'dark' : 'light');
        return;
      }
      const choice = event.target.closest('[data-theme-choice]');
      if (choice) setTheme(choice.dataset.themeChoice);
    });
    window.addEventListener('loadtoagent:locale-changed', syncControls);
  }

  window.LoadToAgentTheme = Object.freeze({
    getTheme: () => theme,
    setTheme,
    syncControls,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindControls, { once: true });
  } else {
    bindControls();
  }
})();
