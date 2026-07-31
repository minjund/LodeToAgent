"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createRunModal = function createRunModal(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $,
    esc,
    uiLocale,
    state,
    PROJECTLESS_WORKSPACE,
    motionPreference,
    motionState,
    markGuideStep,
    rememberDialogTrigger,
    restoreDialogTrigger,
    setDialogOpenState,
    announce,
    providerInfo,
    providerStyle,
    visibleProviders = () => state.providers,
    isProviderVisible = () => true,
    restoreRunDraft = () => {},
    clearRunDraft = () => {},
  } = context;

  function providerPickerHtml() {
    return visibleProviders()
      .map((provider) => {
        const installed = !!state.availability[provider.id];
        const selected = state.runProvider === provider.id;
        return `<button type="button" class="run-provider-option ${selected ? "selected" : ""}"
          data-run-provider="${esc(provider.id)}"
          style="${providerStyle(provider.id)}"
          role="radio" aria-checked="${selected ? "true" : "false"}"
          tabindex="${selected ? "0" : "-1"}"
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
    if (selectedProjectPath()) return "";
    const selected = String(($("#runCwd") && $("#runCwd").value) || "");
    return state.workspaces
      .slice(0, 4)
      .map((workspace) => {
        const path = workspace.path || workspace.name || "";
        const active = path === selected;
        return `<button type="button" data-run-workspace="${esc(path)}" class="${active ? "selected" : ""}" title="${esc(path)}" aria-pressed="${active ? "true" : "false"}">
        <span aria-hidden="true">⌘</span>
        ${esc(workspace.name || path.split(/[\\/]/).filter(Boolean).pop() || window.LoadToAgentI18n.t("ui.work_folder"))}
        </button>`;
      })
      .join("");
  }

  function selectedProjectPath() {
    const path = String(state.workspace || "").trim();
    return path && path !== "all" && path !== PROJECTLESS_WORKSPACE ? path : "";
  }

  function selectedProjectName(path) {
    const workspace = state.workspaces.find((item) => String(item.path || "") === path);
    if (workspace?.name) return workspace.name;
    return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).pop() || t("studio.sidebar.title");
  }

  function syncLockedProject() {
    const path = selectedProjectPath();
    const cwd = $("#runCwd");
    if (cwd) {
      cwd.value = path;
      cwd.readOnly = true;
      cwd.setAttribute("aria-readonly", "true");
    }
    const name = $("#runProjectName");
    const pathLabel = $("#runProjectPath");
    if (name) name.textContent = path ? selectedProjectName(path) : t("studio.sidebar.title");
    if (pathLabel) pathLabel.textContent = path;
    $("#pickRunCwdBtn")?.classList.add("hidden");
    $("#runWorkspaceSuggestions")?.classList.add("hidden");
    return path;
  }

  function syncRunComposer() {
    syncLockedProject();
    const prompt = $("#runPrompt");
    const count = $("#runPromptCount");
    if (prompt && count) {
      const wasWarning = count.dataset.warning === "true";
      const warning = prompt.value.length >= 7_200;
      count.textContent = `${prompt.value.length.toLocaleString(uiLocale())}/8,000자`;
      count.classList.toggle("warning", warning);
      count.dataset.warning = warning ? "true" : "false";
      if (warning && !wasWarning) announce(t("run.prompt_near_limit", { count: Math.max(0, 8_000 - prompt.value.length) }));
    }
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
    $("#closeRunModalBtn").disabled = submitting;
    $("#cancelRunBtn").disabled = submitting;
    const label = $("#runSubmitLabel");
    if (label) label.textContent = submitting
      ? t("run.preparing")
      : t("provider.assign", { provider: providerInfo(state.runProvider).label });
  }

  function openRunModal() {
    const projectPath = selectedProjectPath();
    if (!projectPath) {
      toast(t("run.select_project_first"));
      $("#projectSidebarList")?.focus({ preventScroll: true });
      return false;
    }
    rememberDialogTrigger();
    restoreRunDraft();
    const installed = visibleProviders().find((provider) => state.availability[provider.id]);
    if ((!isProviderVisible(state.runProvider) || !state.availability[state.runProvider]) && installed) state.runProvider = installed.id;
    if (!isProviderVisible(state.runProvider)) state.runProvider = visibleProviders()[0]?.id || "";
    $("#runProviderPicker").innerHTML = providerPickerHtml();
    $("#runCwd").value = projectPath;
    $("#runError").classList.add("hidden");
    syncRunComposer();
    clearTimeout(motionState.modalTimer);
    clearTimeout(motionState.modalFocusTimer);
    setDialogOpenState($("#runModal"), true);
    $("#runModal").classList.remove("hidden", "closing");
    const focusPromptIfOutside = () => {
      const modal = $("#runModal");
      if (!modal.classList.contains("hidden") && !modal.classList.contains("closing") && !modal.contains(document.activeElement)) {
        $("#runPrompt").focus();
      }
    };
    setTimeout(focusPromptIfOutside, 0);
    motionState.modalFocusTimer = setTimeout(focusPromptIfOutside, motionPreference.matches ? 0 : 300);
    return true;
  }

  function closeRunModal(force = false) {
    const modal = $("#runModal");
    if (modal.classList.contains("hidden") || modal.classList.contains("closing")) return;
    if (force !== true && $('#runForm button[type="submit"]').dataset.submitting === "true") return;
    const modalGeneration = motionState.dialogGeneration;
    clearTimeout(motionState.modalFocusTimer);
    modal.classList.add("closing");
    clearTimeout(motionState.modalTimer);
    motionState.modalTimer = setTimeout(
      () => {
        modal.classList.add("hidden");
        modal.classList.remove("closing");
        setDialogOpenState(modal, false);
        restoreDialogTrigger(modalGeneration);
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

  async function performUiAction(action, failureMessage, control = null) {
    if (control?.dataset.busy === "true") return null;
    const wasDisabled = Boolean(control?.disabled);
    if (control) {
      control.dataset.busy = "true";
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
    }
    try {
      return await action();
    } catch (error) {
      toast(window.LoadToAgentI18n.errorText(error, failureMessage));
      return null;
    } finally {
      if (control?.isConnected) {
        delete control.dataset.busy;
        control.disabled = wasDisabled;
        control.removeAttribute("aria-busy");
      }
    }
  }

  async function handleRun(event) {
    event.preventDefault();
    const prompt = $("#runPrompt");
    const cwd = $("#runCwd");
    const invalid = [];
    if (!prompt.value.trim()) {
      prompt.setAttribute("aria-invalid", "true");
      invalid.push({ element: prompt, message: t("quality.run_prompt_required") });
    }
    if (!cwd.value.trim()) {
      cwd.setAttribute("aria-invalid", "true");
      invalid.push({ element: cwd, message: t("quality.run_cwd_required") });
    }
    if (invalid.length) {
      $("#runError").textContent = invalid[0].message;
      $("#runError").classList.remove("hidden");
      invalid[0].element.focus({ preventScroll: true });
      announce(invalid[0].message);
      return;
    }
    if (!isProviderVisible(state.runProvider) || !state.availability[state.runProvider]) {
      $("#runError").textContent = window.LoadToAgentI18n.t("ui.no_ai_cli_is_ready_follow_the_official_setup_guide");
      $("#runError").classList.remove("hidden");
      $("#runError").focus({ preventScroll: true });
      return;
    }
    setRunSubmitting(true);
    $("#runError").classList.add("hidden");
    try {
      syncLockedProject();
      const result = await window.loadtoagent.runAgent({
        provider: state.runProvider,
        cwd: $("#runCwd").value.trim(),
        model: $("#runModel").value.trim(),
        prompt: $("#runPrompt").value.trim(),
        allowWrites: $("#allowWrites").checked,
      });
      if (!result.ok) throw new Error(result.error || window.LoadToAgentI18n.t("ui.could_not_start_the_task"));
      markGuideStep("create");
      closeRunModal(true);
      clearRunDraft({ silent: true, focus: false });
      syncRunComposer();
      toast(window.LoadToAgentI18n.t("provider.started", { provider: providerInfo(state.runProvider).label }));
    } catch (error) {
      $("#runError").textContent = window.LoadToAgentI18n.errorText(error, "ui.could_not_start_the_task");
      $("#runError").classList.remove("hidden");
      $("#runError").focus({ preventScroll: true });
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
