# Releasing

The current `package.json` distribution channel is `internal`, so tag builds
may publish unsigned desktop artifacts for controlled testing. Windows and
macOS in-app updates still require an exact trusted GitHub Release URL,
filename, size, and SHA-256 digest before the internal unsigned exception is
used.

Before changing the channel to production, configure these GitHub Actions
secrets and restore fail-closed credential and post-build signature gates:

- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`: Windows code-signing
  certificate and password accepted by electron-builder.
- `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`: Developer ID Application
  certificate and password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`: Apple
  notarization credentials.

Set repository variable `PUBLISH_NPM=true` only after npm Trusted Publishing is
configured for this repository and workflow.

The tag must exactly match `package.json`, for example `v1.4.0`. The workflow
performs source checks, regression and accuracy tests, production dependency
audit, and desktop integration tests. Artifacts are first attached to a draft
GitHub release. npm is then published and verified when enabled; the GitHub
release becomes public only after those gates succeed.

If a job fails, fix the cause and rerun the same workflow. Do not replace a
version already published to npm or overwrite an existing tag's artifacts.
