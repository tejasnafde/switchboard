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

**2026-07-31**: it came up again, so the deferred copy branching shipped. The
user rotated Default -> Akshaya, retried, and got the identical rejection:

```
{"status":"rejected","resetsAt":1785542400,"rateLimitType":"overage",
 "overageStatus":"rejected","overageDisabledReason":"org_level_disabled_until",
 "isUsingOverage":false}
```

The Usage panel showed 5-hour at 0% and Weekly at 4%, so the account looked
idle while every turn was refused. Both halves of the old message were wrong
for this payload:

1. **"Switch to another provider or instance"** cannot work. `org_level_*` is
   an org-wide admin setting, so every instance in that organisation is blocked
   identically. That is exactly the dead end the user walked into.
2. **"Resets 05:30 AM"** dropped the date. `resetsAt` was the NEXT day, 6.2
   hours out, and an extra-usage cap resets monthly - so the same copy could
   present a reset weeks away as "later today".

Copy now lives in `src/shared/claude-rate-limit.ts` (pure, `nowMs` injected)
with `buildRateLimitMessage` branching on `classifyOverageScope`:
`org` / `account` / `user` / `unknown`. Scope matching is by PREFIX, because
the wire already grew `org_level_disabled_until` on top of
`org_level_disabled`, and an unmatched suffix must not fall back to advice that
cannot work. Reset times reuse `fmtResetsIn` + `fmtResetsAt` from
`shared/provider-usage.ts` and always carry the absolute date.
Tests: `tests/unit/claude-rate-limit-message.test.ts`.

### Root cause: an uncovered MODEL, not an exhausted plan

The plan windows were nearly empty, which is what made this look random. The
actual trigger is the model. Proven by running the CLI per profile:

```sh
for p in akshaya tejas tech-team backend; do
  CLAUDE_CONFIG_DIR=~/.claude-$p claude -p --model claude-fable-5 "reply ok"
done
```

```
akshaya   -> You've hit your org's monthly spend limit
tejas     -> You've hit your org's monthly spend limit
tech-team -> ok
backend   -> ok
```

`opus` / `sonnet` / `haiku` succeeded on ALL FOUR profiles, so nothing is
account-wide blocked. The split is per MODEL, and it matches `limits[]` exactly:

| profile | 5-hour | weekly_all | weekly_scoped | credit cap | fable |
|---|---|---|---|---|---|
| tech-team | 4% | 31% | 8% present | 2000 | ok |
| backend | 6% | 96% | 42% present | 2000 | ok |
| tejas | 48% | 37% | **absent** | 500 | blocked |
| akshaya | 0% | 4% | **absent** | 500 | blocked |

A seat with no `weekly_scoped` row has no plan allowance for that model, so its
usage bills to **org credits** instead of the plan windows. Every one of these
four accounts is over its credit cap, yet two work - which is why "extra usage
100%" in the Usage panel is NOT by itself a fault signal.

The user never selected Fable. Switchboard sent `model=default` and the CLI
resolved it to `claude-fable-5`, so the model was invisible in the UI and absent
from the rejection payload. `ActiveSession.lastKnownModel` now records it from
the `getContextUsage()` poll purely so the message can name it.

Order of checks when this recurs:

1. `--model <the model from the context log line>` against a known-good profile.
   Do NOT test with `claude -p` alone: it defaults to Sonnet and passes on every
   profile, which sent the first pass of this investigation down a dead end.
2. `limits[]` for a `weekly_scoped` row on the failing seat.
3. Only then look at the windows.

### Read the reason enum from sdk.d.ts, do not guess it

`overageDisabledReason` is a closed enum on `SDKRateLimitInfo`:

```
overage_not_provisioned | org_level_disabled | org_level_disabled_until |
out_of_credits | seat_tier_level_disabled | member_level_disabled |
seat_tier_zero_credit_limit | group_zero_credit_limit |
member_zero_credit_limit | org_service_level_disabled |
org_service_zero_credit_limit | no_limits_configured | unknown
```

There is no `user_*` and no `spend_limit_*` value. The first cut of
`classifyOverageScope` matched on both, which was dead code, while five real
values fell through to 'unknown' and got told to retry a permanent admin
toggle. `spend_limit_reached` and `user_disabled` DO exist, but on
`extra_usage` in the usage endpoint, which is a different payload.

Scope mapping, and why the advice differs:

| Scope | Values | Advice |
|---|---|---|
| `org` | `org_*`, `seat_tier_*`, `group_zero_credit_limit` | Admin-wide. Rotating profiles cannot help. |
| `account` | `out_of_credits`, `member_*` | This seat only. Another profile CAN help. |
| `not-provisioned` | `overage_not_provisioned`, `no_limits_configured` | Never set up. Ask an admin to enable it. |

Getting that split wrong reintroduces the original bug in mirror image: telling
a user with an account-scoped block that switching profiles is pointless.

Note the two sources disagree, and the endpoint is the weaker one:
`GET /api/oauth/usage` reported `extra_usage.disabled_reason: null`,
`user_disabled: false`, `spend_limit_reached: false` while the API was
rejecting with `org_level_disabled_until`. So the Usage panel cannot show an
org-level block, and its "Extra usage" row understates the situation. Only the
rejection payload carries that reason. Surfacing the last rejection in the
panel is still open.
