# LoadToAgent architecture

LoadToAgent keeps Electron process boundaries explicit. `main.js` is the
composition root: it creates long-lived services, owns the application window,
and installs small IPC registration modules from `src/ipc/`. Each registration
module validates the sender through the injected `handleTrusted` boundary.

The monitoring pipeline converts provider-specific logs into the shared
`AgentSession` contract documented in `src/contracts.js`. Provider parsers live
under `src/agentMonitor/`; `src/agentMonitor.js` coordinates scanning and cache
state without owning the provider grammars.

Renderer code is assembled from explicit factories. `app.js` owns core state
and shared view helpers, feature factories receive that public context, and
`app-bootstrap.js` is the only module that installs them. Terminal factories use
the same pattern. Script order in `renderer/index.html` is therefore a bootstrap
manifest, not an implicit variable dependency.

CSS is loaded in ordered responsibility layers: foundations, shared components,
workflows, terminal surfaces, product-specific components, then responsive
overrides. A selector has one authoritative non-responsive definition; only
state variants and breakpoint adaptations may repeat it.

Recoverable main-process failures go through `src/diagnostics.js`. Expected
best-effort cleanup is logged with an operation name, while user-visible IPC
failures are returned to the renderer and shown near the initiating action.

Persistent POSIX and WSL AI terminals use the managed-session contract in
`docs/MANAGED-TERMINAL-SESSIONS.md`. The PTY is only an attach view over a
session on the isolated `tmux -L loadtoagent` server. Session metadata persists
independently, so a host restart reconnects to a live tmux session instead of
starting a duplicate provider conversation. Native Windows and transient
commands remain on the direct PTY backend.

Direct native Codex PTYs are a special case inside that terminal-host boundary.
The host lazily owns one loopback `codex app-server` and injects its ephemeral
`--remote` endpoint only while constructing a direct Codex process. Canonical
resume arguments and persisted conversation identity never contain the
endpoint. Host-independent managed-tmux Codex processes never receive it, so
their detach and crash-recovery lifetime remains independent of the terminal
host. Readiness is confirmed through `/readyz` before a direct Codex PTY can
start, and a startup or recovery failure is fail-closed for that Codex process
without preventing unrelated providers and shells from recovering. Claude,
Gemini, Grok, and Windows WSL launch paths are unchanged. A thread originating
in the official Codex Desktop app cannot join this server because that app's
private stdio endpoint is not exposed. Turn-level completion is not proof that
the writer was released, so renderer guards keep every Desktop-origin thread
in its origin app.

Regression tests are registered by feature suites in `scripts/tests/` and run
through a shared harness. Electron integration scripts cover renderer events,
responsive layouts, the terminal bridge, and real BrowserWindow interaction.
