# Contributing

Issues and pull requests are welcome. For anything larger than a bug fix
(a new agent, a schema change, a change to what a paired phone may do), open an
issue first so the design can be agreed before the code.

## Set up

```sh
npm install
npm run rebuild      # node-pty and better-sqlite3 for Electron
npm install --prefix apps/mobile   # the root tests import mobile logic
npm run dev
```

macOS and Windows are the supported desktop platforms. Linux builds and runs
tests in CI but is not released.

## Before you open a pull request

- `npm run typecheck` and `npm test` pass.
- A change in behaviour comes with a test that fails without it.
- A change that users can see updates `docs/feature-parity/<feature>.json`,
  covering desktop, both phone apps, the backend contract, stored data and
  rollout. `npm run validate:feature-parity -- --base origin/main` checks it.
  The rule is in `AGENTS.md` under "Cross-surface feature policy".
- A visible UI change refreshes the screenshot baselines (see
  `e2e/AGENTS.md`), and you have looked at every changed image.
- No em dashes anywhere, including commit messages.

`AGENTS.md` is the full guide to the codebase. It is written for coding agents
and reads fine for people too. Each area has its own `AGENTS.md` next to the
code; the root one has the index.

## Pull requests

Describe what a user sees change and why, then fill in the template. CI runs
on every pull request; CodeRabbit also reviews it. Merge commits only: do not
rebase a shared branch.

## Security

Report vulnerabilities privately, as `SECURITY.md` describes, not in an issue.
