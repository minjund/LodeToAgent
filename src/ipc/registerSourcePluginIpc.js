'use strict';

function registerSourcePluginIpc(options) {
  const { handleTrusted, host, resolveSession, pickAsideHistoryFolder, removeAsideHistoryFolder } = options;
  handleTrusted('sources:list', () => host().listSources());
  handleTrusted('sources:refresh', () => host().refresh());
  handleTrusted('sources:start', (pluginId, input) => host().start(String(pluginId || ''), input || {}));
  handleTrusted('sources:prepare-delete', sessionId => {
    const session = resolveSession(String(sessionId || ''));
    return host().prepareDelete(session);
  });
  handleTrusted('sources:control', (sessionId, action, input) => {
    const session = resolveSession(String(sessionId || ''));
    return host().control(session, String(action || ''), input || {});
  });
  handleTrusted('sources:pick-history-folder', () => pickAsideHistoryFolder());
  handleTrusted('sources:remove-history-folder', folder => removeAsideHistoryFolder(String(folder || '')));
}

module.exports = { registerSourcePluginIpc };
