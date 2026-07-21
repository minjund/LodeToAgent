"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDialogEventBindings = function createDialogEventBindings(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, $$, state, providerInfo, visibleProviders = () => state.providers, renderProviderRail, scheduleAgentWorkflowConnections, resumeAgentTerminal, loadSessionDetail,
    closeDrawer, renderDrawer, providerPickerHtml, syncRunComposer, openRunModal, closeRunModal, toast, performUiAction,
    handleRun, trapDialogFocus, currentDialog, selectView, saveRunDraft = () => {}, safeBackdrop = null,
    copyText = async () => false,
    dispatchAgentCommand, controlManagedRun, quickRespond, prepareReassignment,
  } = context;

  function bindRunComposerEvents() {
    $("#newRunBtn").addEventListener("click", openRunModal);
    $$("[data-open-run]").forEach((button) => button.addEventListener("click", openRunModal));
    $("#closeRunModalBtn").addEventListener("click", () => closeRunModal());
    $("#cancelRunBtn").addEventListener("click", () => closeRunModal());
    if (safeBackdrop) safeBackdrop($("#runModal"), () => closeRunModal());
    else $("#runModal").addEventListener("click", (event) => {
      if (event.target === $("#runModal")) closeRunModal();
    });
    $("#runProviderPicker").addEventListener("click", (event) => {
      const button = event.target.closest("[data-run-provider]");
      if (!button || button.disabled) return;
      state.runProvider = button.dataset.runProvider;
      $("#runProviderPicker").innerHTML = providerPickerHtml();
      syncRunComposer();
      saveRunDraft();
    });
    $("#runProviderPicker").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const options = $$("#runProviderPicker [data-run-provider]:not(:disabled)");
      const current = Math.max(0, options.indexOf(event.target.closest("[data-run-provider]")));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + options.length) % options.length;
      event.preventDefault();
      options[next]?.click();
      requestAnimationFrame(() => $("#runProviderPicker").querySelector(`[data-run-provider="${CSS.escape(state.runProvider)}"]`)?.focus());
    });
    $("#runProviderHelp").addEventListener("click", async (event) => {
      const docs = event.target.closest("[data-provider-docs]");
      if (docs) {
        const provider = providerInfo(docs.dataset.providerDocs);
        if (provider.docs)
          await performUiAction(async () => {
            const result = await window.loadtoagent.openExternal(provider.docs);
            if (!result || result.ok === false) throw new Error(t("run.docs_open_failed"));
          }, t("run.docs_open_failed"), docs);
        return;
      }
      const recheck = event.target.closest("[data-provider-recheck]");
      if (recheck) {
        const nextAvailability = await performUiAction(() => window.loadtoagent.probeProviders(), t("run.cli_check_failed"), recheck);
        if (!nextAvailability) return;
        state.availability = nextAvailability;
        const installed = visibleProviders().find((provider) => state.availability[provider.id]);
        if (installed) state.runProvider = installed.id;
        $("#runProviderPicker").innerHTML = providerPickerHtml();
        renderProviderRail();
        syncRunComposer();
        toast(installed ? t("run.cli_ready", { provider: installed.label }) : t("run.cli_not_found"));
      }
    });
    $("#runPrompt").addEventListener("input", syncRunComposer);
    $(".run-prompt-examples").addEventListener("click", (event) => {
      const example = event.target.closest("[data-run-prompt-key]");
      if (!example) return;
      const input = $("#runPrompt");
      const text = t(example.dataset.runPromptKey);
      if (!input.value.trim()) input.value = text;
      else input.setRangeText(`${input.selectionStart ? "\n\n" : ""}${text}`, input.selectionStart, input.selectionEnd, "end");
      syncRunComposer();
      saveRunDraft();
      input.focus();
    });
    $("#runWorkspaceSuggestions").addEventListener("click", (event) => {
      const workspace = event.target.closest("[data-run-workspace]");
      if (!workspace) return;
      $("#runCwd").value = workspace.dataset.runWorkspace;
      syncRunComposer();
      saveRunDraft();
    });
    $("#runWorkspaceSuggestions").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const options = $$("#runWorkspaceSuggestions [data-run-workspace]");
      const current = Math.max(0, options.indexOf(event.target.closest("[data-run-workspace]")));
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
      event.preventDefault();
      options[next]?.focus();
    });
    $("#runCwd").addEventListener("input", syncRunComposer);
    $("#allowWrites").addEventListener("change", syncRunComposer);
    $("#pickRunCwdBtn").addEventListener("click", async () => {
      const folder = await performUiAction(() => window.loadtoagent.pickWorkspace(), t("workspace.pick_failed"), $("#pickRunCwdBtn"));
      if (folder) {
        $("#runCwd").value = folder;
        syncRunComposer();
        saveRunDraft();
      }
    });
    $("#runForm").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        $("#runForm").requestSubmit();
      }
    });
    $("#runForm").addEventListener("submit", handleRun);
    $("#runForm").addEventListener("invalid", (event) => {
      event.target.setAttribute("aria-invalid", "true");
      if (!$("#runForm").dataset.invalidFocusQueued) {
        $("#runForm").dataset.invalidFocusQueued = "true";
        queueMicrotask(() => {
          delete $("#runForm").dataset.invalidFocusQueued;
          $("#runForm").querySelector(":invalid")?.focus({ preventScroll: true });
        });
      }
    }, true);
    $("#runForm").addEventListener("input", (event) => {
      if (event.target.matches("input, textarea, select") && event.target.checkValidity()) event.target.removeAttribute("aria-invalid");
      $("#runError").classList.add("hidden");
      $("#runError").textContent = "";
    });
  }

  function bindDrawerAndGlobalEvents() {
    $("#closeDrawerBtn").addEventListener("click", closeDrawer);
    if (safeBackdrop) safeBackdrop($("#drawerBackdrop"), closeDrawer, $("#detailDrawer"));
    else $("#drawerBackdrop").addEventListener("click", closeDrawer);
    $(".drawer-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tab]");
      if (tab) {
        state.drawerTab = tab.dataset.tab;
        state.drawerForceLatest = tab.dataset.tab === "chat";
        renderDrawer();
      }
    });
    $(".drawer-tabs").addEventListener("keydown", (event) => {
      const pageKey = event.ctrlKey && ["PageUp", "PageDown"].includes(event.key);
      if (!pageKey && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const tabs = $$(".drawer-tab:not(.hidden)");
      const current = Math.max(0, tabs.indexOf(event.target.closest(".drawer-tab")));
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      state.drawerTab = tabs[next].dataset.tab;
      state.drawerForceLatest = state.drawerTab === "chat";
      renderDrawer();
      $(`.drawer-tab[data-tab="${state.drawerTab}"]`)?.focus();
    });
    $("#detailDrawer").addEventListener("click", async (event) => {
      const copy = event.target.closest("[data-copy-text]");
      if (copy) {
        await copyText(copy.dataset.copyText);
        return;
      }
      const resume = event.target.closest("[data-resume-agent]");
      if (resume) {
        if (resume.dataset.busy === "true") return;
        resume.dataset.busy = "true";
        resume.disabled = true;
        resume.setAttribute("aria-busy", "true");
        try {
          await resumeAgentTerminal(resume.dataset.resumeAgent);
        } finally {
          if (resume.isConnected) {
            delete resume.dataset.busy;
            resume.disabled = false;
            resume.removeAttribute("aria-busy");
          }
        }
        return;
      }
      const quick = event.target.closest("[data-attention-quick]");
      if (quick) {
        quickRespond(quick.dataset.attentionSessionId || state.selectedId, quick.dataset.attentionQuick, $("#detailDrawer"));
        return;
      }
      const managedAction = event.target.closest("[data-managed-run-action]");
      if (managedAction) {
        await controlManagedRun(managedAction.dataset.managementSessionId || state.selectedId, managedAction.dataset.managedRunAction);
        return;
      }
      const reassign = event.target.closest("[data-reassign-session]");
      if (reassign) {
        prepareReassignment(reassign.dataset.reassignSession);
        return;
      }
      const retry = event.target.closest("[data-retry-detail]");
      if (retry) {
        if (retry.dataset.busy === "true") return;
        retry.dataset.busy = "true";
        retry.disabled = true;
        retry.setAttribute("aria-busy", "true");
        await loadSessionDetail(retry.dataset.retryDetail, true);
        return;
      }
      const latest = event.target.closest("[data-scroll-latest]");
      if (latest) {
        const content = $("#drawerContent");
        content.scrollTo({ top: content.scrollHeight, behavior: "smooth" });
        return;
      }
      const stop = event.target.closest("[data-stop-run]");
      if (stop) await controlManagedRun(state.selectedId, "stop");
    });
    $("#detailDrawer").addEventListener("input", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (input) state.agentCommandDrafts.set(input.dataset.agentCommandDraft, input.value);
    });
    $("#detailDrawer").addEventListener("change", (event) => {
      const picker = event.target.closest("[data-agent-command-target]");
      if (!picker) return;
      if (picker.value) state.agentCommandTargets.set(picker.dataset.agentCommandTarget, picker.value);
      else state.agentCommandTargets.delete(picker.dataset.agentCommandTarget);
      picker.closest("form")?.querySelectorAll("button").forEach(button => { button.disabled = !picker.value; });
    });
    $("#detailDrawer").addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (!input || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      input.closest("form")?.requestSubmit();
    });
    $("#detailDrawer").addEventListener("submit", (event) => {
      const form = event.target.closest("[data-agent-command-form]");
      if (!form) return;
      event.preventDefault();
      dispatchAgentCommand(form.dataset.agentCommandForm, form);
    });
    document.addEventListener("keydown", (event) => {
      trapDialogFocus(event);
      const editable = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable='true']"));
      const dialogOpen = Boolean(currentDialog?.());
      const viewShortcuts = ["all", "active", "waiting", "runtime", "terminal", "tmux", "settings"];
      if (!editable && !dialogOpen && (event.metaKey || event.ctrlKey) && /^[1-7]$/.test(event.key)) {
        event.preventDefault();
        selectView(viewShortcuts[Number(event.key) - 1], { focusMain: true });
        return;
      }
      if (!editable && !dialogOpen && event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (state.view !== "all") selectView("all");
        $("#searchInput").focus();
        return;
      }
      if (!editable && !dialogOpen && event.key.toLowerCase() === "n" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        if ($("#runModal").classList.contains("hidden")) openRunModal();
        return;
      }
      if (event.key !== "Escape") return;
      if (!$("#mobileToolsMenu").classList.contains("hidden")) {
        $("#mobileToolsCloseBtn")?.click();
      } else if (!$("#runModal").classList.contains("hidden")) closeRunModal();
      else closeDrawer();
    });
    window.addEventListener("resize", scheduleAgentWorkflowConnections);
  }

  function bindDialogAndGlobalEvents() {
    bindRunComposerEvents();
    bindDrawerAndGlobalEvents();
  }

  return { bindDialogAndGlobalEvents };
};
