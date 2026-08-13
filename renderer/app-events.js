"use strict";

window.WhiteboxAppFactories = window.WhiteboxAppFactories || {};

window.WhiteboxAppFactories.createEventBindings = function createEventBindings(context = {}) {
  const { bindNavigationAndUpdateEvents, bindSessionAndAgentEvents, bindFilterAndWorkspaceEvents, bindDialogAndGlobalEvents, bindQualityEvents = () => {} } = context;

  function bindEvents() {
    bindNavigationAndUpdateEvents();
    bindSessionAndAgentEvents();
    bindFilterAndWorkspaceEvents();
    bindDialogAndGlobalEvents();
    bindQualityEvents();
  }

  return { bindEvents };
};
