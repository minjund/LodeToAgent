"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawerData = function createDrawerData(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const { reportRecoverableError, state } = context;

  async function loadSessionDetail(id, force = false) {
    if (!force && state.details.has(id)) return state.details.get(id);
    state.detailErrors.delete(id);
    state.detailLoadingIds.add(id);
    context.renderDrawer();
    try {
      const detail = await window.loadtoagent.sessionDetail(id);
      if (detail) state.details.set(id, detail);
      return detail;
    } catch (error) {
      state.detailErrors.set(id, window.LoadToAgentI18n.errorText(error, "drawer.history_failed"));
      return null;
    } finally {
      state.detailLoadingIds.delete(id);
      if (state.selectedId === id) {
        state.drawerForceLatest = state.drawerTab === "chat";
        context.renderDrawer();
      }
    }
  }

  async function loadSubagentParentDetail(child) {
    if (!child || !child.parentId || state.details.has(child.parentId)) return;
    try {
      const detail = await window.loadtoagent.sessionDetail(child.parentId);
      if (detail) state.details.set(child.parentId, detail);
      if (state.drawerMode === "subagent" && state.selectedId === child.id) context.renderDrawer();
    } catch (error) {
      reportRecoverableError("subagent-parent-detail", error);
    }
  }

  return { loadSessionDetail, loadSubagentParentDetail };
};
