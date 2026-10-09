# Compact native Android tool activity

## Outcome

Native Android thread tool calls become a quiet, accessible activity list. Each collapsed tool occupies one 48 dp touch row, shows a stable status/icon slot, a humanized label, and the existing bounded useful summary. Only completed tools with nonblank output are expandable, and expansion reveals selectable output directly beneath the same stable feed row.

## Confirmed cause

`ThreadScreen.kt` currently renders every `ThreadRowPresentation.Tool` through `ToolRow`, which wraps a 48 dp `PressableLine` in `CardContainer`. The container adds 7 dp vertical margin on each side and 14 dp inner padding on each side. A collapsed tool therefore consumes approximately 90 dp before card borders, while the useful 140-character summary produced by `ThreadPresenter` remains hidden until expansion. Expansion then repeats that summary in an `Input` block.

Desktop `ToolCallBlock.tsx` and React Native/iOS `ToolItem` already present compact label/detail rows, so this change brings native Android into the established product contract without modifying those surfaces.

## Considered approaches

1. **Flat inline row with lazy full output only when expanded (chosen).** This removes redundant chrome, preserves full output, composes it in bounded newline-aware pages, keeps the interaction local, and does not introduce navigation or storage work.
2. **Flat row with a bounded output preview and a second “show full” state.** This protects against very large output but adds another control and state transition. It is unnecessary because collapsed rows compose no output, and the current feed already stores the full value.
3. **Dedicated output inspector.** This provides the most room for very large output but broadens the task into Android navigation and lifecycle work, which is explicitly out of scope.

## Presentation model

Provider-specific input parsing remains outside Compose. `ThreadRowPresentation.Tool` will expose:

- stable `key` inherited from the feed item identity;
- normalized `label`;
- bounded `detail`;
- provider-agnostic `iconKind`;
- `monospaceDetail` for commands, paths, patterns, and URLs;
- normalized running/completed state;
- output and derived expandability.

The presenter will normalize Claude, Codex, OpenCode, notebook, MCP, and unknown aliases. It will safely accept object, null, scalar, array, or malformed input values. Unknown tools receive a humanized label and the best meaningful command/path/query/description, falling back to bounded input keys rather than raw JSON.

## Compose behavior

`ToolRow` will no longer use `CardContainer`. Its collapsed surface will be one full-width 48 dp row aligned to neighboring assistant content with:

1. a fixed-width leading slot containing either an indeterminate spinner or a quiet tool-kind/completion icon;
2. a humanized label;
3. the useful detail on the same line, visually ellipsized while retaining the full bounded detail in merged semantics;
4. a decorative disclosure icon only for completed tools with nonblank output.

Only expandable rows receive click semantics and `Role.Button`. Expansion is stored with `rememberSaveable(row.key)`, so a running-to-completed update and unrelated feed recomposition preserve the state for that stable tool identity. Expanded output is composed lazily only after the user requests it, appears immediately below the row without card chrome, and remains readable and selectable in bounded pages. A copy action preserves one-step access to the complete value.

## Accessibility

The collapsed row is one merged semantics node. Its content description names the label, full bounded detail, and running/completed state. Expandable rows expose Compose expanded/collapsed state plus show/collapse actions. Non-actionable rows have no button role or click action. Spinner and icons are decorative descendants, preventing redundant focus stops. The leading and trailing slots are fixed, the label does not shrink, and the detail owns the remaining width so large fonts ellipsize without overlapping affordances.

## Live behavior and ordering

No runtime event, identity, reducer, feed ordering, or pending-approval policy changes are required. `tool.started` and `tool.completed` continue to upsert by `t-<toolId>`, `turn.completed` continues to terminalize abandoned running rows, and `ThreadFeedLayoutPolicy.declarationOrder` continues to compensate for the reversed `LazyColumn`. Stable row keys keep expansion attached to the intended tool.

## Testing

TDD will add presenter tests for aliases, malformed/non-object input, summary normalization and bounds, label/icon/state, and stable keys. Compose regressions will cover collapsed summary visibility, absent redundant input/output, output-only disclosure, running semantics, toggle behavior, per-tool expansion, ordering, in-place updates, recomposition stability, collapsed semantics isolation, minimum bounds, merged semantics, large fonts, and dense multi-tool scrolling/height.

Automated verification will include focused unit and instrumentation compilation/tests, the Android unit/lint/assemble gate, repository typecheck and tests when practical, and feature-parity validation. Connected tests and manual TalkBack/device/font/orientation checks will be reported only if suitable hardware or an emulator is available.

## Cross-surface scope

- **Desktop Electron:** Not applicable. `ToolCallBlock.tsx` already uses compact label/detail rows; it is evidence only.
- **React Native/iOS:** Not applicable. `ToolItem` already uses a quiet one-line summary, tool icon, spinner, and output disclosure; it is evidence only.
- **Native Android:** Implemented in the presentation model, Compose UI, and tests.
- **Shared backend/API:** Not applicable. Existing runtime events and provider normalization remain unchanged.
- **Stored data/migrations:** Not applicable. Expansion is transient state and historical tool data already includes input/output.
- **Update/release:** Not applicable to identity, signing, schema, or update channels. The fix is included in the next native Android release, and the debug APK must still assemble.
