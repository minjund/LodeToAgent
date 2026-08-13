# Managed terminal sessions

Whitebox separates an AI task from the terminal view attached to it. On
macOS, Linux, and Windows WSL, every non-transient AI terminal is created in a
named session on the isolated `tmux -L whitebox` server. The Electron PTY
attaches to that session; it does not own the AI process.

This boundary is intentionally limited to the Session terminal. The agent map,
parent/subagent flow, monitoring parsers, and conversation UI continue to use
their existing data contracts.

## Invariants

- Each managed session persists its backend, socket name, tmux session name,
  provider arguments, working directory, and stable Whitebox session ID.
- The socket and session names are validated and passed as separate process
  arguments. Provider commands are not joined into an interpolated shell
  string.
- The isolated socket prevents Whitebox options and lifecycle commands from
  modifying the user's default tmux server.
- `window-size` is set to `largest` so an additional client does not shrink the
  shared agent workspace unexpectedly.
- Host recovery may attach only when the persisted tmux session still exists.
  A missing session becomes `stopped`; recovery must never start a fresh,
  duplicate AI conversation.
- Store version 1 sessions migrate to the direct backend. They are not silently
  converted into new tmux conversations.

## Lifecycle

| State or action | PTY attach view | tmux work | Saved record |
|---|---|---|---|
| `running` | Attached | Running | Kept |
| Close terminal view / `detach` | Closed | Running | Kept as `detached` |
| `reconnect` | Reattached | Same existing work | Same ID |
| End AI session / `stop` | Closed | Stopped | Kept as `stopped` |
| Remove record / `close` | Closed | Stopped | Removed |
| Host crash | Lost | Unchanged | Reattached if tmux still exists |

An attach process that exits naturally is also checked against tmux. If the
session still exists, the record becomes `detached`; if the agent and tmux
session ended, it becomes `stopped`.

## Platform policy

| Environment | Persistent AI terminal | Ordinary or transient terminal |
|---|---|---|
| macOS / Linux | Managed tmux | Direct PTY |
| Windows with a selected WSL distro | Managed tmux inside that distro | Direct PTY where applicable |
| Native Windows | Direct PTY | Direct PTY |

The native Windows fallback is deliberate because tmux is not a native Windows
runtime. It preserves existing ConPTY support while WSL receives the managed
session semantics.

## Verification

`npm test` covers option normalization, store migration, isolated launch
arguments, detach/reconnect/stop/close semantics, host recovery, natural attach
exit, IPC, and renderer contracts.

`npm run test:terminal:managed` uses the installed tmux and real Electron
`node-pty` runtime to verify creation, output, detached background execution,
same-ID reconnection, `window-size largest`, stopping, and record removal.
