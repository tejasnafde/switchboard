# Crystal Glass Translucency Recovery

## Problem

The translucent theme can switch the renderer to transparent after launch, but
the macOS `BrowserWindow` is created with native transparency only when the
saved startup theme is already translucent. Native window transparency is a
construction-time capability, so switching from dark or light exposes an
opaque black backing even though the DOM reports transparent backgrounds.

The 0.8.25 renderer also retains charcoal surface tints between 18% and 55%.
Those layers are materially darker than the 3% to 5% tints used by the original
crystal theme and obscure wallpaper color even when native vibrancy is active.

## Design

On macOS, every main window is created transparency-capable with a transparent
native background. Vibrancy remains enabled only while the selected theme is
translucent. Dark and light themes remain visually opaque because their HTML,
body, and root surfaces paint solid theme backgrounds.

The translucent palette returns to the original near-clear material: the main
workspace, sidebar, and titlebar expose native vibrancy directly; structural
surfaces use only minimal neutral tints; floating dialogs remain opaque for
legibility. The improved text contrast and neutral runtime-mode treatment from
0.8.25 remain intact.

## Alternatives Rejected

- Relaunching when Translucent is selected would recreate the window with the
  right native capability, but makes a visual preference destructive to active
  terminals and agent turns.
- CSS-only glass cannot reveal the desktop behind an Electron window and would
  continue to pass DOM-level tests while the native backing stays black.

## Verification

- Unit tests cover construction-time appearance for dark, light, and
  translucent themes on macOS and other platforms.
- A packaged Playwright test starts from a fresh dark profile, switches to
  Translucent without relaunching, and confirms the window remains usable.
- The visual test places a controlled colorful native window behind
  Switchboard and inspects an OS-composited capture. It must prove that color
  transmits through the workspace; transparent DOM styles alone are not
  sufficient.
- The same test switches back to dark and proves the renderer is opaque.
- Full typecheck, unit, build, smoke, review, and deslop gates run before the
  patch release is tagged.
