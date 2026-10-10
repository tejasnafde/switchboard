# End-to-end and screenshot tests

Detail for this part of the code. The root `AGENTS.md` holds the rules that apply everywhere (shipping checklist, cross-surface policy, logging, writing style); they apply here too.

## Screenshot regression tests (every theme)

`npm run test:e2e:visual` (after `npm run build:fast`) has two phases. The
**screens** phase captures the key screens (chat after a finished turn, a long
list reply in a narrow chat, the running composer, sidebar, kanban, Settings, Settings' Accounts page, command palette, provider picker, effort menu,
approval card, and an agent's pull request write card at the default and the narrow width, from the demo adapter's "reply to the review" script; the run fails if that card overflows sideways) in Dark, Light and Translucent against the tour's seeded
workspace (`e2e/fixtures/demo-workspace.mjs`) with `SB_DEMO_ADAPTER=1`, and
compares them with `e2e/snapshots/<screen>-<theme>-darwin.png`. The CI job
`Visual regressions (macOS)` runs it on every PR; on failure the actual and
diff PNGs are in the `visual-regressions` artifact (locally:
`e2e/artifacts/visual/`).

- Background windows (macOS): a Switchboard launched by an agent opens in the background with nothing to export: Claude Code sets `CLAUDECODE=1` in every tool subprocess, and Switchboard puts `SWITCHBOARD_AGENT=1` on every Claude, Codex and OpenCode process it starts (`provider/agent-spawn-env.ts`). Your own terminals carry neither, so a Switchboard you start by hand comes to the front. A background app is an accessory app (no Dock icon), and its window opens with `showInactive()`, fully transparent and click-through (`setOpacity(0)`, `setIgnoreMouseEvents`, with occluded-window backgrounding off so frames keep painting), so it never takes focus or covers the screen; tests read the renderer's own pixels, which opacity does not touch. Outside an agent, `export SB_E2E_BACKGROUND=1` gives the same. `SB_E2E_BACKGROUND=0` forces the foreground (to look at an agent's dev build); the visual behaviour phase sets it itself because it reads the real screen. Do not "fix" an invisible window by calling `focus()`/`show()`.
- A deliberate visual change: `SB_VISUAL_SCOPE=screens SB_UPDATE_SNAPSHOTS=1 npm run test:e2e:visual`, then Read every changed PNG before committing it. Never refresh baselines to make a red run green without looking.
- Everything that varies is pinned: renderer clock (`FROZEN_NOW`, UTC), 1x scale, sRGB, window size, animations and caret, the demo turn's duration (scripted, not wall-clock). Turn timestamps are masked because the main process stamps them. A new source of drift must be pinned the same way, not absorbed by raising the tolerance.
- Translucent is compared as the app's own pixels flattened over a fixed two-colour backdrop, because the real desktop behind the window is never the same twice.
- The **behaviour** phase (native glass transmission, fullscreen fallback) reads the real screen with `screencapture`: it needs Screen Recording permission for the terminal and does not work on the CI runner, so run it locally (`SB_VISUAL_SCOPE=behaviour`) before merging anything that touches translucency.
