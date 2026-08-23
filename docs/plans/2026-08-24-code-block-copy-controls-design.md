# Stable Markdown Code-Block Copy Controls

## Problem

Desktop chat renders Markdown with `marked.parse` and then decorates `<pre>` nodes with copy buttons after a 120 ms delay. Streaming updates replace the `dangerouslySetInnerHTML` subtree, deleting those imperatively-owned buttons. A session-wide running status attempts to suppress provisional controls, but provider event timing can briefly make the whole session appear settled before the final coalesced content commit. This produces flicker and inconsistent controls. `PlanCard` duplicates the same imperative decoration path.

The existing content coalescer remains valuable: it limits renderer commits to roughly 30 fps and flushes pending content before every non-content event. This design preserves that ordering contract.

## Chosen design

Create one shared desktop Markdown rendering seam around Marked. Its custom code renderer emits the complete `<pre>/<code>/button` structure atomically, using Marked's normal code escaping and explicitly escaped generated attributes. `MessageBubble` and `PlanCard` use this renderer. Each Markdown root owns one delegated click handler; no per-block listeners, DOM append pass, observer, or retry loop is used.

Copy controls always exist in rendered settled code-block markup. During an active message, a control is visually hidden only when its block is provisional. A fenced block whose closing fence is present is stable even if later prose or another block in the same message continues streaming. Indented or unclosed code remains provisional until the message settles. Copying reads only the descendant `<code>` text. Component state records copied feedback by block index, survives unrelated rerenders, resets after the existing 1.5 second interval, and handles clipboard rejection without an unhandled promise.

## Transient lifecycle

Add a renderer-local lifecycle registry keyed by thread and message ID. A normalized `content` event marks that message mutable before it enters either the 30 fps coalescer or the streaming-disabled buffer. Every non-content event still flushes coalesced content first. `turn.completed` drains streaming-disabled content and then settles all message IDs touched by that thread's turn. Terminal error and idle/exited status events also settle the touched set; local interruption and provider-stop recovery clear it as a backstop.

Messages absent from the transient registry are settled, so persisted history and virtualized remounts need no durable state or migration. The registry is shared across mounted chat panels so the existing single-claimer provider event reduction cannot strand another panel with stale local lifecycle state.

## Existing behavior preserved

Inline file-reference pills remain a separate enhancement pass and no longer influence code-copy availability. Marked remains the Markdown engine and raw-HTML behavior is not broadened. The coalescer's cumulative-snapshot, append-delta, and flush-before-non-content behavior is unchanged. `ToolCallBlock` keeps its React-owned implementation but adopts the same accessible label, clipboard failure handling, feedback timing, and shared visible/focus/coarse-pointer styling.

## Presentation and accessibility

Settled controls have a quiet visible resting opacity on fine-pointer desktops, stronger hover and `:focus-visible` treatment, and persistent visibility for coarse pointers. Provisional controls are hidden with CSS without an entrance animation. Buttons use `type="button"`, an accessible name, and native keyboard activation.

## Alternatives considered

A React token renderer would provide direct React ownership for every Markdown node, but replacing Marked's full output path risks unrelated rendering regressions and is disproportionate to this bug. A CSS-only or session-status-only adjustment is smaller but cannot distinguish a mutable message from older messages or preserve a closed earlier block while later content streams.

## Cross-surface scope

- Desktop Electron: affected; renderer, lifecycle, styles, and tests change.
- React Native/iOS: not applicable because `apps/mobile` uses its own React Native block parser and renderer and currently has no shared desktop copy-control contract.
- Native Android: not applicable because `ThreadRichTextRenderer.kt` uses Compose-native code blocks and does not share the desktop Marked renderer or copy-control path.
- Shared backend/API: not applicable; normalized event types and ordering remain unchanged.
- Stored data/migrations: not applicable; mutable/settled state is transient renderer state.
- Packaging/rollout: renderer-only bug fix with no feature flag, package identity, signing, update-channel, or compatibility change.

## Verification

Pure renderer and lifecycle tests cover provisional and settled fences, multiple blocks, exact copied text, feedback/reset/rejection, historical defaults, cumulative snapshots, append deltas, flush-before-completion, unrelated events, and abnormal termination. Component/DOM tests cover delegated keyboard-accessible controls, inline file-pill preservation, remounting, PlanCard reuse, and rerender stability. CSS contract tests cover resting, focus-visible, coarse-pointer, and provisional visibility. Targeted tests run red before implementation, followed by typecheck, the complete Vitest suite, feature-parity validation, available Electron manual checks, and an adversarial Claude Code review.
