# Incremental Recents Design

## Goal

Keep the configured Recents baseline while preventing one expansion click from
rendering the entire conversation history.

## Interaction

- Settings continues to control the initial Recents count: 4, 6, 8, or 12.
- When additional conversations exist, the control reveals five more rows per
  click.
- Its label names the next batch, not the complete hidden total: **Show 5 more**
  until fewer than five remain, then **Show N more** for the remainder.
- Once expanded, **Show less** collapses directly to the configured baseline.
- Changing the configured baseline resets the temporary expansion depth.

## Scope

Existing Approval, Input, Working, Failed, Done, and ordinary-recency ordering
is unchanged. This change adds no pinned, settled, snoozed, archived, or
database behavior.

## Testing

- Pure unit tests cover successive five-row pages and the final partial page.
- Renderer tests cover the initial button label and preserve the existing
  semantic activity treatment.

