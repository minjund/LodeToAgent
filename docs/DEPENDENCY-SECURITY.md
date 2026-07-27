# Dependency security

`npm audit --omit=dev --audit-level=high` is the release gate and currently
reports zero production vulnerabilities. Electron is pinned to the supported
43.x line.

The current stable electron-builder toolchain still reports high-severity
advisories in indirect packaging-only packages such as `minimatch`, `glob`,
`ejs`, and the optional Squirrel builder path. These packages are not shipped
as runtime dependencies and do not process user-controlled input in the
application. Downgrading to npm's suggested electron-builder 25.1.8 was tested
and increased the vulnerable/deprecated dependency surface, so it is not an
acceptable fix.

Risk is constrained by lockfile-only CI installs, pinned GitHub Actions,
controlled package inputs, isolated build runners, SHA-256-verified internal
artifacts, signed/notarized production artifacts, post-build checks, CodeQL,
and Dependabot. The full audit remains a tracked upstream issue; the stable
builder should be upgraded as soon as it publishes a dependency graph without
these advisories.
