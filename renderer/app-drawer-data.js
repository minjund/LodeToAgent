"use strict";

window.LoadToAgentAppFactories = window.LoadToAgentAppFactories || {};

window.LoadToAgentAppFactories.createDrawerData = function createDrawerData(context = {}) {
  const t = (key, params) => window.LoadToAgentI18n.t(key, params);
  const { reportRecoverableError, state } = context;
  const detailRequests = new Map();
  let detailRequestGeneration = 0;

  async function loadSessionDetail(id, force = false) {
    if (!force && state.details.has(id)) return state.details.get(id);
    if (!force && detailRequests.has(id)) return detailRequests.get(id).promise;
    const generation = ++detailRequestGeneration;
    state.detailErrors.delete(id);
    state.detailLoadingIds.add(id);
    context.renderDrawer();
    const promise = (async () => {
      try {
        const detail = await window.loadtoagent.sessionDetail(id);
        if (detailRequests.get(id)?.generation === generation && detail) state.details.set(id, detail);
        return detail;
      } catch (error) {
        if (detailRequests.get(id)?.generation === generation)
          state.detailErrors.set(id, window.LoadToAgentI18n.errorText(error, "drawer.history_failed"));
        return null;
      } finally {
        if (detailRequests.get(id)?.generation === generation) {
          detailRequests.delete(id);
          state.detailLoadingIds.delete(id);
          if (state.selectedId === id) {
            state.drawerForceLatest = state.drawerTab === "chat";
            context.renderDrawer();
          }
        }
      }
    })();
    detailRequests.set(id, { generation, promise });
    return promise;
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
