# Rate-limit debugging (Claude Code)

If a user reports switching OAuth profiles / models and getting "no error, no
response, nothing" - or a scary "rate limit reached" that clears on retry -
start here.

## Where it's handled

`src/main/provider/adapters/claude-adapter.ts` - the `case 'rate_limit_event'`
block. The SDK emits `rate_limit_event` with `rate_limit_info` of type
`SDKRateLimitInfo` (see `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`,
search `SDKRateLimitInfo`). We only surface a chat error when
`rate_limit_info.status === 'rejected'`.

## What we log

On every rejection:

```
[WRN] [provider:claude] rate_limit rejected for <threadId> { ...full rate_limit_info... }
```

Find it with:

```sh
grep -n "rate_limit rejected" ~/Library/Application\ Support/switchboard/logs/switchboard-*.log
```

The object is logged in FULL (status, rateLimitType, resetsAt, utilization,
overageStatus, overageDisabledReason, isUsingOverage). Read those fields to tell
what kind of rejection it was.

## Reading the payload

- **Real five-hour / weekly window**: carries `rateLimitType` (`five_hour`,
  `seven_day`, …) AND `resetsAt`. The account is genuinely blocked until
  `resetsAt`. Switching to another account/instance is the correct fix.
- **Empty-ish payload** (`status: 'rejected'` but no `rateLimitType`/`resetsAt`):
  almost always an **overage/credit** block, not a window limit. Look at
  `overageStatus` / `overageDisabledReason` (e.g. `out_of_credits`,
  `org_level_disabled`, `seat_tier_level_disabled`). These are often transient
  and **clear on retry** - the same profile works seconds later, and works well
  before any `resetsAt` would have elapsed.

## History

**2026-07-25**: user switched across 5 OAuth profiles and saw rate-limit errors
on each. Two of three rejections had empty payloads (`{}` in the old log line,
which dropped everything but rateLimitType/resetsAt) and cleared on retry - the
accounts were never actually five-hour-limited. Fixes shipped:

1. Log the full `rate_limit_info` (was `{rateLimitType, resetsAt}` only, so
   overage rejections were indistinguishable from real ones).
2. Emit `turn.completed` on the rejection path. A rejection produces no `result`
   message, so the turn was left stuck on `running` with no end indicator - that
   was the "no response, nothing" symptom.

Still deferred: branching the user-facing copy so an overage rejection doesn't
say "wait for the window to reset" (misleading - a retry usually works). Add
when it comes up again; the full log now makes the distinction visible.
