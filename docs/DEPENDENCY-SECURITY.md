# Dependency security

`npm audit --omit=dev --audit-level=high` is the release gate. The current
lockfile also passes the full `npm audit` with zero known production or
development dependency vulnerabilities. Electron is pinned to the supported
43.x line.

Risk is constrained by lockfile-only CI installs, pinned GitHub Actions,
controlled package inputs, isolated build runners, SHA-256-verified internal
artifacts, signed/notarized production artifacts, post-build checks, CodeQL,
and Dependabot. Dependency audit results should be rechecked whenever the
lockfile or packaging toolchain changes.
