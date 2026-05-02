# Tech debt log

Living list of small refactors worth doing when adjacent code changes.
Don't make a separate sweep; pick these up as they intersect with feature
work.

---

## Inline-style sprawl in chat / kanban / sidebar

**Surfaced**: 2026-05-02 review of pill-preservation + workspace-unread + worktree-modal branch.

A pile of new presentational components ship with everything-inline `style={{…}}` blobs:

- `Spinner` / `SkeletonRow` (`WorktreeManagerModal.tsx`)
- `WorkspaceUnreadBadge` (`Sidebar.tsx`)
- `PillChipVisual` (`chat/lexical/PillChipVisual.tsx`) — extracted to share between editor + bubble
- Various ad-hoc badge/chip styles inside `CardModal`, `MessageBubble`, etc.

Each is fine in isolation. Together they make global theme tweaks (e.g. "tighten chip padding") a multi-file find-and-replace, and they make accessibility / hover / focus states harder to layer in (no `:hover` from inline styles).

**When to pay it down**: next time we touch any two of these in one PR, or whenever we add a fourth chip-shaped thing. Move shared chip styling to either:

1. CSS modules under `src/renderer/styles/` keyed by class names (consistent with `global.css` for sidebar / themes), or
2. A small `components/ui/` folder with `Chip`, `Badge`, `Spinner`, `Skeleton` primitives.

The win is consistency — today the kanban-tile chip, the workspace-unread badge, and the pill chip use three slightly different padding/radius values and the drift will only widen.

**Cost**: half-day to enumerate all chip-like UI, pick a primitive shape, and migrate. Low risk because it's pure CSS — visual diff only.
