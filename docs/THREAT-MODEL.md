# Threat model

## Assets

- Agent prompts, responses, tool events, terminal replay, and working paths
- The ability to start, pause, resume, stop, or write to local AI terminals
- Update installers and release metadata

## Trust boundaries

The renderer is untrusted web content relative to the Electron main process.
It has no direct Node.js access. The preload bridge exposes a bounded API, while
the main process validates the sender and normalizes every privileged request.
The monitor worker parses external logs but cannot directly control windows or
terminals.

The signed-in operating-system account is a trust boundary. Malware or another
process with the same account permissions can read the same source logs and may
be able to impersonate local input. Full protection against a compromised user
account is out of scope.

## Primary threats and controls

- Renderer compromise: sandboxing, context isolation, disabled Node.js
  integration, CSP, sender validation, and narrow preload methods.
- Malformed or oversized local logs: bounded reads, normalized fields, and
  worker isolation with monitored restart.
- Terminal command injection: argument arrays and validated identifiers instead
  of interpolated shell commands.
- Update substitution: repository/HTTPS allow-list, exact versioned filenames,
  and mandatory SHA-256 digest. Production channels additionally require
  Authenticode or Gatekeeper signature verification and signed/notarized
  release builds. The explicit internal channel may accept an unsigned Windows
  installer or macOS DMG after those checks and clears quarantine only on the
  staged macOS application bundle.
- Sensitive-data accumulation: 30-day default expiry for completed managed runs
  and terminal history, bounded replay, and restrictive POSIX permissions.
- Supply-chain compromise: lockfile installs, pinned CI actions, production
  dependency audit, Dependabot, CodeQL, and npm provenance.

## Residual risks

Provider CLIs and their source logs retain their own data independently.
LoadToAgent cannot delete those records. Users should secure their OS account,
working directories, provider credentials, and backups.
