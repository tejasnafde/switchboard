# Configurable Recents and Activity Design

## Goal

Keep Recents compact by default while allowing people with larger working sets
to expose more conversations. Make background and actionable activity legible
without generic blinking dots.

## Interaction

- Settings > General adds a **Recent conversations** choice with 4, 6, 8, and
  12 rows. The default remains 4.
- The collapsed Recents section renders that many rows. When more conversations
  exist, a quiet **Show N more** button expands the section inline to all rows;
  **Show less** returns to the configured baseline.
- The setting controls only the collapsed baseline. It is not a hard maximum.
- Expansion is local UI state. The baseline is persisted through the existing
  settings API.

## Status Presentation

Recents uses the same priority order as T3 Code's current sidebar model:

1. Approval
2. Input / question
3. Working
4. Failed
5. Done / unread completion
6. Ordinary recency

Actionable and live states use restrained semantic icons and short labels.
Nothing pulses or blinks. Color reinforces the icon and text but is not the
only signal. Ordinary rows keep their relative timestamp.

The existing unread count remains the source for completion attention. Opening
a conversation clears that state through the existing agent-store flow.

## Data Flow

`Sidebar` loads the persisted baseline and requests the complete ordered recent
set. `deriveRecentSessions` attaches a status to each item from live session
state and unread count. `RecentSessionsSection` owns temporary expand/collapse
state and slices only for presentation.

The recents subscription signal includes status, pending approval/question, and
unread count so streamed tokens do not rerender the whole sidebar while real
activity changes do.

## Testing

- Unit tests cover status priority and unread completion.
- Render tests cover semantic icons/labels and Show more / Show less behavior.
- Settings tests cover defaulting, validation, persistence, and available
  choices.
- Packaged Playwright dismisses the tour, changes the Recents baseline, injects
  enough fixture rows to exercise expansion, and verifies the semantic status
  treatment without blinking-dot classes.

