'use strict';

const ACTIVITY_STATES = new Set([
  'thinking',
  'working',
  'juggling',
  'notification',
  'attention',
  'error',
  'idle',
]);

function activityTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function observeActivity(tracker, activityState, observedAt) {
  if (!tracker || !ACTIVITY_STATES.has(activityState)) return;
  const nextAt = activityTimestamp(observedAt);
  const previousAt = Number(tracker.activityAt || 0);
  // Once an ordered event has established the clock, an undated partial row
  // must not be allowed to replace it and become the de-facto newest state.
  if (previousAt && !nextAt) return;
  if (nextAt && previousAt && nextAt < previousAt) return;
  tracker.activityState = activityState;
  if (nextAt) tracker.activityAt = nextAt;
}

function finalizedActivityState(options = {}) {
  const status = String(options.status || '');
  if (status === 'failed') return 'error';
  if (options.pendingInput || status === 'waiting') return 'notification';
  if (options.activeSubagents && (status === 'running' || status === 'starting')) return 'juggling';
  if (status === 'completed' && options.completionObserved) return 'attention';
  if (status === 'cancelled' || (status === 'idle' && !options.recent)) return 'idle';
  return ACTIVITY_STATES.has(options.observed) ? options.observed : 'idle';
}

module.exports = { finalizedActivityState, observeActivity };
