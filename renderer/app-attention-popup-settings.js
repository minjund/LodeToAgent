"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createAttentionPopupSettings = function createAttentionPopupSettings(context = {}) {
  const MAX_HOOK_DETAIL_LENGTH = 240;
  const HOOK_ISSUE_MESSAGE_KEYS = Object.freeze({
    warning: "settings.attention_popups.hook_warning",
    error: "settings.attention_popups.hook_error",
    "review-required": "settings.attention_popups.hook_review_required",
  });
  const t = (key, params) => window.WhiteboxI18n.t(key, params);
  const { $, state, toast = () => {}, announce = () => {}, reportRecoverableError = () => {} } = context;
  let bound = false;
  let saving = false;

  function safeHookDetail(value) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_HOOK_DETAIL_LENGTH);
  }

  function normalizedHookStatus(value, enabled) {
    if (!enabled) return "disabled";
    const status = String(value || "").trim().toLowerCase().replace(/_/g, "-");
    if (status === "installed" || status === "idle" || HOOK_ISSUE_MESSAGE_KEYS[status]) return status;
    return "installed";
  }

  function loadAttentionPopupSettings(value = {}) {
    state.attentionPopups = {
      enabled: value?.enabled !== false,
      hookStatus: String(value?.hookStatus || ""),
      hookDetail: String(value?.hookDetail || ""),
    };
  }

  function renderAttentionPopupSettings() {
    const card = $("#attentionPopupSettingsCard");
    const input = $("#attentionPopupEnabled");
    const status = $("#attentionPopupStatus");
    if (!card || !input || !status) return;
    const enabled = state.attentionPopups?.enabled === true;
    const hookStatus = normalizedHookStatus(state.attentionPopups?.hookStatus, enabled);
    const issueMessageKey = enabled ? HOOK_ISSUE_MESSAGE_KEYS[hookStatus] : "";
    card.dataset.enabled = enabled ? "true" : "false";
    card.dataset.busy = saving ? "true" : "false";
    card.dataset.hookStatus = hookStatus;
    input.checked = enabled;
    input.disabled = saving;
    input.setAttribute("aria-checked", enabled ? "true" : "false");
    if (issueMessageKey) {
      const detail = safeHookDetail(state.attentionPopups?.hookDetail)
        || t("settings.attention_popups.hook_detail_unavailable");
      status.textContent = t(issueMessageKey, { detail });
    } else {
      status.textContent = t(enabled ? "settings.attention_popups.enabled" : "settings.attention_popups.disabled");
    }
  }

  function bindAttentionPopupSettings() {
    const input = $("#attentionPopupEnabled");
    if (!input || bound) return;
    bound = true;
    input.addEventListener("change", async () => {
      if (saving) return;
      const previous = state.attentionPopups?.enabled === true;
      const desired = input.checked;
      saving = true;
      loadAttentionPopupSettings({ ...state.attentionPopups, enabled: desired });
      renderAttentionPopupSettings();
      try {
        const saved = await window.whitebox.setAttentionPopups({ enabled: desired });
        loadAttentionPopupSettings(saved || { enabled: desired });
        const key = state.attentionPopups.enabled
          ? "settings.attention_popups.enabled_toast"
          : "settings.attention_popups.disabled_toast";
        toast(t(key));
        announce(t(key));
      } catch (error) {
        reportRecoverableError("attention-popup-preference-save", error);
        loadAttentionPopupSettings({ ...state.attentionPopups, enabled: previous });
        toast(t("settings.attention_popups.save_failed"));
        announce(t("settings.attention_popups.save_failed"));
      } finally {
        saving = false;
        renderAttentionPopupSettings();
      }
    });
  }

  return { loadAttentionPopupSettings, renderAttentionPopupSettings, bindAttentionPopupSettings };
};
