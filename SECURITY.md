# Security policy

## Supported versions

Security fixes are provided for the latest released version of LoadToAgent.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub's private
security advisory flow for this repository and include the affected version,
reproduction steps, impact, and any proposed mitigation. We will acknowledge a
complete report within five business days and coordinate disclosure after a fix
is available.

## Security boundaries

LoadToAgent is a local desktop observer and controller. Its stored terminal
replay, prompts, working directories, and agent metadata are sensitive. The
application assumes the operating-system user account is trusted; it does not
protect data from another process already running with the same user's
permissions.

The renderer runs with Electron sandboxing, context isolation, and no Node.js
integration. Privileged operations are exposed only through the preload bridge
and validated IPC handlers. Updates are accepted only from this repository's
HTTPS release assets, require a GitHub-provided SHA-256 digest, and are checked
for a valid platform code signature before launch.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) and
[docs/DATA-RETENTION.md](docs/DATA-RETENTION.md) for operational details.
The production/development audit boundary is recorded in
[docs/DEPENDENCY-SECURITY.md](docs/DEPENDENCY-SECURITY.md).
