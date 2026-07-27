# Changelog

Notable user-facing changes are documented here. Release tags and generated
GitHub release notes remain the authoritative version history.

## Unreleased

- Add an in-conversation stop control that sends Ctrl+C to the exact terminal
  or tmux pane handling the current AI response while keeping the session open.

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
