'use strict';

function registerTerminalIpc({ ipcMain, requireTrustedSender, trustedSender, manager, isProviderVisible = () => true, listWslDistros, sendError }) {
  ipcMain.handle('terminals:list', event => {
    requireTrustedSender(event);
    return manager() ? manager().list().filter(session => session.type !== 'agent' || isProviderVisible(session.provider)) : [];
  });
  ipcMain.handle('wsl:list-distros', event => {
    requireTrustedSender(event);
    return listWslDistros();
  });
  ipcMain.handle('terminals:get', (event, id) => {
    requireTrustedSender(event);
    const session = manager() ? manager().get(id, true) : null;
    return session && session.type === 'agent' && !isProviderVisible(session.provider) ? null : session;
  });
  ipcMain.handle('terminals:create', (event, options) => {
    requireTrustedSender(event);
    if (options && options.type === 'agent' && !isProviderVisible(options.provider)) throw new Error('설정에서 숨긴 AI는 실행할 수 없습니다.');
    return requireManager(manager).create(options || {});
  });
  ipcMain.on('terminals:write', (event, id, data) => {
    if (!trustedSender(event) || !manager()) return;
    try { manager().write(id, data); } catch (error) { sendError({ id: String(id || ''), message: error.message }); }
  });
  ipcMain.handle('terminals:command', (event, id, command) => {
    requireTrustedSender(event);
    return requireManager(manager).command(id, command);
  });
  ipcMain.on('terminals:resize', (event, id, cols, rows) => {
    if (!trustedSender(event) || !manager()) return;
    try {
      manager().resize(id, cols, rows);
    } catch (error) {
      sendError({ id: String(id || ''), message: error.message });
    }
  });
  for (const operation of ['signal', 'restart', 'close']) {
    ipcMain.handle(`terminals:${operation}`, (event, ...args) => {
      requireTrustedSender(event);
      return requireManager(manager)[operation](...args);
    });
  }
}

function requireManager(getManager) {
  const terminalManager = getManager();
  if (!terminalManager) throw new Error('터미널 관리자가 준비되지 않았습니다.');
  return terminalManager;
}

module.exports = { registerTerminalIpc };
