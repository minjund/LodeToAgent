'use strict';

/**
 * @typedef {Object} TokenUsage
 * @property {number} input
 * @property {number} output
 * @property {number} cached
 * @property {number} total
 * @property {number|null} contextWindow
 * @property {number|null} contextUsed
 * @property {number|null} contextPercent
 */

/**
 * @typedef {Object} CollaborationMetrics
 * @property {number} spawnedTotal Total child sessions observed in the log.
 * @property {number} running Number of child sessions that are currently active.
 * @property {number} completed Number of child sessions with a completion event.
 * @property {number|null} concurrencyLimit Provider concurrency limit when known.
 */

/**
 * @typedef {Object} CollaborationSummary
 * @property {CollaborationMetrics} metrics
 * @property {Array<Object>} communications Normalized parent/child messages.
 */

/**
 * Canonical provider-neutral session exchanged between the monitor worker,
 * preload bridge, and renderer. Provider parsers may retain extra fields, but
 * consumers should depend only on this contract.
 *
 * @typedef {Object} AgentSession
 * @property {string} id
 * @property {'claude'|'codex'|'gemini'|'grok'} provider
 * @property {string} title
 * @property {string} status
 * @property {string|null} parentId
 * @property {string} cwd
 * @property {string} updatedAt
 * @property {TokenUsage} usage
 * @property {Array<Object>} messages
 * @property {Array<Object>} lifecycle
 * @property {CollaborationSummary|null} collaboration
 * @property {{kind:string,iteration:number,phase?:string}|boolean|null} loop Safe execution-loop metadata; internal goal text is never included.
 */

/**
 * @typedef {Object} TerminalSession
 * @property {string} id
 * @property {'powershell'|'cmd'|'shell'|'wsl'|'tmux'|'agent'} type
 * @property {string} title
 * @property {string} cwd
 * @property {'starting'|'running'|'exited'|'failed'} status
 * @property {number|null} pid
 * @property {string} replay
 */

/**
 * Initial renderer payload returned by `app:bootstrap`.
 * @typedef {Object} BootstrapPayload
 * @property {Array<Object>} providers
 * @property {Object<string, boolean|string>} availability
 * @property {Array<{path:string,name:string}>} workspaces
 * @property {{sessions: AgentSession[], automations: Array<Object>, summary: Object}} snapshot Safe local/WSL automation metadata excludes prompt text.
 * @property {Array<Object>} activeRuns
 * @property {{app:string,electron:string,node:string}} versions
 * @property {Object} platform
 * @property {Object|null} update
 */

module.exports = {};
