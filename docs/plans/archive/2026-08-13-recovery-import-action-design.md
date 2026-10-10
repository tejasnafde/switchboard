# Recovery Import Action Design

## Problem

The recovery inventory renders its row action with a `settings-button` class that has no stylesheet definition. Electron therefore displays the browser-native button, which is visually inconsistent with the rest of Switchboard.

## Design

Use a recovery-specific `recovery-modal-action` class instead of coupling the modal to settings UI. The action remains a semantic button and keeps the existing Import, Promote, and Importing labels.

The compact visible control will use Switchboard's accent and surface tokens. Its interaction contract includes a clear hover state, a keyboard-visible focus ring, a subtle `scale(0.96)` pressed state, and a disabled/importing state that removes the press affordance. A minimum 40px desktop hit area will be provided without making the visible button oversized.

## Testing

A renderer regression test will verify that importable rows use the dedicated class and that the stylesheet defines the base, hover, focus-visible, active, and disabled contracts. Existing modal tests and the project validation gates must remain green.

## Release

Commit the fix to `main` without changing the version, creating a tag, pushing a release, or publishing artifacts. It will be included in the next planned release.
