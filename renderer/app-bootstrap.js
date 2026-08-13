"use strict";

(() => {
  const factories = window.WhiteboxAppFactories || {};
  const t = (key, params) => window.WhiteboxI18n.t(key, params);
  const app = {};
  const install = (name) => {
    if (typeof factories[name] !== "function") throw new Error(t("bootstrap.module_missing", { name }));
    const additions = factories[name](app) || {};
    const duplicate = Object.keys(additions).find(key => Object.prototype.hasOwnProperty.call(app, key));
    if (duplicate) throw new Error(`Renderer module "${name}" attempted to replace "${duplicate}".`);
    Object.assign(app, additions);
  };

  [
    "createCore",
    "createProviderVisibility",
    "createAttentionPopupSettings",
    "createDashboard",
    "createRuntimeOverview",
    "createGraphModel",
    "createGraphView",
    "createGraphLayout",
    "createGraphOrchestration",
    "createTmuxRenderer",
    "createAgentActions",
    "createManagement",
    "createSessionRenderer",
    "createDrawerData",
    "createDrawerContent",
    "createDrawer",
    "createRunModal",
    "createQualityEnhancements",
    "createNavigationEventBindings",
    "createSessionEventBindings",
    "createFilterEventBindings",
    "createDialogEventBindings",
    "createEventBindings",
  ].forEach(install);
  window.WhiteboxApp = app;

  const { $, esc, state, loadGuideState, loadQualityState = () => {}, saveDashboardPreferences = () => {}, loadProviderVisibility, loadAttentionPopupSettings = () => {}, bindAttentionPopupSettings = () => {}, projectVisibleSnapshot, visibleSnapshot, isProviderVisible, bindEvents, render, timeOnly, loadSessionDetail, renderUpdateSettings, syncViewChrome, selectView, openDrawer, openSubagentConversation, closeDrawer, toast, refreshProviderUsage = async () => null } = app;

  let initializationError = "";
  const setConnectedAt = (value) => {
    const connectionTitle = $("#appConnectionState")?.querySelector("b");
    if (connectionTitle) {
      connectionTitle.removeAttribute("data-i18n");
      const connectedCount = (state.providers || []).filter((provider) => (
        !state.hiddenProviders.has(provider.id) && state.availability?.[provider.id]
      )).length;
      connectionTitle.textContent = t("ui.app_connected", { count: connectedCount });
    }
    const lastSync = $("#lastSync");
    if (lastSync) {
      lastSync.removeAttribute("data-i18n");
      lastSync.textContent = t("ui.connection_checked");
      lastSync.hidden = true;
    }
  };
  const showInitializationError = (message) => {
    initializationError = String(message || t("ui.connection_failed"));
    const connectionTitle = $("#appConnectionState")?.querySelector("b");
    if (connectionTitle) connectionTitle.textContent = t("ui.connection_failed");
    $("#lastSync").hidden = false;
    $("#lastSync").textContent = t("ui.connection_failed");
    $("#appConnectionState")?.classList.add("connection-error");
    $("#appErrorMessage").textContent = initializationError;
    $("#appErrorBanner").classList.remove("hidden");
  };
  $("#appRetryBtn")?.addEventListener("click", () => window.location.reload());
  $("#appErrorCopyBtn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(initializationError);
      toast(t("quality.copy_success"));
    } catch (error) {
      window.WhiteboxRendererUtils.reportRecoverableError("initialization-error-copy", error);
      toast(t("quality.copy_failed"));
    }
  });

  async function init() {
    loadQualityState();
    state.workspace = "all";
    loadGuideState();
    if (!window.whitebox) {
      $("#emptyState").classList.remove("hidden");
      $("#emptyState p").textContent = t("bootstrap.open_in_app");
      showInitializationError(t("bootstrap.open_in_app"));
      return;
    }
    const bootstrap = await window.WhiteboxRendererUtils.bootstrap();
    if (window.whitebox.setLocale) await window.whitebox.setLocale(window.WhiteboxI18n?.getLocale() || "en");
    state.providers = bootstrap.providers || [];
    state.providerMap = new Map(state.providers.map((provider) => [provider.id, provider]));
    loadProviderVisibility(bootstrap.providerVisibility);
    loadAttentionPopupSettings(bootstrap.attentionPopups);
    state.availability = bootstrap.availability || {};
    state.sourcePlugins = bootstrap.sourcePlugins || [];
    state.sourcePluginSettings = bootstrap.sourcePluginSettings || state.sourcePluginSettings;
    state.workspaces = bootstrap.workspaces || [];
    state.rawSnapshot = bootstrap.snapshot;
    state.snapshot = projectVisibleSnapshot(bootstrap.snapshot);
    state.activeRuns = bootstrap.activeRuns || [];
    state.platform = bootstrap.platform || state.platform;
    state.versions = bootstrap.versions || {};
    state.update = bootstrap.update || { status: "idle", currentVersion: state.versions.app || "" };
    const safeAttentionDrawerOptions = {
      createTerminalIfMissing: false,
      mountTerminal: false,
      attentionActivation: true,
      acknowledge: false,
      focus: false,
    };
    const showAttentionSession = (session) => {
      selectView("waiting");
      if (session.parentId) openSubagentConversation(session.id, safeAttentionDrawerOptions);
      else openDrawer(session.id, safeAttentionDrawerOptions);
    };
    const attentionActivation = window.WhiteboxAttentionActivation?.createAttentionActivationController({
      getSessions: () => state.snapshot?.sessions || [],
      isProviderVisible,
      acknowledge: result => window.whitebox.ackAttentionActivation?.(result),
      showSession: showAttentionSession,
      openPty: async (session, activation, operation) => {
        const terminal = window.WhiteboxTerminal;
        if (!terminal?.agentTargets || !terminal?.openForAgent) return { opened: false, retryable: true };
        try {
          if (!operation?.isCurrent?.()) return { opened: false, retryable: true };
          const opened = await terminal.openForAgent(
            session,
            activation.targetId,
            "",
            {
              focus: activation.preservePopupFocus !== true,
              isCurrent: operation.isCurrent,
              attentionActivation: true,
              onTargetReady: target => {
                if (!operation.isCurrent()) return;
                if (activation.terminalId && target?.terminalId !== activation.terminalId) {
                  throw new Error("The requested AI terminal changed before it could be opened.");
                }
                if ($("#detailDrawer")?.classList.contains("open")) closeDrawer?.(false);
                selectView("terminal");
              },
            },
          );
          if (!operation.isCurrent()) return { opened: false, retryable: true };
          if (activation.terminalId && opened?.terminalId !== activation.terminalId) {
            throw new Error("The requested AI terminal changed before it could be opened.");
          }
          document.querySelector(".main-stage")?.scrollTo({ top: 0, behavior: "auto" });
          return { opened: true, retryable: false };
        } catch (error) {
          if (!["DELIVERY_REJECTED", "ATTENTION_ACTIVATION_CANCELLED"].includes(error?.code)) {
            window.WhiteboxRendererUtils.reportRecoverableError("attention-activation-open-pty", error);
          }
          const refreshedTargets = terminal.agentTargets(session);
          return {
            opened: false,
            retryable: Boolean(activation.targetId || activation.terminalId || refreshedTargets.length === 0),
          };
        }
      },
      onError: (scope, error) => window.WhiteboxRendererUtils.reportRecoverableError(scope, error),
    });
    const handleAttentionRequested = (payload) => {
      if (payload?.activationId && attentionActivation) {
        attentionActivation.handle(payload);
        return;
      }
      const sessionId = String(payload && payload.sessionId || '');
      const event = payload?.event === 'completed' ? 'completed' : payload?.event === 'terminal' ? 'terminal' : 'attention';
      const session = (state.snapshot && state.snapshot.sessions || []).find(item => item.id === sessionId);
      if (session && !session.sourcePluginId && !isProviderVisible(session.provider)) return;
      if (event === 'terminal') {
        if (!session) {
          toast(t('bootstrap.opened_attention_list'));
          return;
        }
        const terminal = window.WhiteboxTerminal;
        if (session.parentId || session.sourcePluginId || session.controlCapabilities?.pty === false
          || session.presentation?.conversationSurface === 'transcript'
          || !terminal?.openForAgent) {
          showAttentionSession(session);
          return;
        }
        Promise.resolve(terminal.openForAgent(session, '', '', {
          focus: true,
          attentionActivation: true,
          onTargetReady: () => {
            if ($('#detailDrawer')?.classList.contains('open')) closeDrawer?.(false);
            selectView('terminal');
          },
        })).catch(error => {
          window.WhiteboxRendererUtils.reportRecoverableError('attention-popup-open-terminal', error);
          showAttentionSession(session);
          toast(window.WhiteboxI18n.errorText(error, 'agent.open_terminal_failed'));
        });
        return;
      }
      selectView(event === 'completed' ? 'active' : 'waiting');
      if (session) {
        const options = event === 'attention' ? safeAttentionDrawerOptions : {};
        if (session.parentId) openSubagentConversation(session.id, options);
        else openDrawer(session.id, options);
      } else toast(t("bootstrap.opened_attention_list"));
    };
    const handleTerminalPromptResolved = (payload) => {
      const resolution = window.WhiteboxTerminal?.resolveAttentionPrompt?.(payload);
      if (!resolution?.ok || !resolution.requiresText) return;
      const session = (state.snapshot?.sessions || []).find(item => item.id === resolution.sessionId);
      if (!session || session.parentId || !isProviderVisible(session.provider)) return;
      selectView("terminal");
      Promise.resolve(window.WhiteboxTerminal.openForAgent(session, resolution.targetId)).catch(error => {
        window.WhiteboxRendererUtils.reportRecoverableError("terminal-prompt-follow-up-focus", error);
        toast(window.WhiteboxI18n.errorText(error, "agent.open_terminal_failed"));
      });
    };
    if (window.whitebox.onAttentionRequested) window.whitebox.onAttentionRequested(handleAttentionRequested);
    if (window.whitebox.onTerminalPromptResolved) window.whitebox.onTerminalPromptResolved(handleTerminalPromptResolved);
    if (window.whitebox.onMonitorError) window.whitebox.onMonitorError((message) => {
      const detail = String(message || t("ui.connection_failed"));
      showInitializationError(detail);
      toast(detail);
    });
    bindAttentionPopupSettings();
    bindEvents();
    render();
    refreshProviderUsage().catch(error => {
      window.WhiteboxRendererUtils.reportRecoverableError("provider-usage-refresh", error);
    });
    saveDashboardPreferences();
    $("#appConnectionState")?.classList.remove("connection-error");
    $("#appErrorBanner").classList.add("hidden");
    app.initialized = true;
    setConnectedAt(state.snapshot && state.snapshot.generatedAt);
    let snapshotRenderFrame = 0;
    let latestSnapshot = null;
    window.whitebox.onSnapshot((snapshot) => {
      state.rawSnapshot = snapshot;
      state.snapshot = projectVisibleSnapshot(snapshot);
      attentionActivation?.retry();
      if (Array.isArray(snapshot.sourcePlugins)) state.sourcePlugins = snapshot.sourcePlugins;
      if (window.WhiteboxTerminal) window.WhiteboxTerminal.updateSnapshot(visibleSnapshot(), state.workspaces);
      setConnectedAt(snapshot.generatedAt);
      latestSnapshot = snapshot;
      if (snapshotRenderFrame) return;
      snapshotRenderFrame = requestAnimationFrame(() => {
        snapshotRenderFrame = 0;
        const renderedSnapshot = latestSnapshot;
        render();
        saveDashboardPreferences();
        if (state.selectedId && $("#detailDrawer").classList.contains("open")) {
          const card = (renderedSnapshot.sessions || []).find((session) => session.id === state.selectedId);
          const detail = state.details.get(state.selectedId);
          // Queue a follow-up even during the very first full-history read.
          // With no cached detail yet, a newer snapshot is still evidence that
          // the in-flight response can be stale.
          if (card && (!detail || card.updatedAt !== detail.updatedAt)) {
            loadSessionDetail(state.selectedId, true, card.updatedAt);
          }
        }
      });
    });
    window.addEventListener("whitebox:terminal-inventory-changed", () => attentionActivation?.retry());
    window.addEventListener("whitebox:terminal-manual-selection", () => attentionActivation?.userNavigated());
    if (window.whitebox.rendererReady) await window.whitebox.rendererReady();
    if (window.whitebox.onUpdateState)
      window.whitebox.onUpdateState((update) => {
        state.update = update;
        renderUpdateSettings();
      });
  }

  app.init = init;

  window.addEventListener("whitebox:locale-changed", (event) => {
    if (window.whitebox?.setLocale) {
      Promise.resolve(window.whitebox.setLocale(event.detail.locale)).catch((error) => {
        window.WhiteboxRendererUtils.reportRecoverableError("locale-persistence", error);
      });
    }
    if (!state.snapshot) {
      syncViewChrome();
      return;
    }
    render("locale");
    setConnectedAt(state.snapshot.generatedAt);
  });

  window.addEventListener("whitebox:terminal-prompts-changed", () => {
    if (!state.snapshot || state.view === "terminal" || state.view === "tmux") return;
    render("terminal-prompt");
  });

  init().catch((error) => {
    console.error(error);
    const message = t("bootstrap.initialization_failed", { message: window.WhiteboxI18n.errorText(error, "ui.connection_failed") });
    showInitializationError(message);
    toast(message);
  });
})();
