# Rate Limit Event Handling - Design

**Date:** 2026-06-10
**Status:** Approved

## Background

Starting June 15 2026, Anthropic moves `claude -p`, Agent SDK, and GitHub Actions usage out of
the shared subscription pool into a separate monthly credit bucket (Pro $20/mo, Max 5x $100/mo,
Max 20x $200/mo). When credits exhaust, the Claude Agent SDK emits a `rate_limit_event` message
with `rate_limit_info.status === 'rejected'`. Without handling this, turns silently fail with no
explanation surfaced to the user.

Switchboard is currently on `@anthropic-ai/claude-agent-sdk ^0.2.114`. The `rate_limit_event`
message type and `SDKRateLimitInfo` shape have been stable since 0.2.77 - no SDK upgrade is
needed to fix this.

## Goal

Surface a clear, actionable error to the user when their Claude Code credit window is exhausted,
without introducing new event types, new UI components, or any risk to existing users who are
nowhere near their limits.

## Decision: Approach A - Adapter-only, zero new types

Add a single `case 'rate_limit_event':` to the `handleSDKMessage` switch in
`claude-adapter.ts`. On `status === 'rejected'`, emit the existing `RuntimeErrorEvent` +
`RuntimeStatusEvent('error')`. All other statuses (`allowed`, `allowed_warning`) are silently
dropped.

**Rationale:**
- Zero changes to `provider-events.ts`, `ChatPanel.tsx`, `MessageBubble.tsx`, or
  `exportMarkdown.ts` - the existing error bubble and red-status-dot rendering cover everything.
- No IPC schema changes means no renderer-side risk.
- `allowed_warning` handling (proactive near-limit toasts) is explicitly deferred - it can be a
  clean follow-up PR if needed. The user confirmed: only surface on hard rejection.
- The SDK likely fires one `rate_limit_event` per turn; debounce guards are unnecessary
  complexity for now.

## Implementation

### `src/main/provider/adapters/claude-adapter.ts`

Add after the existing `'result'` case in `handleSDKMessage`:

```ts
case 'rate_limit_event': {
  type RateLimitMsg = SDKMessage & {
    rate_limit_info?: {
      status?: string
      rateLimitType?: string
      resetsAt?: number
    }
  }
  const rl = (msg as RateLimitMsg).rate_limit_info
  if (rl?.status === 'rejected') {
    const resetPart = rl.resetsAt
      ? ` Resets ${new Date(rl.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : ''
    const windowPart = rl.rateLimitType
      ? ` (${rl.rateLimitType.replace(/_/g, '-')} window)`
      : ''
    active.onEvent({
      type: 'error',
      threadId,
      message: `Claude Code credit limit reached${windowPart}.${resetPart} As of June 15, claude -p and Agent SDK usage draws from a separate monthly credit bucket. Check anthropic.com/billing to top up or wait for the window to reset.`,
    })
    active.onEvent({ type: 'status', threadId, status: 'error' })
    log.warn(`rate_limit rejected for ${threadId}`, { rateLimitType: rl.rateLimitType, resetsAt: rl.resetsAt })
  }
  break
}
```

### Files changed

| File | Change |
|---|---|
| `src/main/provider/adapters/claude-adapter.ts` | Add `case 'rate_limit_event':` (~20 lines) |
| `tests/unit/claude-adapter-rate-limit.test.ts` | New test file (4 cases) |

### Files NOT changed

- `src/shared/provider-events.ts` - no new event types
- `src/renderer/components/chat/ChatPanel.tsx` - existing `error` handler covers it
- `src/renderer/components/chat/MessageBubble.tsx` - existing red error bubble covers it
- `src/main/ipc/enrichDisplayBody.ts` - error messages already handled
- `src/main/agent/exportMarkdown.ts` - error messages already export as plain text

## Tests

New file `tests/unit/claude-adapter-rate-limit.test.ts`:

1. `rate_limit_event` with `status: 'rejected'` + `rateLimitType` + `resetsAt` → emits
   `RuntimeErrorEvent` with copy containing window + reset time, then `RuntimeStatusEvent('error')`,
   then logs a warn.
2. `rate_limit_event` with `status: 'rejected'`, no `rateLimitType`, no `resetsAt` → emits error
   with minimal copy (no crash on missing fields).
3. `rate_limit_event` with `status: 'allowed'` → emits nothing.
4. `rate_limit_event` with `status: 'allowed_warning'` → emits nothing.
5. `rate_limit_event` with missing `rate_limit_info` entirely → emits nothing (defensive).

## Out of scope

- `allowed_warning` near-limit toasts - deferred.
- New `RuntimeRateLimitEvent` type - deferred until there's a reason to distinguish rate-limit
  errors from other errors in the renderer.
- Codex / OpenCode adapters - Codex already forwards `account/rateLimits/updated` via its own
  event pipeline. OpenCode (ACP) has no equivalent yet.
- SDK upgrade to 0.3.x - orthogonal; tracked separately.
