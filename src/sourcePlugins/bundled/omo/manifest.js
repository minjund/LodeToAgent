'use strict';

const OMO_PLUGIN_ID = 'builtin.omo';

// Keep this raw manifest aligned with src/sourcePlugins/bundled.js. The host
// validates and freezes its own copy; this copy lets the adapter remain
// independently testable without importing the registry back into itself.
const OMO_MANIFEST = Object.freeze({
  apiVersion: 1,
  id: OMO_PLUGIN_ID,
  version: '1.0.0',
  name: 'Oh My OpenAgent',
  label: 'OMO · OpenCode',
  shortLabel: 'OMO',
  description: 'Oh My OpenAgent sessions stored by OpenCode on this computer.',
  trust: 'bundled',
  kind: 'source-monitor',
  mark: 'OMO',
  accent: '#7c3aed',
  platforms: Object.freeze(['win32', 'darwin', 'linux']),
  transport: 'local-read-only',
  source: Object.freeze({ id: 'omo', label: 'OMO · OpenCode' }),
  orchestrator: 'omo',
  clientKind: 'opencode-omo',
  capabilities: Object.freeze({
    history: Object.freeze({ list: true, detail: true }),
    live: true,
    control: Object.freeze({
      start: true,
      sendInstruction: true,
      stop: false,
      archive: false,
      delete: true,
    }),
  }),
  presentation: Object.freeze({
    conversationSurface: 'transcript',
    workSurface: 'timeline',
    artifactSurface: 'list',
  }),
});

module.exports = {
  OMO_MANIFEST,
  OMO_PLUGIN_ID,
};
