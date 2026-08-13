'use strict';

/**
 * Records a recoverable failure without converting a best-effort operation into
 * an application crash. Callers must provide an operation name so warnings are
 * actionable in packaged-app logs.
 */
function reportRecoverableError(operation, error) {
  const message = error && error.message ? error.message : String(error || 'unknown error');
  console.warn(`[Whitebox:${operation}] ${message}`);
}

/** Runs cleanup code and reports a failure that is safe to continue past. */
function runBestEffort(operation, action) {
  try {
    return action();
  } catch (error) {
    reportRecoverableError(operation, error);
    return undefined;
  }
}

module.exports = { reportRecoverableError, runBestEffort };
