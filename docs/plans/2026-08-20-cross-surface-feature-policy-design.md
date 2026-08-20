# Cross-surface feature policy

## Outcome

Switchboard feature work is planned, implemented, verified, and released as one product spanning Desktop Electron, React Native/iOS, native Android, and their shared contracts. A pull request cannot silently leave one surface behind.

## Decision

Behavior-bearing product changes are merge-blocked unless the same pull request adds or updates `docs/feature-parity/<feature>.json`. Each manifest explicitly records the disposition of:

- Desktop Electron
- React Native/iOS
- native Android
- shared backend/API contracts
- stored data and migrations
- update and release paths

An impact area is either `implemented`, `not_applicable`, or `staged`. Implemented work cites evidence. N/A requires a concrete reason. Staged work is the sole incomplete-parity exception and requires both a named feature flag that keeps unfinished behavior unreachable and a named follow-up release.

## Enforcement

`scripts/validate-feature-parity.mjs` validates manifests and inspects the pull-request diff. Changes below `src/`, `apps/mobile`, `apps/android`, runtime resources, or package/release identity files require a changed manifest. Tests and documentation alone do not trigger a manifest because they do not ship behavior.

The `Cross-surface feature policy` CI job runs before merge. Pull requests validate the base-to-head diff; pushes and release workflow calls validate the complete manifest history. Branch protection should require this job alongside the existing test matrix.

## Workflow

1. Create the feature manifest during planning, before implementation.
2. Scope all six impact areas. Record real reasons instead of treating mobile as a follow-up by default.
3. Implement one vertical slice at a time: storage → API → state → UI → lifecycle → tests.
4. Update evidence as tests and device checks complete.
5. If a surface must stage, name its flag and target release. Never ship the unfinished path unguarded.
6. Report automated, hardware, and unexercised verification precisely in both the manifest and pull request.

The machine-readable schema is `docs/schemas/feature-parity.schema.json`; the repository validator remains the normative CI implementation.
