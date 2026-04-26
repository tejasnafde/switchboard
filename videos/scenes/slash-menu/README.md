# Slash menu scene — HyperFrames spike

First scene for the D1 spike (see `docs/notes/hyperframes-spike.md`). Hand-
written HTML+CSS rather than a Vite-mounted `<SlashCommandMenu>` so the spike
tests HyperFrames itself, not our React build pipeline. If HyperFrames passes
go/no-go we can later swap in the real component for production clips.

## Live preview (sanity check before render)

```bash
open videos/scenes/slash-menu/index.html
```

Verify the 6-second loop looks right:
1. 0.4s — "/" appears, popover pops in
2. 0.6–2.2s — highlight walks rows 0 → 1 → 2 → 0
3. 2.6s — input clears, plan-mode pill appears
4. holds for the remainder

## Render with HyperFrames

From the spike sandbox (`/tmp/hyperframes-spike`) where the skill is
installed, point Claude Code at this file:

```
render /Users/tejas/Desktop/projects/switchboard/videos/scenes/slash-menu/index.html
as a 6s 1280x720 mp4 to /tmp/slash-menu.mp4
```

The page reads `window.__hyperframesTime` per frame, so the renderer can
drive deterministic time. If the skill uses a different injection name,
swap the variable in the script block.

## Metrics to capture

Append a row to the decision-log table in `docs/notes/hyperframes-spike.md`:

| Metric | Target | Actual |
|---|---|---|
| Render time (s per s of output) | < 6 | ? |
| File size (1280x720, h264, 6s) | ≤ 6MB | ? |
| Determinism (shasum two consecutive renders) | match or near-match | ? |
| Visual fidelity vs cmd+shift+5 of the live app | indistinguishable at arm's length | ? |

If any cell misses target → no-go, follow the fallback ladder in the spike
doc.
