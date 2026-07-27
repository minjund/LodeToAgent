# Data retention

LoadToAgent stores managed-run metadata and terminal replay locally so sessions
can survive app and terminal-host restarts. These records can contain prompts,
responses, commands, output, and working-directory paths.

Completed, failed, cancelled, exited, or stopped records expire after 30 days by
default. Running, paused, detached, or recovery-pending sessions are retained so
an active task is not destroyed. Set `LOADTOAGENT_RETENTION_DAYS` to a whole
number from `0` to `3650` before launching the app to change the completed-record
window; `0` removes completed records on the next startup/persistence cycle.

Replay and store sizes are also bounded in code. On POSIX systems, application
storage directories and files are restricted to modes `0700` and `0600` where
supported. Windows access follows the current user's profile ACL.

This policy covers LoadToAgent's managed-run and terminal persistence only.
Provider-owned Claude, Codex, Gemini, or Grok logs follow each provider's policy
and are never deleted by LoadToAgent.
