@AGENTS.md

Everything about this repo lives in `AGENTS.md`, shared with Codex and OpenCode.
This file holds only what uses Claude Code import syntax.

## Google Cloud, OAuth branding, Secret Manager

@/Users/tejas/Desktop/projects/CLAUDE.local.md

Shared across every project under `~/Desktop/projects` - read that file for the
rules. The ones that bite most often:

- Personal GCP resources (our OAuth client, secrets) live in `teejayproject` and
  **every** gcloud command touching them needs `--configuration=personal`. IAP
  tunnels to GeoIQ VMs use the WORK account instead - no flag.
- The OAuth consent screen is per-PROJECT, so all personal apps share one brand:
  **tn07** / `tn07.dev` (projects live at `<name>.tn07.dev`, e.g.
  `switchboard.tn07.dev`). Do not rename it to "Switchboard".
- The mobile OAuth client is Secret Manager secret `switchboard-oauth-client`.
  Never hardcode it.
- IAP relay requires `Origin: bot:iap-tunneler` or it silently sends nothing.

Switchboard-specific: `src/shared/iap-tunnel.ts` is the IAP codec and
`scripts/iap-probe.mjs` is the live smoke test (validated end to end against
`geoiq-ssg-dev-in` on 2026-07-25). Design notes in
`docs/plans/2026-07-22-mobile-app.md`.
