# Saved View and Machine Collapse Persistence

## Goal

Remove the Saved section from the scrolling Threads hierarchy and remember
whether each machine was expanded or collapsed across application launches.

## Saved View

The normal sidebar header renders **THREADS**, a bookmark button, and the
existing new-thread button. The bookmark button switches the sidebar body to a
dedicated Saved view instead of opening a popover.

The Saved header renders a back button, **SAVED**, and the bookmark count. Its
body uses the existing saved-message rows, including message role, conversation
title, excerpt, relative save time, removal, and jump-to-message behavior.
Selecting a saved message opens the conversation and requests the existing
timestamp-based scroll without implicitly leaving Saved; the explicit back
button returns to Threads. The view remains reachable with zero bookmarks and
shows a restrained empty state.

The Threads filter, Recents, machines, workspaces, and projects are hidden while
Saved is active. Returning to Threads restores their existing component state.
The implementation reuses the established sidebar colors, spacing, focus rings,
and transparent theme surfaces.

## Machine Disclosure Persistence

The machine store continues to own a `Set<string>` of collapsed top-level
machine IDs. It hydrates that set from `sidebar.collapsed.machines` and writes a
JSON string array whenever `toggleCollapsed` changes it. Unknown and newly
created machine IDs default expanded. Removing a machine prunes its persisted
collapse entry.

This change does not persist remote project disclosure state and does not alter
project or workspace collapse behavior.

## Error Handling

A missing, malformed, or unavailable settings value falls back to an empty set,
leaving all machines expanded. Settings write failures do not block the local
toggle.

## Testing

- Unit tests cover parsing, hydration, toggling, persistence, malformed values,
  and removal cleanup for machine IDs.
- Sidebar source/render tests cover the header Saved entry point, dedicated
  view, empty state, and removal/navigation wiring.
- Electron Playwright opens Saved from the header, returns to Threads, collapses
  a machine, relaunches, and verifies that the machine remains collapsed.

