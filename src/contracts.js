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
 * @property {'thinking'|'working'|'juggling'|'notification'|'attention'|'error'|'idle'} activityState Provider-neutral current activity, kept separate from lifecycle status and one-shot notifications.
 * @property {string|null} parentId
 * @property {string} cwd
 * @property {string} originCwd Immutable workspace path where the session began.
 * @property {string} updatedAt
 * @property {TokenUsage} usage
 * @property {Array<Object>} messages
 * @property {Array<Object>} lifecycle
 * @property {Array<{id:string,kind:'shell'|'background',mode:'foreground'|'background',tool:string,runtime:string,label:string,command:string,cwd:string,status:'running'|'completed'|'failed'|'unverified',statusDetail:string,output:string,backgroundId:string,exitCode:number|null,startedAt:string|null,updatedAt:string|null,completedAt:string|null}>} executions Logged regular and background command runs owned by this AI session. `unverified` means the last running observation is no longer fresh enough to claim current liveness.
 * @property {CollaborationSummary|null} collaboration
 * @property {{kind:string,iteration:number,phase?:string}|boolean|null} loop Safe execution-loop metadata; internal goal text is never included.
 * @property {{category:'required'|'optional'|'risk'|'none',required:boolean,actionable:boolean,kind:string,summary:string,requestId:string,requestedAt:string|null,source:string,confidence:string}} attention Mutually exclusive classification for a blocking response, optional follow-up, run risk, or no action.
 * @property {{stage:string,percent:number,completedSteps:number,failedSteps:number,totalSteps:number,currentStep:string,blocker:string,lastActivityAt:string|null,source:string,checkpoints:Array<Object>}} progress Recent lifecycle-event completion ratio; it is not whole-plan progress.
 * @property {{level:string,score:number,signals:Array<Object>,lastActivityAt:string|null,ageSeconds:number|null}} health Detected status signals. The legacy score is internal and is not presented as a validated health metric.
 * @property {{managed:boolean,respond:boolean,approve:boolean,deny:boolean,sendInstruction:boolean,stop:boolean,pause:boolean,resume:boolean,retry:boolean,reassign:boolean,openOrigin:boolean}} controlCapabilities Safe provider-aware actions available for this session.
 * @property {{confidence:string,status:string,hierarchy:string,completion:string,sources:Array<string>}} evidence Confirmation method for status, hierarchy, and completion signals; not result-quality confidence.
 * @property {{status:string,summary:string,verified:boolean,verification:string,completedAt:string|null,artifacts:Array<Object>,checks:Array<Object>}} outcome Completion summary, log-derived artifact candidates and test records, plus whether a completion signal was received.
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
