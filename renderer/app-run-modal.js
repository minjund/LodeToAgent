"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createRunModal = function createRunModal(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $,
    esc,
    uiLocale,
    state,
    motionPreference,
    motionState,
    markGuideStep,
    rememberDialogTrigger,
    restoreDialogTrigger,
    providerInfo,
    providerStyle,
    visibleProviders = () => state.providers,
    isProviderVisible = () => true,
  } = context;

  function providerPickerHtml() {
    return visibleProviders()
      .map((provider) => {
        const installed = !!state.availability[provider.id];
        const selected = state.runProvider === provider.id;
        return `<button type="button" class="run-provider-option ${selected ? "selected" : ""}"
          data-run-provider="${esc(provider.id)}"
          style="${providerStyle(provider.id)}"
          aria-pressed="${selected ? "true" : "false"}"
          ${installed ? "" : "disabled"}>
        <span class="provider-mini-mark">${esc(provider.mark)}</span>
        <span class="run-provider-copy">
        <b>${esc(provider.label)}</b>
        <small>${esc(installed ? t("run.cli_found", { company: provider.company }) : t("ui.setup_required"))}</small>
        </span>
        <span class="run-provider-check" aria-hidden="true">✓</span>
        </button>`;
      })
      .join("");
  }

  function runProviderHelpHtml() {
    if (!visibleProviders().length) return `<div class="run-provider-help-copy">
      <b>${t("settings.providers.all_hidden_title")}</b>
      <p>${t("settings.providers.all_hidden_description")}</p>
      </div>`;
    const available = visibleProviders().filter((provider) => state.availability[provider.id]);
    if (available.length) return "";
    const docs = visibleProviders()
      .map(
        (provider) => `<button type="button" data-provider-docs="${esc(provider.id)}">
      <span class="provider-mini-mark" style="${providerStyle(provider.id)}">${esc(provider.mark)}</span>
      <span>
      <b>${esc(t("provider.install_guide", { provider: provider.label }))}</b>
      <small>${esc(t("run.check_official_docs"))}</small>
      </span>
      <i aria-hidden="true">↗</i>
      </button>`,
      )
      .join("");
    return `<div class="run-provider-help-copy">
      <b>${esc(t("run.prepare_cli"))}</b>
      <p>${esc(t("run.prepare_cli_steps"))}</p>
      </div>
      <div class="run-provider-docs">${docs}</div>
      <button type="button" class="provider-recheck" data-provider-recheck>↻ ${esc(t("run.recheck_installation"))}</button>`;
  }

  function runWorkspaceSuggestionsHtml() {
    const selected = String(($("#runCwd") && $("#runCwd").value) || "");
    return state.workspaces
      .slice(0, 4)
      .map((workspace) => {
        const path = workspace.path || workspace.name || "";
        const active = path === selected;
        return `<button type="button" data-run-workspace="${esc(path)}" class="${active ? "selected" : ""}" title="${esc(path)}">
        <span aria-hidden="true">⌘</span>
        ${esc(workspace.name || path.split(/[\\/]/).filter(Boolean).pop() || window.LoadToAgentI18n.t("ui.workspaces"))}
        </button>`;
      })
      .join("");
  }

  function syncRunComposer() {
    const prompt = $("#runPrompt");
    const count = $("#runPromptCount");
    if (prompt && count) count.textContent = `${prompt.value.length.toLocaleString(uiLocale())} / 8,000`;
    const submitLabel = $("#runSubmitLabel");
    const submit = $('#runForm button[type="submit"]');
    const hasProvider = isProviderVisible(state.runProvider) && Boolean(state.availability[state.runProvider]);
    const providerHelp = $("#runProviderHelp");
    if (providerHelp) {
      providerHelp.innerHTML = runProviderHelpHtml();
      providerHelp.classList.toggle(
        "hidden",
        visibleProviders().some((provider) => state.availability[provider.id]),
      );
    }
    if (submit) submit.disabled = submit.dataset.submitting === "true" || !hasProvider;
    if (submitLabel && submit.dataset.submitting !== "true")
      submitLabel.textContent = hasProvider
        ? t("provider.assign", { provider: providerInfo(state.runProvider).label })
        : visibleProviders().length ? t("run.ai_installation_required") : t("settings.providers.enable_to_run");
    const writeIntent = /(고치|수정|추가|구현|변경|삭제|작성|리팩터|fix|implement|update|edit|refactor)/i.test((prompt && prompt.value) || "");
    const permissionHint = $("#runPermissionHint");
    const permissionNeeded = writeIntent && !$("#allowWrites").checked;
    permissionHint.classList.toggle("hidden", !permissionNeeded);
    if (permissionNeeded) $("#allowWrites").setAttribute("aria-describedby", "runPermissionHint");
    else $("#allowWrites").removeAttribute("aria-describedby");
    const suggestions = $("#runWorkspaceSuggestions");
    if (suggestions) suggestions.innerHTML = runWorkspaceSuggestionsHtml();
  }

  function setRunSubmitting(submitting) {
    const submit = $('#runForm button[type="submit"]');
    if (!submit) return;
    submit.dataset.submitting = submitting ? "true" : "false";
    submit.disabled = submitting || !isProviderVisible(state.runProvider) || !state.availability[state.runProvider];
    submit.setAttribute("aria-busy", submitting ? "true" : "false");
    const label = $("#runSubmitLabel");
    if (label) label.textContent = submitting
      ? t("run.preparing")
      : t("provider.assign", { provider: providerInfo(state.runProvider).label });
  }

  function openRunModal() {
    rememberDialogTrigger();
    const installed = visibleProviders().find((provider) => state.availability[provider.id]);
    if ((!isProviderVisible(state.runProvider) || !state.availability[state.runProvider]) && installed) state.runProvider = installed.id;
    if (!isProviderVisible(state.runProvider)) state.runProvider = visibleProviders()[0]?.id || "";
    $("#runProviderPicker").innerHTML = providerPickerHtml();
    if (!$("#runCwd").value) $("#runCwd").value = state.workspace !== "all" ? state.workspace : (state.workspaces[0] && state.workspaces[0].path) || "";
    $("#runCwd").placeholder = state.platform.id === "win32" ? "D:\\project" : "/Users/me/project";
    const advanced = $("#runForm .run-advanced");
    if (advanced) advanced.open = Boolean($("#runModel").value.trim());
    $("#runError").classList.add("hidden");
    syncRunComposer();
    clearTimeout(motionState.modalTimer);
    $("#runModal").classList.remove("hidden", "closing");
    setTimeout(() => $("#runPrompt").focus(), 0);
  }

  function closeRunModal() {
    const modal = $("#runModal");
    if (modal.classList.contains("hidden") || modal.classList.contains("closing")) return;
    modal.classList.add("closing");
    clearTimeout(motionState.modalTimer);
    motionState.modalTimer = setTimeout(
      () => {
        modal.classList.add("hidden");
        modal.classList.remove("closing");
        restoreDialogTrigger();
      },
      motionPreference.matches ? 0 : 220,
    );
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.remove("hidden", "leaving");
    clearTimeout(motionState.toastTimer);
    motionState.toastTimer = setTimeout(() => {
      el.classList.add("leaving");
      motionState.toastTimer = setTimeout(
        () => {
          el.classList.add("hidden");
          el.classList.remove("leaving");
        },
        motionPreference.matches ? 0 : 220,
      );
    }, 3200);
  }

  async function performUiAction(action, failureMessage) {
    try {
      return await action();
    } catch (error) {
      toast(window.LoadToAgentI18n.errorText(error, failureMessage));
      return null;
    }
  }

  async function handleRun(event) {
    event.preventDefault();
    if (!isProviderVisible(state.runProvider) || !state.availability[state.runProvider]) {
      $("#runError").textContent = window.LoadToAgentI18n.t("ui.no_ai_cli_is_ready_follow_the_official_setup_guide");
      $("#runError").classList.remove("hidden");
      return;
    }
    setRunSubmitting(true);
    $("#runError").classList.add("hidden");
    try {
      const result = await window.loadtoagent.runAgent({
        provider: state.runProvider,
        cwd: $("#runCwd").value.trim(),
        model: $("#runModel").value.trim(),
        prompt: $("#runPrompt").value.trim(),
        allowWrites: $("#allowWrites").checked,
      });
      if (!result.ok) throw new Error(result.error || window.LoadToAgentI18n.t("ui.could_not_start_the_task"));
      markGuideStep("create");
      closeRunModal();
      $("#runPrompt").value = "";
      syncRunComposer();
      toast(window.LoadToAgentI18n.t("provider.started", { provider: providerInfo(state.runProvider).label }));
    } catch (error) {
      $("#runError").textContent = window.LoadToAgentI18n.errorText(error, "ui.could_not_start_the_task");
      $("#runError").classList.remove("hidden");
    } finally {
      setRunSubmitting(false);
    }
  }

  return {
    providerPickerHtml,
    runProviderHelpHtml,
    runWorkspaceSuggestionsHtml,
    syncRunComposer,
    setRunSubmitting,
    openRunModal,
    closeRunModal,
    toast,
    performUiAction,
    handleRun,
  };
};
