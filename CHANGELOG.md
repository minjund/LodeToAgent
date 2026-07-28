# Changelog

Notable user-facing changes are documented here. Release tags and generated
GitHub release notes remain the authoritative version history.

## Unreleased

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
