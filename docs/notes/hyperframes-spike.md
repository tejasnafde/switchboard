# HyperFrames spike — onboarding videos

**Status:** Research / pre-spike (2026-04-26). Decision deferred until a
half-day is carved out to actually run the install + render path.

## Goal

Decide whether [HyperFrames](https://github.com/heygen-com/hyperframes)
(HeyGen's open-source HTML→MP4 framework) is the right tool to author
short onboarding clips that auto-play after a Switchboard release.

Source of the lead: HeyGen's announcement on LinkedIn, where the
launch demo was itself produced with HyperFrames + Claude Code. The
appeal is that every Switchboard feature already has a working React
view — if HyperFrames can render that markup faithfully into MP4, we
get release-clip authoring "for free" by pointing an agent at the
component.

## What we're testing in D1

Time-boxed half day. Run in a sandbox repo, not the main tree.

1. `npx skills add heygen-com/hyperframes` — confirm the skill
   installs cleanly into a Claude Code session, no root prompts, no
   conflicts with existing skills.
2. Generate a 5–10s clip of the slash-command menu in action. Use the
   `<SlashCommandMenu>` component mounted in isolation against a
   mocked agent-skills array.
3. Capture metrics:
   - Render time per second of output on M-series.
   - Output file size at 1280×720 h264.
   - Visual fidelity vs. an actual `cmd+shift+5` screen recording of
     the same flow (side-by-side compare).
   - Install footprint — does it pull headless Chromium / ffmpeg in a
     way that breaks our existing electron-builder pipeline?
   - Determinism — re-render twice; binary diff should be tiny or zero.

## Go / no-go criteria

**Go** if all of:
- Render time < 60s per 10s clip on an M-series laptop.
- Output ≤ 10MB for a 10s 1280×720 clip.
- Visual output is indistinguishable from a screen recording at
  arm's length (allow some text antialiasing differences).
- No system-level deps that a developer would have to `brew install`
  manually beyond what the README says.

**No-go** if any of those fail, or if the agent loop produces
inconsistent renders that need babysitting.

## Fallback ladder (if no-go)

In order of preference:
1. **Pre-recorded screencaps**: `cmd+shift+5` once per release,
   trimmed in QuickTime, dropped into `videos/dist/`. Manual but
   zero deps. Only viable if release cadence stays low.
2. **Animated SVG / Lottie**: ship vector animations directly in the
   renderer bundle. No MP4, no extra surfaces. Loses some
   verisimilitude but works offline forever.
3. **Skip onboarding videos entirely**: lean on the `/help` overlay
   and CHANGELOG. Acceptable v1; revisit after we have more users.

## Out of scope for D1

- TTS narration. Even if HyperFrames supports it, that's a Phase D
  follow-up — silent clips with text overlays are fine for v1, and
  voice quality + API cost are separate decisions.
- User-recorded tours (record-your-own-session). Cool but a different
  product surface.
- CI rendering. Even on Go, renders live in `videos/dist/` committed
  on the release branch, not regenerated per PR.

## Pre-spike readiness checklist

Before scheduling the half-day:
- [ ] Decide which feature gets the first clip (likely slash menu
      or plan-mode pill — both are visually distinctive in <10s).
- [ ] Mock a standalone Vite entry that mounts the chosen component
      in isolation with a hardcoded prop set. Lives at
      `videos/scenes/<feature>/index.html`. We need this regardless
      of whether HyperFrames or screencaps wins.
- [ ] Confirm `npm run videos` script slot is free (it is — checked
      `package.json`).

## Decision log

| Date | Outcome | Notes |
|---|---|---|
| 2026-04-26 | Pre-spike | Notes above written; D1 not yet scheduled. |

(Append rows here once D1 actually runs. Even a no-go is valuable —
without writing it down we'll re-litigate this in three months.)
