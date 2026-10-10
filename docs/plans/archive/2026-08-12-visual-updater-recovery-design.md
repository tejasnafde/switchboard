# 0.8.24 Visual and Updater Recovery

## Problem

The 0.8.24 visual hardening regressed the translucent theme by painting a
70%-opaque tint over the renderer root and then stacking additional opaque
panel treatments on top. It also made the Full Access selector permanently
amber and used a low-contrast gray for meaningful dark-theme text. Separately,
the updater retains its first `BrowserWindow`, so a recreated window can miss
the terminal `downloaded` state, and the update help affordance relies on an
unreliable native `title` tooltip.

## Design

The translucent renderer root remains transparent so Electron's native macOS
vibrancy is visible. Readability comes from restrained, local material tints on
the sidebar, headers, composer, input, and terminal instead of a window-wide
overlay. Full Access uses the same neutral control treatment as other runtime
modes; its label communicates the behavior without a warning glow. Dark-theme
informational gray text gets a WCAG-readable token, while truly disabled text
uses a separate low-emphasis token.

Updater state becomes process state rather than window state. Main broadcasts
every transition to all live windows and exposes the latest status through an
IPC query. The Settings row subscribes first and then hydrates from that query,
so either ordering converges on the latest state. The help affordance becomes a
button that opens a visible, keyboard-accessible popover and closes on Escape or
outside click.

## Verification

- Unit tests cover updater state replay and dark-theme contrast.
- Playwright runs the real packaged application with isolated user data.
- The visual test proves that translucent `#root` is transparent, panel tints
  remain translucent, Full Access has no amber border or shadow, meaningful
  muted text meets 4.5:1 contrast, and the update help popover opens by click.
- Screenshots are inspected before the full typecheck, unit, build, smoke, and
  release gates run.

