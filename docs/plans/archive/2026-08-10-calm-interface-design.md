# Calm Interface Design

## Goal

Make Switchboard's desktop workspace calmer and easier to scan without removing,
reimplementing, or hiding existing capabilities. The change is a presentation layer
over the existing session, message, provider, terminal, IDE, and persistence systems.

This design deliberately avoids a visual reskin. It changes information hierarchy:

- recent and actionable conversations become the fast path;
- the complete machine/workspace/project/session tree remains available;
- assistant prose stays visually primary;
- tool activity and changed files become compact turn-level disclosures;
- consequential state is expressed with restrained text and boundaries;
- normal state does not receive a colored dot, chip, or label.

Mobile navigation and first-run onboarding are related follow-ups, not part of this
implementation. Keeping them separate limits regression surface.

## Visual Direction

The interface should feel like a native engineering utility rather than an AI control
center.

- Keep Switchboard's system UI font. Use monospace only for code, branches, paths,
  exact counts, and terminal content.
- Use flat rows and hairline separation. Do not turn navigation or transcript items
  into collections of cards.
- Reserve shaped surfaces for the user message, actionable approval/error states,
  and the composer.
- Use color only for semantic risk or failure. Normal running, idle, or completed
  state should usually be unlabelled.
- Apply Crystal Glass to broad structural surfaces. Floating and actionable content
  remains sufficiently opaque over arbitrary wallpaper.

The approved reference artifact is
`docs/demos/calm-workspace-mock.html`, with solid and Crystal Glass screenshots beside
it. T3 Code informed the structural restraint: flat assistant prose, compact tool
disclosures, turn-level changed-file grouping, plain breadcrumbs, and neutral sidebar
surfaces. Its colored status labels, dots, plan telemetry, file chips, and pill-heavy
composer are explicitly not adopted.

## Scope

### 1. Semantic navigation rows

Conversation, project, workspace, and machine actions use native buttons where the
whole row performs an action. Separate nested actions remain separate buttons and do
not trigger the row action. Keyboard focus is visible and context menus, drag handles,
and existing shortcuts continue to work.

### 2. Recent conversations

A derived Recents section appears above the complete workspace browser. It includes a
small bounded set of active, actionable, and recently used conversations across local
and remote machines.

Recents is not persisted and is not a new source of truth. It is derived from existing
session state. The same session may appear in Recents and in the workspace tree, and
both entries invoke the same selection path.

Ordering rules:

1. conversations needing user action;
2. running conversations;
3. remaining conversations by most recent activity.

Archived conversations are excluded. Duplicate session ids are collapsed. Normal
state is represented by time alone; only actionable or exceptional states receive a
word such as `Approval`, `Question`, `Failed`, or `Offline`.

### 3. Workspace browser hierarchy

The existing machine -> workspace -> project -> conversation hierarchy remains intact
below Recents. Visual weight, indentation, and contextual action reveal distinguish
levels. Drag, reorder, collapse persistence, cached remote browsing, connection flows,
unread state, and conversation context menus remain behaviorally unchanged.

### 4. Transcript presentation

The existing chronological message record and `groupIntoTurns` behavior remain the
source of truth. A pure presentation projection classifies turn contents into:

- conversation: user and assistant prose;
- outcomes: plans, questions, approvals, errors, and changed files;
- activity: reasoning, tool calls, timing, and neutral system metadata.

The projection must preserve every message id and attachment. It may group or collapse
items, but it may not discard them.

Activity renders as one turn-level disclosure. Expanded activity uses flat rows and a
single indentation rule, without per-tool cards or success colors. Failures remain
visible and are not hidden inside a closed neutral summary.

Changed files render as one turn-level disclosure with aggregate additions and
deletions. Existing `FileDiffCard` handlers and per-hunk behavior remain unchanged when
review is opened.

### 5. Header and composer state

Machine, project, and conversation identity render as a plain breadcrumb. Branch or
worktree identity is secondary text rather than a chip.

The composer retains all current controls and behavior. Its default presentation is
reduced to one configuration disclosure plus attachments and send/stop. Consequential
runtime state remains directly visible:

- Full Access: restrained amber boundary and text;
- remote session: machine identity in the breadcrumb;
- worktree: branch text in the header;
- disconnected/reconnecting: quiet persistent state strip;
- needs input: prominent outcome action in the transcript.

## Non-goals

- No provider, runtime-event, database, or session schema changes.
- No changes to terminal or IDE mounting and persistence.
- No removal of settings, runtime modes, provider profiles, reasoning effort, branch
  selection, context usage, or slash commands.
- No mobile redesign in this change.
- No first-run onboarding redesign in this change.
- No attempt to copy T3 Code's visual identity.

## Regression Contracts

The implementation must preserve:

- active-session selection and restoration;
- local, remote, worktree, and rotated-profile conversations;
- unread counts, notifications, archive, rename, export, and context menus;
- drag/reorder and collapse persistence;
- approvals, questions, plans, errors, denied tools, and interrupts;
- file-diff accept/reject and per-hunk review;
- attachment-only messages;
- streaming projection and interrupted turns;
- dual chat, terminal, IDE, and narrow-pane behavior;
- dark, light, translucent, and translucent-fullscreen fallback themes.

## Implementation Strategy

Land small reversible slices:

1. characterization tests and semantic row conversion with no intentional visual
   change;
2. pure recent-session derivation and Recents rendering;
3. pure turn-presentation projection and compact activity disclosure;
4. changed-file grouping while retaining existing review handlers;
5. breadcrumb, contextual row actions, composer hierarchy, and theme polish;
6. full-suite, build, performance, accessibility, and real Electron theme validation.

The current renderer remains available behind an internal development fallback while
the presentation projection is dogfooded. Removal is a separate cleanup after the new
path is stable.

## Testing

Each behavioral slice follows red-green-refactor: add a focused failing test, verify
the expected failure, implement the minimum change, and rerun the focused suite before
continuing.

Required coverage includes:

- pure ordering/deduplication tests for Recents;
- invariant tests proving the transcript projection preserves message ids and
  attachments across every runtime attachment type;
- interaction tests for approvals, questions, plans, diffs, context menus, drag
  handles, keyboard selection, and focus;
- provider fixtures for Claude Code, Codex, and OpenCode;
- long-session and large-sidebar performance checks;
- fixed-size visual checks for dark, light, translucent, narrow, dual-chat, remote,
  running, needs-input, expanded-activity, and changed-file states;
- `npm run typecheck`, the full unit suite, and the gated production build.

Native macOS vibrancy receives a real Electron smoke check because browser screenshots
cannot reproduce operating-system compositing exactly.

## Acceptance

The change is acceptable when all existing actions remain reachable and tested, the
full hierarchy is still available, no message or attachment disappears from the
presentation projection, the primary chat path visibly matches the approved restrained
mock, and the old rendering path can be restored without a data migration.
