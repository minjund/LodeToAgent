"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDialogEventBindings = function createDialogEventBindings(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, $$, state, providerInfo, visibleProviders = () => state.providers, renderProviderRail, scheduleAgentWorkflowConnections, resumeAgentTerminal, loadSessionDetail,
    closeDrawer, renderDrawer, providerPickerHtml, syncRunComposer, openRunModal, closeRunModal, toast, performUiAction,
    handleRun, trapDialogFocus,
  } = context;

  function bindRunComposerEvents() {
    $("#newRunBtn").addEventListener("click", openRunModal);
    $$("[data-open-run]").forEach((button) => button.addEventListener("click", openRunModal));
    $("#closeRunModalBtn").addEventListener("click", closeRunModal);
    $("#cancelRunBtn").addEventListener("click", closeRunModal);
    $("#runModal").addEventListener("click", (event) => {
      if (event.target === $("#runModal")) closeRunModal();
    });
    $("#runProviderPicker").addEventListener("click", (event) => {
      const button = event.target.closest("[data-run-provider]");
      if (!button || button.disabled) return;
      state.runProvider = button.dataset.runProvider;
      $("#runProviderPicker").innerHTML = providerPickerHtml();
      syncRunComposer();
    });
    $("#runProviderHelp").addEventListener("click", async (event) => {
      const docs = event.target.closest("[data-provider-docs]");
      if (docs) {
        const provider = providerInfo(docs.dataset.providerDocs);
        if (provider.docs)
          await performUiAction(async () => {
            const result = await window.loadtoagent.openExternal(provider.docs);
            if (!result || result.ok === false) throw new Error(t("run.docs_open_failed"));
          }, t("run.docs_open_failed"));
        return;
      }
      if (event.target.closest("[data-provider-recheck]")) {
        const nextAvailability = await performUiAction(() => window.loadtoagent.probeProviders(), t("run.cli_check_failed"));
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
      input.focus();
    });
    $("#runWorkspaceSuggestions").addEventListener("click", (event) => {
      const workspace = event.target.closest("[data-run-workspace]");
      if (!workspace) return;
      $("#runCwd").value = workspace.dataset.runWorkspace;
      syncRunComposer();
    });
    $("#runCwd").addEventListener("input", syncRunComposer);
    $("#allowWrites").addEventListener("change", syncRunComposer);
    $("#pickRunCwdBtn").addEventListener("click", async () => {
      const folder = await performUiAction(() => window.loadtoagent.pickWorkspace(), t("workspace.pick_failed"));
      if (folder) {
        $("#runCwd").value = folder;
        syncRunComposer();
      }
    });
    $("#runForm").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        $("#runForm").requestSubmit();
      }
    });
    $("#runForm").addEventListener("submit", handleRun);
  }

  function bindDrawerAndGlobalEvents() {
    $("#closeDrawerBtn").addEventListener("click", closeDrawer);
    $("#drawerBackdrop").addEventListener("click", closeDrawer);
    $(".drawer-tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tab]");
      if (tab) {
        state.drawerTab = tab.dataset.tab;
        state.drawerForceLatest = tab.dataset.tab === "chat";
        renderDrawer();
      }
    });
    $(".drawer-tabs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = $$(".drawer-tab:not(.hidden)");
      const current = Math.max(0, tabs.indexOf(event.target.closest(".drawer-tab")));
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      state.drawerTab = tabs[next].dataset.tab;
      state.drawerForceLatest = state.drawerTab === "chat";
      renderDrawer();
      $(`.drawer-tab[data-tab="${state.drawerTab}"]`)?.focus();
    });
    $("#detailDrawer").addEventListener("click", async (event) => {
      const resume = event.target.closest("[data-resume-agent]");
      if (resume) {
        await resumeAgentTerminal(resume.dataset.resumeAgent);
        return;
      }
      const retry = event.target.closest("[data-retry-detail]");
      if (retry) {
        loadSessionDetail(retry.dataset.retryDetail, true);
        return;
      }
      const latest = event.target.closest("[data-scroll-latest]");
      if (latest) {
        const content = $("#drawerContent");
        content.scrollTo({ top: content.scrollHeight, behavior: "smooth" });
        return;
      }
      const stop = event.target.closest("[data-stop-run]");
      if (!stop) return;
      const runId = stop.dataset.stopRun;
      if (state.stopRequests.has(runId)) return;
      state.stopRequests.add(runId);
      renderDrawer();
      try {
        const result = await window.loadtoagent.stopAgent(runId);
        toast(result.ok ? window.LoadToAgentI18n.t("ui.stop_request_sent") : result.error);
      } catch (error) {
        toast(window.LoadToAgentI18n.errorText(error, "ui.could_not_send_the_stop_request"));
      } finally {
        state.stopRequests.delete(runId);
        if (state.selectedId) renderDrawer();
      }
    });
    document.addEventListener("keydown", (event) => {
      trapDialogFocus(event);
      if (event.key.toLowerCase() === "n" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        if ($("#runModal").classList.contains("hidden")) openRunModal();
        return;
      }
      if (event.key !== "Escape") return;
      if (!$("#mobileToolsMenu").classList.contains("hidden")) {
        $("#mobileToolsMenu").classList.add("hidden");
        $("#mobileMoreBtn").setAttribute("aria-expanded", "false");
        $("#mobileMoreBtn").focus();
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
