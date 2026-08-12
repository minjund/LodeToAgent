# Changelog

Notable user-facing changes are documented here. Release tags and generated
GitHub release notes remain the authoritative version history.

## Unreleased

## 1.6.21 - 2026-08-12

- Preconnect top-level AI terminals when a project is selected while keeping
  subagent sessions task-only and avoiding duplicate replay hydration.
- Improve Korean terminal glyph spacing and smooth scrollback movement, with
  reduced-motion support.
- Allow persistent project reordering from the sidebar by drag-and-drop or
  keyboard controls.
- Keep parent agents active while nested subagents are still running, and show
  completed project results until they are reviewed.
- Clear project completion and attention badges after their current notices are
  opened, while resurfacing the badges for new results or requests.

## 1.6.20 - 2026-08-12

- Distinguish provider activity as thinking, working, waiting for explicit
  input, and completed across Claude, Codex, Gemini, Grok, and managed runs.
- Notify only for structured input, permission requests, and meaningful root
  completions while showing the actual question text in the notification.
- Deduplicate concurrent and repeated input requests by stable request ID,
  without hiding separate terminal edit approvals or shell permissions.
- Recover recent unresolved Codex input requests after startup with bounded
  scanning, and keep transient thinking or working sessions in the live view.

## 1.6.19 - 2026-08-11

- Keep only the English, Korean, and Simplified Chinese Electron locale packs
  that LoadToAgent supports, removing unused Chromium translations from every
  desktop build.
- Exclude xterm source, typings, source maps, and duplicate ESM bundles while
  retaining the browser runtime, stylesheet, package metadata, and licenses.
- Keep the README demo in the npm package while omitting unreferenced design
  screenshots from the published tarball.
- Prune packaged node-pty files to the target operating system and CPU before
  signing, and fail the build if that native runtime is incomplete.
- Reclaim stale partial downloads and installers older than the running app
  from the managed update cache while preserving active and unknown files.
- Index parsed conversation messages and lifecycle events, stream JSONL header
  metadata in bounded chunks, and avoid repeated full-session lookups to lower
  startup work without reducing the visible history window.

## 1.6.18 - 2026-08-11

- Keep inline xterm DOM, IME composition, scrollback, and input focus stable
  across live session snapshots instead of detaching and repainting the PTY.
- Connect an expanded top-level AI terminal automatically without resending its
  prompt, while preventing stale provider histories and drawer-owned PTYs from
  being mounted into the wrong view.
- Deliver raw terminal input through bounded, ordered, idempotent batches so
  reconnects and lost acknowledgements cannot duplicate, reorder, or silently
  append uncertain keystrokes.
- Restore the active xterm caret after a host reconnect only when the user is
  still working in that PTY, without stealing focus after another interaction.
- Preserve accepted, rejected, and uncertain delivery state across the Electron
  IPC boundary and safely retry only input that was never sent to a host.

## 1.6.17 - 2026-08-10

- Restore reliable native PTY input without tree-killing a still-live legacy
  host: replacement waits for its natural idle exit, preserves split UTF-8
  frames, accepts retained ANSI replay frames, and retries dropped host
  connections with bounded backoff.
- Open newly started AI work in its live terminal immediately, then bind that
  PTY only to the provider history whose first prompt, time, and environment
  match, preventing duplicate resumes and stale-history attachment.
- Keep an unanswered newest request from displaying an assistant response
  copied from an older turn.
- Retry Grok's separate first-command delivery once with the same durable
  delivery ID, and surface an uncertain result without starting a duplicate.
- Persist a distinct creation ID before spawning fresh AI terminals so a lost
  create response reuses the same running, failed, or stopped record instead
  of launching a second PTY or repeating the first question.
- Queue one newest-detail follow-up behind an in-flight drawer read and clear
  old assistant intent whenever a later user message is still unanswered.
- Reduce terminal stalls by hydrating large xterm replays in chunks and
  coalescing high-frequency persistence while bounding slow-client output
  queues.

## 1.6.16 - 2026-08-10

- Keep inline and drawer PTYs focused on native terminal input without a
  separate message composer, and preserve terminal scrollback with the mouse
  wheel.
- Prevent Electron's placeholder `path-to-app` window across Windows and macOS
  source launches by recognizing executable paths with either path separator.
- Start brand-new AI tasks without invalid recovery arguments while retaining
  recovery behavior for existing sessions.

## 1.6.15 - 2026-08-07

- Launch the source checkout with its application path when the generated
  `loadtoagent` bridge opens the desktop UI, preventing Electron's default
  `path-to-app` window from appearing repeatedly during development.
- Update the release toolchain's YAML parser to the patched dependency version
  required by the high-severity audit gate.
- Remove the duplicate message composer from inline and drawer PTY views so
  typing, paste, Enter, and Ctrl+C go directly through the terminal cursor.

## 1.6.14 - 2026-08-06

- Move the live PTY out of the right-side task drawer: clicking an AI now
  toggles its signed, interactive PTY directly below that AI in the workflow,
  and clicking the same AI again closes it without disturbing nearby work.
- Put task context behind the work-progress view, with dedicated summary,
  lifecycle, and usage tabs that expose input, output, cache, total, and
  context-window token details without crowding the terminal.
- Ship the project-first workspace and session-flow refinements, clearer
  attention and completion notifications, IME-safe command submission, and
  stronger session, terminal-host, and update lifecycle diagnostics.
- Gate Windows desktop releases with both deterministic inline-PTY interaction
  coverage and a real node-pty-to-xterm end-to-end command round trip.

## 1.6.13 - 2026-08-06

- Rebuild and republish the verified actual-PTY conversation experience from
  the latest `main` source so the desktop installers and npm package share one
  current release version.

## 1.6.12 - 2026-08-06

- Open every main task's Conversation tab as an actual connected PTY: reuse
  its exact xterm and scrollback when available, or resume the same provider
  session into a prompt-free app-owned PTY instead of rendering a terminal-
  styled transcript.
- Keep PTYs isolated across task switches, replace stopped or exited PTYs
  exactly once, and serialize resume-identity changes without duplicating AI
  processes or replaying prompts. Externally discovered tmux panes remain
  display-only for task matching instead of becoming writable by inference.
- Disable conversation input in the same event tick as a disconnect while
  preserving the focused draft, caret, and form, and retain explicit retryable
  terminal errors instead of silently falling back to a non-interactive view.
- Make automatic updates wait for confirmed direct-run, PTY, terminal-host,
  and old-app process-tree shutdown; fail closed when a managed tmux runtime
  or update-helper cancellation cannot be verified before installer handoff
  and verified relaunch.
- Prevent slow recovery or reconnect races from launching duplicate terminal
  hosts, preserve PTY output ordering across replay hydration, and keep the
  single-host OS lock until every shutdown transition is acknowledged.
- Pin manually selected tmux terminals to their exact pane even when another
  client changes panes, wait for delayed Windows ConPTY PIDs before tree
  shutdown, and refuse legacy-host replacement until the old process is
  confirmed gone.
- Give Linux and macOS terminal hosts full-identity, OS-owned locks so crashes,
  stale files, ports, and unrelated workspaces cannot false-lock one another.

## 1.6.11 - 2026-08-05

- Restore every task's Conversation tab as a terminal-shaped surface: exact
  PTYs reuse the same xterm and scrollback, while external and ended tasks use
  a safe terminal-styled transcript instead of a false empty-PTY screen.
- Keep exact PTYs attached across waiting and paused transitions, recover
  safely across PTY creation, expiry, concurrent attachment, and connection
  failures without losing a focused draft, and remove the redundant Terminal
  tab.
- Gate desktop and release builds with focused Electron coverage for terminal
  conversation rendering, PTY lifecycle transitions, fallback behavior, and
  input continuity.

## 1.6.10 - 2026-08-05

- Keep every task drawer on structured conversation by default, exposing an
  exact attachable PTY in a dedicated Terminal tab while preserving consistent
  conversation views across live, waiting, completed, failed, cancelled, and
  external sessions.
- Stabilize terminal-to-task matching across bridge and session-list arrival
  races, prevent stale list responses from erasing newer PTY state, and return
  restarted Codex subagents to active progress instead of completed history.
- Let source and npm launches detect the installed desktop app and its actual
  version, then hand verified installers to automatic quit-install-restart
  while warning about active work, detaching managed terminals, stopping direct
  runs, and blocking new work during shutdown.
- Authenticate per-update helper readiness, clean up failed helper processes
  and files, recover terminal and runner state after failures, block unsafe
  updates when the installed version is unknown, and clarify manual and
  portable update paths.

## 1.6.9 - 2026-08-04

- Replace the inline AI command box in the task map with a responsive live-
  progress overview showing the current step, recorded-step completion, active
  and finished helpers or commands, blockers, and recent activity.
- Open attachable live sessions with their PTY and restored scrollback directly
  in the session drawer, with connection, reconnect, focus, and delivery
  feedback while retaining conversation-only views for external sessions.
- Improve long-running session inspection by showing recent conversation
  immediately, paging older turns, preserving delivered messages and helper-AI
  results, and recovering linked sessions outside the recent-history scan.

## 1.6.8 - 2026-08-04

- Rebuild the light and dark palettes so terminal, tmux, drawers, graphs,
  settings, runtime states, and mobile controls consistently follow the active
  appearance without opposite-theme surfaces leaking through.
- Standardize selection and semantic status colors, raise small-text contrast,
  and add interaction-state theme auditing for hidden loading, error, history,
  permission, update, and mobile states.

## 1.6.7 - 2026-08-04

- Match result-review cards, status controls, and embedded AI command panels to
  the active light or dark theme instead of retaining dark-only surfaces.
- Improve empty-state and action contrast, and expand automated theme coverage
  across management summaries in both appearances.

## 1.6.6 - 2026-08-03

- Keep past-session details aligned with the latest observed idle state so an
  already finished task is not shown as running when its history is opened.

## 1.6.5 - 2026-08-01

- Make terminal questions delivery-safe across Claude, Codex, Gemini, and Grok
  by tracking delivery identifiers, suppressing duplicates, and distinguishing
  accepted, rejected, and uncertain sends instead of reporting false failures.
- Reattach managed tmux sessions without starting a second provider process,
  preserve pending drafts for safe retries, and keep delivery records durable
  across app restarts on macOS, Windows, and WSL.
- Preserve keyboard focus and scroll position through live session refreshes,
  and refine project navigation, settings, modals, responsive layouts, and
  light-theme contrast with a final shared polish layer.

## 1.6.4 - 2026-07-31

- Publish the verified project-first workspace with task status shown directly
  in the selected project's main view, including processing, past, and waiting
  sessions without an extra reveal action.
- Keep per-session token usage and provider usage details visible as gauge bars
  while retaining the existing desktop workflows and updater hardening.

## 1.6.3 - 2026-07-31

- Make Windows updates wait for an authenticated renderer-ready signal from the
  newly installed app instead of treating a briefly living process as success.
- Restore and focus the relaunched window, and retry startup up to three times
  when the renderer or window does not become ready.

## 1.6.2 - 2026-07-31

- Match execution details, helper-AI summaries, quick navigation, keyboard
  shortcuts, and update indicators to the light theme instead of retaining
  dark-only surfaces and low-contrast text.
- Remove the fixed login-account explanation from project history so only
  information related to the selected project's real sessions is shown.
- Replace placeholder project glyphs with clear initials and keep control-flow
  cards and long workspace paths readable in narrow project panes.

## 1.6.1 - 2026-07-31

- Fix Windows updates that could close the app without reopening it by finding
  the newly installed executable, verifying its version, and retrying launch.
- Move keyboard shortcuts into a compact brand action, remove the redundant
  help/status card, and simplify the new AI task button to one line.

## 1.6.0 - 2026-07-31

- Rebuild the home screen around project selection: keep every project visible,
  sort projects by attention and live state, and show only the selected
  project's current work and related history in the main area.
- Present AI account gauges as percentages used, keep the configured AI list
  fixed, and place the single desktop Settings entry directly above that list.
- Separate project creation from new AI work, lock new work to the currently
  selected project, and make project removal stable without horizontal sidebar
  overflow.
- Surface native Codex file-edit approval prompts in the project view and send
  proceed, remember, or reject choices back to the exact terminal or tmux pane.
- Simplify review and session cards, preserve actionable results and prior
  project history, and expand project-first visual and interaction coverage.

## 1.5.3 - 2026-07-31

- Rebuild the project-first studio shell so project context, work states,
  history, and advanced tools remain clear from 320px mobile layouts through
  wide desktop screens without overlapping or wasting tool-view space.
- Normalize button, card, modal, drawer, and settings spacing with consistent
  touch targets, readable wrapping, keyboard focus, and improved light-theme
  action contrast.
- Keep the terminal question composer, history, controls, and console inside
  the viewport at compact widths while preserving focus, drafts, and explicit
  computer-versus-AI input modes.
- Clarify review, runtime, remote-computer, update, and projectless-history
  states, including continuous transitions after a user answers a waiting AI.
- Expand interaction coverage to exercise every required visible control and
  add responsive, theme, readability, scrolling, and visual regression checks
  for the updated layouts.

## 1.5.2 - 2026-07-30

- Improve light-mode contrast across every primary view, including status
  labels, settings, review cards, runtime guidance, and terminal controls.
- Restyle the **New AI task** action so its title and `Ctrl+N` shortcut remain
  crisp on one consistent button background at wide and compact widths.
- Move getting-started help, keyboard shortcuts, connection status, and screen
  appearance controls into Settings and simplify the global header.
- Add clearer project filtering for work history, align project actions and
  labels, and normalize button spacing across responsive layouts.
- Expand automated theme, text-contrast, and overflow coverage for
  desktop, wide, drawer, modal, terminal, and mobile states.

## 1.5.0 - 2026-07-28

- Reframe the dashboard around a five-stage causal spine from intent and
  delegation through action, evidence, and judgment.
- Add a dedicated memory experience that preserves completed work as causal
  records while separating pending judgment from retained decisions.
- Unify desktop and mobile navigation, typography, themes, responsive layouts,
  and interaction language without removing terminal, tmux, automation, or
  session-management capabilities.
- Expand philosophical, readability, responsive, scroll-retention, and
  full-interaction coverage, including deterministic Electron fixture cleanup.

## 1.4.2 - 2026-07-28

- Stop stale Claude subagent launch records from keeping finished dashboard
  sessions and helper agents in the active "working" state.
- Preserve interrupted collaboration history as unverified records while
  excluding it from current-running counts.

## 1.4.1 - 2026-07-28

- Simplify conversation intervention into a focused chat composer with clear
  input and action regions, readable Send and Stop controls, and slash-command
  suggestions.
- Disable conversation and terminal Send actions for empty or whitespace-only
  drafts while preserving Enter, Shift+Enter, composition, and command routing
  behavior.
- Improve long-request reading, session-reset wording, mobile action spacing,
  status indicators, and contrast across dashboard, terminal, tmux, and
  conversation surfaces.
- Expand interaction, readability, responsive, visual, and scroll-retention
  coverage for every user-reachable required control.

## 1.4.0 - 2026-07-27

- Keep each Claude or Codex conversation on its existing external session
  until the user explicitly confirms **Reset session**.
- Send native and registered CLI commands such as `/model`, `/command`, and
  `!command` without turning them into conversation prompts or closing the
  current conversation.
- Collapse user prompts longer than 200 characters with persistent full/close
  controls, grapheme-safe previews, and a copy action for the full request.
- Add an in-conversation stop control that sends Ctrl+C to the exact terminal
  or tmux pane handling the current AI response while keeping the session open.
- Replace the home attention block with provider-reported usage windows and
  show live context size in the conversation panel.
- Add an accessible reset confirmation dialog, compact mobile conversation
  chrome, a full-screen long-request reader, and explicit 44px interaction
  targets throughout the updated UI.
- Prevent stale session-detail responses from overwriting newer terminal
  conversation snapshots.

## 1.3.18 - 2026-07-27

- Render every conversation turn as a flat transcript without message
  bubbles in both overlay and split-panel presentations.
- Keep the conversation panel in overlay mode below 1680px and reserve at
  least 960px for the dashboard in split-panel mode.
- Separate blocking responses, optional follow-ups, and run risks throughout
  attention detection and the review inbox.
- Show the exact request sentence that triggered a review item and keep
  optional follow-ups out of urgent intervention counts.
- Improve terminal command delivery, session parsing, execution summaries,
  attention highlighting, and interaction coverage.

## 1.3.16 - 2026-07-27

- Restore internal unsigned macOS updates while retaining trusted GitHub
  release URL and SHA-256 digest verification.
- Remove quarantine attributes only from the staged internal macOS app before
  relaunch.

## 1.3.14 - 2026-07-27

- Adopt the MIT License.
- Upgrade the Electron and desktop build toolchain.
- Enable renderer sandboxing and monitored worker recovery.
- Require update SHA-256 digests and platform signature verification.
- Add bounded local-data retention and restrictive POSIX storage permissions.
- Coalesce renderer work, deduplicate bootstrap calls, and define CSS cascade
  layers.
- Strengthen CI, dependency automation, signed release verification, and
  security documentation.
