# Changelog

Notable user-facing changes are documented here. Release tags and generated
GitHub release notes remain the authoritative version history.

## Unreleased

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
