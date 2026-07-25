'use strict';

function registerTerminalIpc({ ipcMain, requireTrustedSender, trustedSender, manager, isProviderVisible = () => true, listWslDistros, sendError }) {
  ipcMain.handle('terminals:list', event => {
    requireTrustedSender(event);
    return manager() ? manager().list().filter(session => !session.transient && (session.type !== 'agent' || isProviderVisible(session.provider))) : [];
  });
  ipcMain.handle('wsl:list-distros', event => {
    requireTrustedSender(event);
    return listWslDistros();
  });
  ipcMain.handle('terminals:get', async (event, id) => {
    requireTrustedSender(event);
    const session = manager() ? await manager().get(id, true) : null;
    return session && (session.transient || (session.type === 'agent' && !isProviderVisible(session.provider))) ? null : session;
  });
  ipcMain.handle('terminals:create', (event, options) => {
    requireTrustedSender(event);
    if (options && options.type === 'agent' && !isProviderVisible(options.provider)) throw new Error('설정에서 숨긴 AI는 실행할 수 없습니다.');
    return requireManager(manager).create(options || {});
  });
  ipcMain.handle('terminals:write', (event, id, data) => {
    requireTrustedSender(event);
    return requireManager(manager).write(id, data);
  });
  ipcMain.handle('terminals:command', (event, id, command) => {
    requireTrustedSender(event);
    return requireManager(manager).command(id, command);
  });
  ipcMain.handle('terminals:resize', (event, id, cols, rows) => {
    requireTrustedSender(event);
    return requireManager(manager).resize(id, cols, rows);
  });
  for (const operation of ['signal', 'restart', 'reconnect', 'detach', 'stop', 'close']) {
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
