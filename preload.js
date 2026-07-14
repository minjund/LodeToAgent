'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lodestar', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  snapshot: () => ipcRenderer.invoke('agents:snapshot'),
  sessionDetail: sessionId => ipcRenderer.invoke('agents:detail', sessionId),
  runAgent: options => ipcRenderer.invoke('agents:run', options),
  stopAgent: runId => ipcRenderer.invoke('agents:stop', runId),
  activeRuns: () => ipcRenderer.invoke('agents:active-runs'),
  probeProviders: () => ipcRenderer.invoke('providers:probe'),
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  addWorkspaces: () => ipcRenderer.invoke('workspaces:add'),
  removeWorkspace: folder => ipcRenderer.invoke('workspaces:remove', folder),
  pickWorkspace: () => ipcRenderer.invoke('workspaces:pick'),
  openExternal: url => ipcRenderer.invoke('external:open', url),
  openSessionOrigin: session => ipcRenderer.invoke('agents:open-origin', session),
  writeClipboard: value => ipcRenderer.invoke('clipboard:write', value),
  bridgeCommand: provider => ipcRenderer.invoke('bridge:command', provider),
  terminalList: () => ipcRenderer.invoke('terminals:list'),
  wslDistros: () => ipcRenderer.invoke('wsl:list-distros'),
  terminalGet: id => ipcRenderer.invoke('terminals:get', id),
  terminalCreate: options => ipcRenderer.invoke('terminals:create', options),
  terminalWrite: (id, data) => ipcRenderer.send('terminals:write', id, data),
  terminalCommand: (id, command) => ipcRenderer.invoke('terminals:command', id, command),
  terminalResize: (id, cols, rows) => ipcRenderer.send('terminals:resize', id, cols, rows),
  terminalSignal: (id, signal) => ipcRenderer.invoke('terminals:signal', id, signal),
  terminalRestart: id => ipcRenderer.invoke('terminals:restart', id),
  terminalClose: id => ipcRenderer.invoke('terminals:close', id),
  tmuxSendText: options => ipcRenderer.invoke('tmux:send-text', options),
  tmuxSendKey: options => ipcRenderer.invoke('tmux:send-key', options),
  tmuxCapture: options => ipcRenderer.invoke('tmux:capture', options),
  tmuxNewSession: options => ipcRenderer.invoke('tmux:new-session', options),
  tmuxNewWindow: options => ipcRenderer.invoke('tmux:new-window', options),
  tmuxSplitPane: options => ipcRenderer.invoke('tmux:split-pane', options),
  tmuxRenameSession: options => ipcRenderer.invoke('tmux:rename-session', options),
  tmuxRenameWindow: options => ipcRenderer.invoke('tmux:rename-window', options),
  tmuxSelectLayout: options => ipcRenderer.invoke('tmux:select-layout', options),
  tmuxKillPane: options => ipcRenderer.invoke('tmux:kill-pane', options),
  tmuxKillWindow: options => ipcRenderer.invoke('tmux:kill-window', options),
  tmuxKillSession: options => ipcRenderer.invoke('tmux:kill-session', options),
  onTerminalData: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('terminals:data', handler);
    return () => ipcRenderer.removeListener('terminals:data', handler);
  },
  onTerminalState: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('terminals:state', handler);
    return () => ipcRenderer.removeListener('terminals:state', handler);
  },
  onTerminalError: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('terminals:error', handler);
    return () => ipcRenderer.removeListener('terminals:error', handler);
  },
  onSnapshot: callback => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('agents:snapshot', handler);
    return () => ipcRenderer.removeListener('agents:snapshot', handler);
  },
});
