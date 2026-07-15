<div align="center">

# LoadToAgent

### One local command center for every AI agent at work.

Monitor Claude, Codex, Gemini, and Grok sessions, follow parent–subagent relationships, inspect token usage, and send work back to a connected terminal—without uploading your transcripts.

[![Desktop CI](https://github.com/minjund/LodeToAgent/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/minjund/LodeToAgent/actions/workflows/desktop-ci.yml)
[![npm version](https://img.shields.io/npm/v/loadtoagent?logo=npm&color=CB3837)](https://www.npmjs.com/package/loadtoagent)
[![GitHub Release](https://img.shields.io/github/v/release/minjund/LodeToAgent?display_name=tag&sort=semver)](https://github.com/minjund/LodeToAgent/releases/latest)
![macOS](https://img.shields.io/badge/macOS-supported-111827?logo=apple)
![Windows](https://img.shields.io/badge/Windows-supported-111827?logo=windows11)
![Local first](https://img.shields.io/badge/data-local--first-35d69f)

**English** | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

[**Download for Windows / macOS**](https://github.com/minjund/LodeToAgent/releases/latest) · [**Install with npm**](https://www.npmjs.com/package/loadtoagent)

</div>

<div align="center">
  <img src="docs/assets/loadtoagent-demo.gif" alt="LoadToAgent dashboard demo showing an AI task, its subagents, conversation, and token usage" width="960" />
</div>

> Your agent transcripts stay on your computer. LoadToAgent reads the local session files created by the AI tools you already use.

## Install and run

Choose npm if you already use Node.js, or download a ready-to-run desktop file. Neither option requires a Git checkout.

### Option 1: npm

LoadToAgent is published on npm as [`loadtoagent`](https://www.npmjs.com/package/loadtoagent). Install it globally, then run the command to open the desktop dashboard:

```bash
npm install -g loadtoagent
loadtoagent
```

The npm method does not create a desktop shortcut. Run `loadtoagent` whenever you want to open the app. If your terminal cannot find the command immediately after installation, close and reopen the terminal once.

```bash
# Update
npm install -g loadtoagent@latest

# Remove
npm uninstall -g loadtoagent
```

### Option 2: desktop download

Open the [latest GitHub Release](https://github.com/minjund/LodeToAgent/releases/latest) and download the file for your computer. Node.js is not required for these files.

| System | Download | Start the app |
|---|---|---|
| Windows 10/11 (x64) | `LoadToAgent-Setup-<version>.exe` | Recommended installer for first-time setup and in-app updates. |
| Windows 10/11 (x64) | `LoadToAgent-<version>-portable.exe` | Double-click the downloaded file. It is portable and does not run an installer. |
| Apple silicon Mac | `LoadToAgent-<version>-arm64.dmg` | Open the DMG, drag LoadToAgent into Applications, then open it from Applications. |
| Intel Mac | `LoadToAgent-<version>-x64.dmg` | Open the DMG, drag LoadToAgent into Applications, then open it from Applications. |

The current desktop files are not code-signed. Windows SmartScreen or macOS Gatekeeper may show an unknown-developer warning. Continue only when the file came from this repository's official Releases page. On macOS, Control-click LoadToAgent and choose **Open**. On Windows, choose **More info → Run anyway**.

### Update from the app

On startup, LoadToAgent compares its package version with the newest stable GitHub Release tag. When a newer version exists, a notice appears at the top of the app and under **Settings → Program update**. The app downloads the matching Windows Setup EXE or macOS DMG, verifies its GitHub file size and SHA-256 digest when available, and then lets you open the installer. npm installations can also use `npm install -g loadtoagent@latest`.

### Requirements

- macOS or Windows
- Node.js 18 or newer only when installing through npm
- At least one installed and authenticated CLI: Claude Code, Codex CLI, Gemini CLI, or Grok CLI
- tmux only if you want the optional tmux workspace map

## Your first 10 minutes

1. From **Home**, choose `New AI task`, describe the outcome, and select a workspace. If no supported AI is installed, follow the official setup link shown in the app first.
2. Open **In progress** to see every AI with a green status. Expand `View detailed flow` only when you need the subagent breakdown.
3. When **Needs your input** shows a count, handle those replies or decisions first.
4. Open any task to inspect its **conversation, progress, and usage**, then continue a connected task from **Session terminal**.

The `10-minute start guide` on Home lets you practice the same four steps. Progress is saved on this computer and the guide can be reopened at any time.

## What LoadToAgent shows

| View | What you get |
|---|---|
| Agent map | Live work grouped by Claude, Codex, Gemini, and Grok |
| Relationship view | The request origin, selected agent, and every directly delegated subagent |
| Session detail | Conversation, tool activity, lifecycle events, model, workspace, and status |
| Token view | Input, output, cached, reasoning, total, and reported context-window usage |
| Session terminal | The selected AI's prior conversation beside its existing PTY or tmux pane, with input continuing in that exact session |
| tmux workspace | Session → window → pane → AI process topology on macOS or Windows through WSL |

LoadToAgent distinguishes between a terminal it can control, a session that needs a bridge connection, a read-only session that must continue in its original app, and an ended session. It never types into an arbitrary external window.

## Use a connected terminal

Keep the LoadToAgent app open, then start an AI CLI through its authenticated local bridge:

```bash
loadtoagent run claude
loadtoagent run codex
loadtoagent run gemini
loadtoagent run grok
```

Arguments after `--` are passed to the provider CLI:

```bash
loadtoagent run claude -- --model claude-sonnet-4-6
```

The external terminal and LoadToAgent dashboard control the same LoadToAgent-owned PTY. Opening a terminal from an AI card reuses the exact connected terminal instead of creating a new shell, keeps its PTY output intact across UI navigation, and shows that session's prior conversation in a live side rail. Sessions started arbitrarily elsewhere remain visible but read-only unless the original app exposes a supported handoff.

## Local-first by design

- Session files are read directly from your user profile.
- API key files are not read or displayed; authentication stays with each provider CLI.
- The terminal bridge uses a per-user token and a local named pipe or Unix domain socket.
- Renderer requests are isolated and validated before terminal or tmux actions run.
- Enabling workspace writes gives the selected AI permission to modify that folder, so use it only with repositories you trust.

Review the visible transcript before sharing your screen: agent conversations and tool inputs can contain sensitive project information.

## Develop locally

```bash
npm install
npm start
npm test
```

Additional checks and distributable builds:

```bash
npm run test:terminal
npm run test:bridge
npm run test:tmux -- macOS
npm run test:visual
npm run dist:mac
npm run dist:win
```

`dist:mac` produces Apple Silicon and Intel DMG/ZIP files. `dist:win` produces Windows Setup and portable executables. Production macOS releases still require the maintainer's Apple signing and notarization credentials.

## Supported session sources

| Provider | Existing sessions | New work stream | Subagents |
|---|---|---|---|
| Claude | Claude Code local JSONL transcripts | Structured headless output | Transcript subagent records |
| Codex | Codex local rollout JSONL files | `codex exec --json` | `thread_spawn` parent metadata |
| Gemini | Gemini local chat JSON/JSONL files | Structured streaming output | Parent IDs when reported |
| Grok | Grok local session JSON/JSONL files | Structured streaming output | Parent IDs when reported |

Provider event mappings and context-window rules are documented in [Provider Contracts](docs/PROVIDER-CONTRACTS.md).

## Release

Pushing a `v*` Git tag runs the full test suite, publishes the npm package with provenance, builds the macOS and Windows artifacts, and creates the GitHub Release with those files attached. The `package.json` version and tag must match.

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
VERSION=$(node -p 'require("./package.json").version')
git commit -m "release: v$VERSION"
git tag "v$VERSION"
git push origin HEAD --follow-tags
```

---

<div align="center">
  Built for people who run more than one AI agent—and still want to know exactly what each one is doing.
</div>
