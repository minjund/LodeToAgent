"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDialogEventBindings = function createDialogEventBindings(context = {}) {
  const CONTEXT_DRAWER_MIN_WIDTH = 1680;
  const CONTEXT_WORKSPACE_MIN_WIDTH = 960;
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const {
    $, $$, state, motionState, providerInfo, visibleProviders = () => state.providers, renderProviderRail, scheduleAgentWorkflowConnections, resumeAgentTerminal, loadSessionDetail,
    closeDrawer, backToAgentFlow, renderDrawer, providerPickerHtml, syncRunComposer, openRunModal, closeRunModal, toast, performUiAction,
    handleRun, trapDialogFocus, currentDialog, selectView, saveRunDraft = () => {}, safeBackdrop = null,
    rememberDialogTrigger = () => {}, restoreDialogTrigger = () => {}, setDialogOpenState = () => {},
    copyText = async () => false,
    dispatchAgentCommand, interruptConversation, openAgentTerminal, controlManagedRun, quickRespond, prepareReassignment, openSubagentConversation,
    resetAgentSession = async () => {},
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
    let pendingSessionResetId = "";
    let resetDialogGeneration = 0;
    const conversationSlashStates = new Map();
    const conversationSlashState = input => {
      const sessionId = input?.dataset.agentCommandDraft || "";
      if (!conversationSlashStates.has(sessionId)) {
        conversationSlashStates.set(sessionId, {
          activeIndex: 0,
          dismissedValue: "",
          filtered: [],
          open: false,
        });
      }
      return conversationSlashStates.get(sessionId);
    };
    const setConversationSlashOpen = (input, next) => {
      const slashState = conversationSlashState(input);
      const form = input?.closest("[data-agent-command-routing='conversation']");
      const menu = form?.querySelector("[data-conversation-slash-menu]");
      slashState.open = Boolean(next && menu && input && !input.disabled);
      menu?.classList.toggle("hidden", !slashState.open);
      input?.setAttribute("aria-expanded", slashState.open ? "true" : "false");
      if (!slashState.open) input?.removeAttribute("aria-activedescendant");
    };
    const syncConversationSlashOption = input => {
      const slashState = conversationSlashState(input);
      const options = Array.from(input?.closest("form")?.querySelectorAll("[data-conversation-slash-command]") || []);
      if (!options.length) {
        input?.removeAttribute("aria-activedescendant");
        return;
      }
      slashState.activeIndex = Math.max(0, Math.min(slashState.activeIndex, options.length - 1));
      options.forEach((option, index) => {
        const selected = index === slashState.activeIndex;
        option.classList.toggle("active", selected);
        option.setAttribute("aria-selected", selected ? "true" : "false");
      });
      input?.setAttribute("aria-activedescendant", options[slashState.activeIndex].id);
      options[slashState.activeIndex]?.scrollIntoView({ block: "nearest" });
    };
    const renderConversationSlashMenu = (input, query) => {
      const composer = window.LoadToAgentTerminalComposer;
      const form = input?.closest("[data-agent-command-routing='conversation']");
      const list = form?.querySelector("[data-conversation-slash-list]");
      const title = form?.querySelector("[data-conversation-slash-title]");
      const status = form?.querySelector("[data-conversation-slash-status]");
      if (!composer || !form || !list || !title || !status) return false;
      const slashState = conversationSlashState(input);
      const provider = form.dataset.agentCommandProvider || "";
      const providerLabel = providerInfo(provider).label;
      slashState.filtered = composer.filterCommands(provider, query);
      slashState.activeIndex = Math.max(0, Math.min(slashState.activeIndex, slashState.filtered.length - 1));
      title.textContent = t("terminal.slash.title", { provider: providerLabel });
      status.textContent = t("terminal.slash.result_count", { count: slashState.filtered.length });
      list.replaceChildren();
      if (!slashState.filtered.length) {
        const empty = document.createElement("div");
        empty.className = "conversation-slash-empty";
        empty.textContent = t("terminal.slash.no_results");
        list.append(empty);
        return true;
      }
      slashState.filtered.forEach((command, index) => {
        const option = document.createElement("button");
        const token = document.createElement("span");
        const description = document.createElement("span");
        const key = document.createElement("kbd");
        option.id = `${form.querySelector("[data-conversation-slash-menu]").id}-option-${index}`;
        option.type = "button";
        option.tabIndex = -1;
        option.dataset.conversationSlashCommand = command.value;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", index === slashState.activeIndex ? "true" : "false");
        token.className = "conversation-slash-command-token";
        token.textContent = command.value;
        description.className = "conversation-slash-command-description";
        description.textContent = t(command.descriptionKey);
        key.setAttribute("aria-hidden", "true");
        key.textContent = "↵";
        option.append(token, description, key);
        list.append(option);
      });
      return true;
    };
    const syncConversationSlashMenu = (input, options = {}) => {
      const form = input?.closest("[data-agent-command-routing='conversation']");
      const composer = window.LoadToAgentTerminalComposer;
      if (!form || !composer || input.disabled) {
        if (input) setConversationSlashOpen(input, false);
        return;
      }
      const slashState = conversationSlashState(input);
      if (input.value !== slashState.dismissedValue) slashState.dismissedValue = "";
      const query = composer.slashQuery(input.value, input.selectionStart);
      if (query == null || (!options.force && slashState.dismissedValue === input.value)) {
        setConversationSlashOpen(input, false);
        return;
      }
      if (!renderConversationSlashMenu(input, query)) return;
      setConversationSlashOpen(input, true);
      syncConversationSlashOption(input);
    };
    const closeConversationSlashMenu = (input, dismiss = true) => {
      const slashState = conversationSlashState(input);
      if (dismiss) slashState.dismissedValue = input?.value || "";
      setConversationSlashOpen(input, false);
    };
    const selectConversationSlashCommand = (input, commandValue = "") => {
      const slashState = conversationSlashState(input);
      const command = commandValue
        ? slashState.filtered.find(item => item.value === commandValue)
        : slashState.filtered[slashState.activeIndex];
      if (!input || !command) return false;
      input.value = command.value;
      slashState.dismissedValue = command.value;
      setConversationSlashOpen(input, false);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      window.LoadToAgentA11y?.announce(t("terminal.slash.selected", { command: command.value }));
      return true;
    };
    const handleConversationSlashKeydown = (event, input) => {
      const slashState = conversationSlashState(input);
      if (!slashState.open) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        closeConversationSlashMenu(input);
        return true;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (!slashState.filtered.length) return true;
        if (event.key === "Home") slashState.activeIndex = 0;
        else if (event.key === "End") slashState.activeIndex = slashState.filtered.length - 1;
        else slashState.activeIndex = (
          slashState.activeIndex + (event.key === "ArrowDown" ? 1 : -1) + slashState.filtered.length
        ) % slashState.filtered.length;
        syncConversationSlashOption(input);
        return true;
      }
      if (!["Enter", "Tab"].includes(event.key) || !slashState.filtered.length || event.isComposing || event.keyCode === 229) {
        return false;
      }
      const selected = slashState.filtered[slashState.activeIndex];
      if (event.key === "Enter" && input.value === selected?.value) {
        closeConversationSlashMenu(input);
        return false;
      }
      event.preventDefault();
      selectConversationSlashCommand(input);
      return true;
    };
    const closeSessionResetDialog = (restoreFocus = true) => {
      const modal = $("#sessionResetModal");
      if (!modal || modal.classList.contains("hidden")) return;
      modal.classList.add("hidden");
      setDialogOpenState(modal, false);
      pendingSessionResetId = "";
      const drawer = $("#detailDrawer");
      if (drawer?.classList.contains("open")) drawer.removeAttribute("inert");
      if (restoreFocus) restoreDialogTrigger(resetDialogGeneration);
    };
    const openSessionResetDialog = sessionId => {
      const modal = $("#sessionResetModal");
      if (!modal) return;
      pendingSessionResetId = sessionId;
      rememberDialogTrigger();
      resetDialogGeneration = motionState?.dialogGeneration || 0;
      modal.classList.remove("hidden");
      $("#detailDrawer")?.setAttribute("inert", "");
      setDialogOpenState(modal, true);
      requestAnimationFrame(() => $("#cancelSessionResetBtn")?.focus({ preventScroll: true }));
    };
    $("#cancelSessionResetBtn")?.addEventListener("click", () => closeSessionResetDialog());
    $("#sessionResetModal")?.addEventListener("click", event => {
      if (event.target === $("#sessionResetModal")) closeSessionResetDialog();
    });
    $("#confirmSessionResetBtn")?.addEventListener("click", async () => {
      if (!pendingSessionResetId) return;
      const sessionId = pendingSessionResetId;
      const confirmButton = $("#confirmSessionResetBtn");
      confirmButton.disabled = true;
      confirmButton.setAttribute("aria-busy", "true");
      confirmButton.textContent = t("session.reset_busy");
      try {
        await resetAgentSession(sessionId);
        closeSessionResetDialog(false);
      } finally {
        confirmButton.disabled = false;
        confirmButton.removeAttribute("aria-busy");
        confirmButton.textContent = t("session.reset_action");
      }
    });
    $("#closeDrawerBtn").addEventListener("click", closeDrawer);
    $("#drawerBackToFlowBtn").addEventListener("click", backToAgentFlow);
    if (safeBackdrop) safeBackdrop($("#drawerBackdrop"), closeDrawer, $("#detailDrawer"));
    else $("#drawerBackdrop").addEventListener("click", closeDrawer);
    const resizeHandle = $("#drawerResizeHandle");
    const setConversationPanelWidth = (nextWidth) => {
      const maximum = Math.max(560, Math.min(860, window.innerWidth - CONTEXT_WORKSPACE_MIN_WIDTH));
      const width = Math.max(560, Math.min(maximum, Math.round(nextWidth)));
      document.documentElement.style.setProperty("--conversation-panel-width", `${width}px`);
      resizeHandle.setAttribute("aria-valuemax", String(maximum));
      resizeHandle.setAttribute("aria-valuenow", String(width));
      scheduleAgentWorkflowConnections();
    };
    resizeHandle.addEventListener("pointerdown", (event) => {
      if (state.drawerPresentation !== "context" || event.button !== 0) return;
      event.preventDefault();
      resizeHandle.setPointerCapture?.(event.pointerId);
      document.body.classList.add("conversation-panel-resizing");
      setConversationPanelWidth(window.innerWidth - event.clientX);
    });
    resizeHandle.addEventListener("pointermove", (event) => {
      if (!document.body.classList.contains("conversation-panel-resizing")) return;
      setConversationPanelWidth(window.innerWidth - event.clientX);
    });
    const finishPanelResize = (event) => {
      if (!document.body.classList.contains("conversation-panel-resizing")) return;
      document.body.classList.remove("conversation-panel-resizing");
      try { resizeHandle.releasePointerCapture?.(event.pointerId); } catch {}
      scheduleAgentWorkflowConnections();
    };
    resizeHandle.addEventListener("pointerup", finishPanelResize);
    resizeHandle.addEventListener("pointercancel", finishPanelResize);
    resizeHandle.addEventListener("keydown", (event) => {
      if (state.drawerPresentation !== "context" || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--conversation-panel-width"))
        || $("#detailDrawer").getBoundingClientRect().width;
      const next = event.key === "Home"
        ? 560
        : event.key === "End"
          ? 860
          : current + (event.key === "ArrowLeft" ? 32 : -32);
      setConversationPanelWidth(next);
    });
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
      const expandedReaderClose = event.target.closest("[data-close-expanded-reader]");
      if (expandedReaderClose) {
        closeDrawer();
        return;
      }
      const slashCommand = event.target.closest("[data-conversation-slash-command]");
      if (slashCommand) {
        const input = slashCommand.closest("form")?.querySelector("[data-agent-command-draft]");
        selectConversationSlashCommand(input, slashCommand.dataset.conversationSlashCommand);
        return;
      }
      const subagent = event.target.closest("[data-open-subagent-chat]");
      if (subagent) {
        openSubagentConversation(subagent.dataset.openSubagentChat, { presentation: state.drawerPresentation });
        return;
      }
      const copy = event.target.closest("[data-copy-text]");
      if (copy) {
        await copyText(copy.dataset.copyText);
        return;
      }
      const reset = event.target.closest("[data-session-reset]");
      if (reset) {
        reset.focus({ preventScroll: true });
        openSessionResetDialog(reset.dataset.sessionReset);
        return;
      }
      const promptToggle = event.target.closest("[data-prompt-toggle]");
      if (promptToggle) {
        const promptKey = promptToggle.dataset.promptToggle;
        const expanded = promptToggle.getAttribute("aria-expanded") === "true";
        if (expanded) state.expandedConversationPrompts.delete(promptKey);
        else {
          state.expandedConversationPrompts.clear();
          state.expandedConversationPrompts.add(promptKey);
        }
        renderDrawer();
        requestAnimationFrame(() => {
          const prompt = $("#detailDrawer")?.querySelector(`[data-user-prompt="${CSS.escape(promptKey)}"]`);
          if (!expanded) prompt?.scrollIntoView({ block: "start", behavior: "auto" });
          prompt?.querySelector(`[data-prompt-toggle="${CSS.escape(promptKey)}"]`)?.focus({ preventScroll: true });
        });
        return;
      }
      const terminal = event.target.closest("[data-agent-terminal-open]");
      if (terminal) {
        await openAgentTerminal(terminal.dataset.agentTerminalOpen);
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
      const interrupt = event.target.closest("[data-conversation-interrupt]");
      if (interrupt) {
        await interruptConversation(interrupt.dataset.conversationInterrupt);
        return;
      }
      const stop = event.target.closest("[data-stop-run]");
      if (stop) await controlManagedRun(state.selectedId, "stop");
    });
    $("#detailDrawer").addEventListener("input", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (input) {
        state.agentCommandDrafts.set(input.dataset.agentCommandDraft, input.value);
        const form = input.closest("form");
        const counter = form?.querySelector("[data-agent-command-count]");
        if (counter) counter.textContent = t("agent.input_count", { count: input.value.length.toLocaleString() });
        const progressiveCount = form?.querySelector("[data-conversation-draft-count]");
        if (progressiveCount) {
          progressiveCount.textContent = t("agent.input_count", { count: input.value.length.toLocaleString() });
          progressiveCount.classList.toggle("hidden", input.value.length < 7200);
          progressiveCount.classList.toggle("limit-near", input.value.length >= 7800);
        }
        const conversationSend = form?.querySelector(".conversation-send");
        if (conversationSend && !conversationSend.matches('[aria-busy="true"]')) {
          conversationSend.disabled = form.dataset.agentSendAvailable !== "true" || !input.value.trim();
        }
        syncConversationSlashMenu(input);
      }
    });
    $("#detailDrawer").addEventListener("change", (event) => {
      const picker = event.target.closest("[data-agent-command-target]");
      if (!picker) return;
      if (picker.value) state.agentCommandTargets.set(picker.dataset.agentCommandTarget, picker.value);
      else state.agentCommandTargets.delete(picker.dataset.agentCommandTarget);
      picker.closest("form")?.querySelectorAll("[data-agent-terminal-open], button[type='submit']").forEach(button => { button.disabled = !picker.value; });
    });
    $("#detailDrawer").addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-agent-command-draft]");
      if (!input || handleConversationSlashKeydown(event, input)) return;
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (!input.value.trim()) return;
      input.closest("form")?.requestSubmit();
    });
    $("#detailDrawer").addEventListener("focusout", (event) => {
      const input = event.target.closest("[data-agent-command-routing='conversation'] [data-agent-command-draft]");
      if (!input) return;
      setTimeout(() => {
        if (!input.closest("form")?.contains(document.activeElement)) closeConversationSlashMenu(input);
      }, 0);
    });
    $("#detailDrawer").addEventListener("submit", async (event) => {
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
        if (state.view !== "active") selectView("active");
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
      } else if (!$("#sessionResetModal")?.classList.contains("hidden")) {
        closeSessionResetDialog();
      } else if (!$("#runModal").classList.contains("hidden")) closeRunModal();
      else closeDrawer();
    });
    window.addEventListener("resize", () => {
      scheduleAgentWorkflowConnections();
      if (window.innerWidth < CONTEXT_DRAWER_MIN_WIDTH && state.drawerPresentation === "context") closeDrawer(false);
    });
  }

  function bindDialogAndGlobalEvents() {
    bindRunComposerEvents();
    bindDrawerAndGlobalEvents();
  }

  return { bindDialogAndGlobalEvents };
};
