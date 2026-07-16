'use strict';

function registerAppIpc({ handleTrusted, bootstrap, backgroundState, show, setLocale, setProviderVisibility, updateManager }) {
  handleTrusted('app:bootstrap', bootstrap);
  handleTrusted('app:background-state', backgroundState);
  handleTrusted('app:show', show);
  handleTrusted('app:set-locale', setLocale);
  handleTrusted('app:set-provider-visibility', setProviderVisibility);
  handleTrusted('app:update-check', () => requireUpdateManager(updateManager).check());
  handleTrusted('app:update-download', () => requireUpdateManager(updateManager).download());
  handleTrusted('app:update-open', () => requireUpdateManager(updateManager).openDownloaded());
  handleTrusted('app:update-open-release', () => requireUpdateManager(updateManager).openReleasePage());
}

function requireUpdateManager(getUpdateManager) {
  const manager = getUpdateManager();
  if (!manager) throw new Error('업데이트 관리자가 준비되지 않았습니다.');
  return manager;
}

module.exports = { registerAppIpc };
