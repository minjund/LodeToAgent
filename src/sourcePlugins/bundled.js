'use strict';

const { validateManifest } = require('./contracts');

const OMO_MANIFEST = validateManifest({
  apiVersion: 1,
  id: 'builtin.omo',
  version: '1.0.0',
  name: 'Oh My OpenAgent',
  source: { id: 'omo', label: 'OMO · OpenCode' },
  platforms: ['win32', 'darwin', 'linux'],
  capabilities: {
    history: { list: true, detail: true },
    live: true,
    control: { start: true, sendInstruction: true, stop: false, archive: false, delete: true },
  },
});

const ASIDE_MANIFEST = validateManifest({
  apiVersion: 1,
  id: 'builtin.aside',
  version: '1.0.0',
  name: 'Aside Browser',
  source: { id: 'aside', label: 'Aside Browser' },
  platforms: ['darwin'],
  capabilities: {
    history: { list: true, detail: true },
    live: true,
    // Aside does not publish a fixed MCP tool schema. The control host enables
    // only actions proved by tools/list at runtime.
    control: { start: true, sendInstruction: true, stop: false, archive: false, delete: false },
  },
});

function bundledSourceDefinitions(options = {}) {
  return [
    {
      manifest: OMO_MANIFEST,
      createMonitor(context) {
        const adapter = require('./bundled/omo');
        if (typeof adapter.createOmoMonitorPlugin === 'function') return adapter.createOmoMonitorPlugin(context);
        if (typeof adapter.OmoOpenCodeMonitor === 'function') return new adapter.OmoOpenCodeMonitor(context);
        throw new Error('OMO monitor adapter를 불러오지 못했습니다.');
      },
    },
    {
      manifest: ASIDE_MANIFEST,
      createMonitor(context) {
        const adapter = require('./bundled/aside');
        if (typeof adapter.createAsideHistoryMonitor === 'function') return adapter.createAsideHistoryMonitor(context);
        if (typeof adapter.AsideHistoryMonitor === 'function') return new adapter.AsideHistoryMonitor(context);
        return null;
      },
    },
  ].map(definition => ({ ...definition, options }));
}

module.exports = { ASIDE_MANIFEST, OMO_MANIFEST, bundledSourceDefinitions };
