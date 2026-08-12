# Workspace organization flows

## Problem

Workspace organization is split across unrelated surfaces. Add Machine sits inside the machine tree, Add Project and Workspaces compete as equal footer buttons, and the workspace manager repeats Rename, Color, and Delete buttons on every row. Workspaces cannot be reordered from the UI even though the backend already stores and exposes `sort_order`.

Project ordering is also fragile. The sidebar keeps a global `projectOrder` setting, but some refresh paths bypass it and restore the database's `added_at` order. In particular, a workspace-manager mutation reloads raw projects directly and can visibly shuffle projects. Scan completion and refresh timing must never determine the rendered order.

## Interaction model

Use a hybrid flow with two connected surfaces.

### Everyday sidebar

- Replace the separate Add Project and Workspaces footer buttons with one primary **Create** menu and one compact **Organize** button.
- Create contains Project, Workspace, and Machine, plus a secondary Organize Workspaces action.
- Workspace headers reveal a drag grip and `•••` action menu on hover or keyboard focus.
- The action menu contains Rename, Change Color, and Delete Workspace. Delete remains confirmation-gated and explains that projects return to Ungrouped.
- Dragging a workspace header reorders workspaces directly. Keyboard users can reorder with Option+Up/Down.
- Existing project drag-and-drop remains available for everyday project moves and reordering.

### Organizer

- Replace the flat action-button modal with a focused two-pane editor.
- The left pane lists workspaces in their exact sidebar order and supports pointer and keyboard reordering.
- Selecting a workspace shows its editable name, color palette, and ordered project list in the right pane.
- Projects support pointer and keyboard reordering. Dropping a project on a different workspace moves it there.
- New Workspace is available from the organizer header.
- Destructive deletion is not visually promoted; it remains in the workspace action menu with confirmation.
- Changes persist immediately. The organizer does not need a misleading Save button.

The interactive reference is [workspace-flows.html](../mocks/workspace-flows.html).

## Ordering model

Workspace order continues to use `project_workspaces.sort_order`. Reordering writes every displayed workspace id in one transaction and updates renderer state optimistically, rolling back or refreshing on failure.

Project order becomes durable project data rather than a renderer-only global list. Add a `sort_order` column to `projects`, scoped by `workspace_id` through the ordering query and reorder operation. The invariant is:

1. Projects render by workspace order, then project `sort_order`, then `added_at` and path as deterministic fallback.
2. Moving or reordering projects rewrites contiguous positions for every affected workspace in one transaction.
3. A newly added or newly assigned project is appended to its destination workspace.
4. Deleting a workspace moves its projects to Ungrouped and appends them in their prior relative order.
5. Existing `projectOrder` data is migrated once into project positions, preserving the user's current visible order. The compatibility setting may remain readable during migration but is no longer a competing runtime source of truth.
6. Local and remote backends use the same IPC operation and database invariant; scan completion never rewrites ordering.

This removes the current split between DB `added_at`, renderer `projectOrder`, and mutation-specific refresh behavior.

## Visual contract

The production implementation conforms to Switchboard rather than copying standalone mock styling.

- Use existing CSS variables for every background, border, shadow, text color, and focus treatment.
- Do not introduce hardcoded opaque panel colors. Translucent mode must continue exposing macOS vibrancy through root and workspace surfaces; menus and the organizer use the same restrained local tints as existing floating surfaces.
- Retain the app's current font stack, compact desktop density, radius scale, and SVG icon language.
- Avoid generic glass cards, gradients, oversized headings, excessive explanatory copy, pill-shaped controls, and decorative animation.
- Show drag grips only on hover/focus while retaining a persistent accessible reorder mechanism.
- Use tabular numerals for counts and explicit focus-visible styles for every action.
- Motion is limited to interruptible opacity/background/transform transitions and respects reduced motion.

## Components and data flow

- `Sidebar` owns the Create menu, inline workspace drag context, and opening the organizer.
- `WorkspaceManager` becomes the two-pane organizer and receives both workspaces and projects plus mutation callbacks. It does not independently reload projects in raw DB order.
- A shared pure ordering helper computes optimistic workspace/project arrays and is tested separately from React.
- New backend project-reorder IPC accepts the destination workspace and exact ordered paths for affected groups, validates that paths and workspace ids exist, and persists in one transaction.
- Workspace reorder continues through the existing `WORKSPACE_REORDER` channel.
- After successful mutations, renderer state already matches the persisted order. A background refresh may confirm state but must pass through the canonical ordering query.

## Errors and recovery

- Reorder UI is optimistic. On persistence failure, restore the previous arrays and surface one non-destructive error message.
- Rename rejects empty names inline and retains focus.
- Delete requires confirmation and explains the Ungrouped result.
- A stale project or workspace id causes the backend transaction to reject rather than partially reorder.
- Empty workspace and empty project-list states remain usable and offer the appropriate creation or move guidance.

## Verification

- Unit tests cover migration, deterministic query ordering, workspace reorder, within-workspace project reorder, cross-workspace move, deletion to Ungrouped, and rollback helpers.
- Component/source contract tests cover the unified Create menu, semantic workspace menus, keyboard reorder controls, and removal of the old repeated action buttons.
- Packaged Electron Playwright exercises Create, organizer open/close, workspace reorder, project reorder/move, persistence across relaunch, and tour dismissal.
- The existing visual suite runs in Dark, Light, and Translucent. It verifies that the organizer and popovers use theme variables and that wallpaper transmission remains visible in Translucent.
- Final review compares the result against the mock for hierarchy and against the live Switchboard surfaces for density and visual language. Deslop removes copied mock ceremony, inline-style sprawl, redundant guards, and stale comments.

