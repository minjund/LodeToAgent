"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createProviderVisibility = function createProviderVisibility(context = {}) {
  const { state, reportRecoverableError } = context;
  const STORAGE_KEY = "loadtoagent:provider-visibility:v1";
  const USAGE_KEYS = ["input", "cachedInput", "cacheWrite", "output", "reasoning", "total"];

  function loadProviderVisibility(preference = null) {
    try {
      const saved = preference && typeof preference === "object"
        ? preference
        : JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const known = new Set(state.providers.map((provider) => provider.id));
      state.hiddenProviders = new Set((saved.hidden || []).filter((id) => known.has(id)));
    } catch (error) {
      reportRecoverableError("provider-visibility-load", error);
      state.hiddenProviders = new Set();
    }
  }

  function saveProviderVisibility() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ hidden: [...state.hiddenProviders] }));
    } catch (error) {
      reportRecoverableError("provider-visibility-save", error);
    }
  }

  function isProviderVisible(providerId) {
    return !state.hiddenProviders.has(String(providerId || ""));
  }

  function visibleProviders() {
    return state.providers.filter((provider) => isProviderVisible(provider.id));
  }

  function visibleSessions() {
    return (state.snapshot?.sessions || []).filter((session) => isProviderVisible(session.provider));
  }

  function visibleTmux(tmux = (state.rawSnapshot || state.snapshot)?.tmux) {
    if (!tmux) return tmux;
    const projected = {
      ...tmux,
      distros: (tmux.distros || []).map((distro) => ({
        ...distro,
        sessions: (distro.sessions || []).map((tmuxSession) => ({
          ...tmuxSession,
          windows: (tmuxSession.windows || []).map((window) => ({
            ...window,
            panes: (window.panes || []).filter((pane) => (!pane.dead || !pane.agent) && (!pane.agent || isProviderVisible(pane.agent.provider))),
          })).filter((window) => window.panes.length),
        })).filter((tmuxSession) => tmuxSession.windows.length),
      })).filter((distro) => distro.sessions.length),
    };
    const panes = projected.distros.flatMap((distro) =>
      distro.sessions.flatMap((session) => session.windows.flatMap((window) => window.panes)));
    projected.summary = {
      distros: projected.distros.length,
      sessions: projected.distros.reduce((sum, distro) => sum + distro.sessions.length, 0),
      windows: projected.distros.reduce((sum, distro) =>
        sum + distro.sessions.reduce((count, session) => count + session.windows.length, 0), 0),
      panes: panes.length,
      aiPanes: panes.filter((pane) => pane.agent && !pane.dead).length,
      linked: panes.filter((pane) => pane.agent?.linkedSessionId && !pane.dead).length,
    };
    return projected;
  }

  function projectVisibleSnapshot(snapshot = state.rawSnapshot || state.snapshot) {
    if (!snapshot) return snapshot;
    const sessions = (snapshot.sessions || []).filter((session) => isProviderVisible(session.provider));
    const usage = Object.fromEntries(USAGE_KEYS.map((key) => [
      key,
      sessions.reduce((sum, session) => sum + Number(session.usage?.[key] || 0), 0),
    ]));
    return {
      ...snapshot,
      sessions,
      tmux: visibleTmux(snapshot.tmux),
      summary: {
        ...(snapshot.summary || {}),
        providers: (snapshot.summary?.providers || []).filter((provider) => isProviderVisible(provider.id)),
        totals: {
          sessions: sessions.length,
          active: sessions.filter((session) => session.status === "running" || session.status === "starting").length,
          waiting: sessions.filter((session) => session.status === "waiting").length,
          subagents: sessions.filter((session) => session.parentId).length,
          usage,
        },
      },
    };
  }

  function setProviderVisible(providerId, visible) {
    const id = String(providerId || "");
    if (!state.providers.some((provider) => provider.id === id)) return;
    if (visible) state.hiddenProviders.delete(id);
    else state.hiddenProviders.add(id);
    state.providerFilters.delete(id);
    if (!isProviderVisible(state.runProvider)) {
      state.runProvider = visibleProviders().find((provider) => state.availability[provider.id])?.id
        || visibleProviders()[0]?.id
        || "";
    }
    saveProviderVisibility();
    if (state.rawSnapshot) state.snapshot = projectVisibleSnapshot(state.rawSnapshot);
  }

  return {
    PROVIDER_VISIBILITY_STORAGE_KEY: STORAGE_KEY,
    loadProviderVisibility,
    saveProviderVisibility,
    isProviderVisible,
    visibleProviders,
    visibleSessions,
    visibleTmux,
    projectVisibleSnapshot,
    visibleSnapshot: () => projectVisibleSnapshot(),
    setProviderVisible,
  };
};
