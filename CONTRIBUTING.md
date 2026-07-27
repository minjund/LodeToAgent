# Contributing

1. Use Node.js 22 or newer and run `npm ci`.
2. Keep privileged behavior in the main process and expose only a narrow,
   validated preload method. Do not enable renderer Node.js integration or
   disable sandboxing.
3. Run `npm run check:source`, `npm test`, `npm run test:accuracy`,
   `npm run test:terminal`, and `npm run test:bridge` before a pull request.
4. Add regression coverage for behavior changes and update the security,
   retention, architecture, or provider contract documentation when relevant.
5. Keep commits focused. Do not commit generated `release/` output, credentials,
   provider logs, or user session data.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
