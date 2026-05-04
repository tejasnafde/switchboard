# Roadmap — deferred features

Features that have a clear product shape but are not in the immediate work
queue. Captured here so they don't get lost when the next conversation
boots fresh. Each section ends with a "what unblocks this" note so we
know what would have to change to pull it into the active queue.

Last refreshed: 2026-05-04.

---

## 1. Slack `@Switchboard` → kanban card (with two-way sync)

**Shape.** Install a Slack app (bot user). Subscribe to `app_mention`
events. When someone mentions `@Switchboard` in any thread:

1. Pull the thread via Slack API.
2. Run a single cheap-model turn (using whichever provider is configured —
   Claude / Codex / OpenCode) that emits structured JSON:
   `{title, description, suggested_project, suggested_runtime_mode}`.
3. Insert into `kanban_cards` (existing table). Card lands in `Backlog`
   for the suggested project, or in an "Inbox" column if the project is
   ambiguous.
4. Reply in-thread with a deep link `switchboard://card/<id>` and copy:
   "card added, fill it in to start work."

**Two-way sync (the differentiator).** When a kanban card transitions to
`done` (and has a `slack_thread_ts` recorded), post back into the
original thread:
> ✅ shipped — PR #123

Closes the loop without copy-paste. Same hook fires on `needs_input`:
> ⚠️ paused — agent is waiting for your input on `<card title>`

**Edge cases.**
- No provider configured → card lands as raw text, no auto-fill.
- Provider quota exceeded → same fallback.
- Project unclear → land in Inbox column.
- User invokes `@Switchboard` in a DM rather than a channel → still
  works; card is created against the user's default project.
- Mention without text → reply asking for description.

**Architecture (the part that's deferred).** Switchboard is a desktop
app, so the Slack webhook receiver can't live inside Electron. Two
options:

- **Cloud relay.** Tiny stateless service (Cloud Run / Fly / Workers)
  that receives Slack events and proxies to the user's running
  Switchboard over a long-lived WebSocket. Handles the auth token issue
  and lets users on locked-down networks still receive events. Cost:
  small but ongoing. Risks: PII transit, multi-tenant auth.
- **User-hosted tunnel.** User exposes Switchboard via Tailscale Funnel
  / ngrok / cloudflared. Switchboard listens on a configurable port.
  Zero hosting cost, more setup friction, no PII concerns.

**What unblocks this.** A decision on cloud vs user-hosted (or "both,
user-hosted by default, cloud as paid SaaS"). Until then, the desktop
side of the work is straightforward: add a `kanban_cards.slack_thread_ts`
column, an "Inbox" column to the kanban, and a webhook listener that we
can wire up to either transport later.

**Reference.** vibe-kanban's `crates/relay-*` family
(`relay-client`, `relay-control`, `relay-hosts`, `relay-protocol`,
`relay-tunnel`, `relay-tunnel-core`, `relay-types`, `relay-webrtc`,
`relay-ws`) is a complete reference implementation of the user-hosted
tunnel option in Rust. Worth reading before committing to a design.
Repo: <https://github.com/BloopAI/vibe-kanban> (note: project is
sunsetting per their README, but the code is up).

---

## 2. Mobile remote-control app

**Shape.** A real iOS / Android app that:

- Lists active local Switchboard sessions.
- Renders the message stream live (via the same wire protocol the read-
  only viewer would use).
- Sends new turns.
- Approves `AskUserQuestion` and tool-approval prompts.
- Switches runtime mode.
- Shows context-window meter and cost.

**Why deferred.** Real scope. Auth model (Switchboard issuing a pairing
token), wire protocol stability (bumping the protocol breaks every
mobile version not on the latest), App Store review cycle, the full
Slack-style cloud-relay-vs-Tailscale decision — all the same
architectural calls.

**What unblocks this.**
1. Cloud-vs-Tailscale decision (shared with Slack feature).
2. Apple Developer account + TestFlight setup.
3. Pairing-token auth design.

**Reference.** Same `relay-*` crates from vibe-kanban. Their
`crates/tauri-app` is the closest analog to a desktop-paired mobile
controller, though Tauri is the wrong stack for our needs.

---

## 3. Voice input

**Shape.** Push-to-talk on a global shortcut (proposed: `⌘⇧V`,
hold-to-talk). Speech transcribed to text → inserted into the focused
chat input (or, if nothing is focused, into the active session's draft).

**Three tiers, ship all three.**
- **Default: whisper.cpp via WASM, fully local.** ~150 MB model
  download, runs faster than realtime on M-series CPUs. Cost: $0/month.
  Quality: solid for clear speech, mediocre on technical terms with
  background noise.
- **Optional: Groq Whisper API (BYOK).** $0.04/hour ≈ $1/month for 30
  min/day of dictation. Quality matches OpenAI, much faster. User pastes
  their Groq key in Settings.
- **Optional: OpenAI Whisper API (BYOK).** $0.006/minute ≈ $5/month for
  30 min/day. Best quality on jargon ("Prisma", "PubSub", file paths).

**Differentiator over Superwhisper.** Switchboard knows the active
project, so transcription can be biased toward project terminology
("PR" not "P R", "Prisma" not "prism uh"). Pass a small vocabulary hint
derived from `package.json` deps + recent CLAUDE.md content as a prompt
to the transcription endpoint when supported.

**What unblocks this.** Nothing technical. It's deferred only to keep
the immediate queue focused on harness ergonomics. ~3-5 days of work
including the BYOK plumbing and the project-terminology biasing.

---

## 4. Provider hot-swap mid-conversation — context preservation

**Shape.** Switchboard already lets the user swap agent type mid-chat
via `handleAgentTypeChange` in `ChatPanel.tsx`. Today's behaviour: tear
down the outgoing provider session, the next `handleSend` calls
`startSession` on the new provider. The visible message stream persists
in the zustand store, so the chat *looks* continuous — but the new
adapter starts with **zero conversation context**. Every prior turn
might as well not exist as far as the new agent is concerned.

The deferred work is closing that gap so swapping providers preserves
real context the new agent can reason over.

**Two implementation options.**

- **A. Replay-summary on swap (simpler).** When the user picks a
  different provider/instance, run a cheap-model turn on the *outgoing*
  provider that summarizes the conversation so far. The new provider's
  first turn receives the summary as system context, then continues.
  Loses true context continuity (the new adapter doesn't see raw
  history) but is cheap to implement and adapter-agnostic.
- **B. Maintain parallel sessions per adapter (richer).** Switchboard
  conversation = N provider sessions, one per adapter ever used. On
  swap, fast-forward the *target* adapter's session by replaying any
  messages it hasn't yet seen, then continue. True context continuity
  per adapter. Costs token replay every time you swap to an adapter
  that has never seen recent turns.

**Recommended path.** Ship A first (faster, lower risk, covers 80% of
the use case). Promote to B if users start swapping more than once
per conversation regularly.

**Why deferred.** The naïve swap mechanism is good enough for casual
use ("retry this turn under a different provider"). The richer
context-preserving version is multi-day work and depends on schema
changes (#5 below) to identify which credential/instance is in use.

**What unblocks this.** Decision on A vs B. Multi-instance schema (#5)
ships first. Adapter changes to accept an `instanceId` at
`startSession`.

---

## 5. Multi-instance provider picker (t3code-style)

**Shape.** Today, each agent type (Claude Code / Codex / OpenCode) is
configured by a single set of env vars / OAuth tokens / API keys.
Users with multiple Codex accounts (`codex-work`, `codex-personal`,
`codex-frontier`) currently have to swap shell environments to use
them.

t3code solves this with **multiple named instances per driver kind**:
each instance has its own display name, accent color, env vars, and
shows up in a sidebar of icon-rounds (CW / CF / CP) above the model
picker. See the screenshot the user shared 2026-05-04 for the
reference UI: left rail of instance icons + searchable model list
scoped to the selected instance + `⌘1`–`⌘N` keyboard shortcuts on the
visible models.

**What needs to change in Switchboard.**

- `provider_instances` table in settings DB: `(id, agent_type,
  display_name, accent_color, env_json, created_at)`. Multiple rows per
  `agent_type` allowed.
- Settings → Providers gets a list-of-instances UI (modeled after
  t3code's `ProviderInstanceCard.tsx`).
- Model picker dropdown becomes two-pane: left rail of instances for
  the active agent type, right pane of models for the selected
  instance.
- Adapter `startSession` accepts `instanceId`; the registry resolves it
  to env vars at spawn time.
- StatusBar shows the active instance name next to the model id.

**Auto-rotation between instances (follow-up, not v1).** Once we have
multiple instances stored, a natural extension is: on rate-limit error
from one instance, mark it cooling-off for N minutes and route the
next request to the next-available instance. Pool selection policy
options: round-robin, least-recently-used, cost-prioritized. UI: per-
instance pill with a colored dot (green / yellow / cooling-off-with-
countdown). This was originally tracked as "subscription autorotate"
but the screenshot the user shared is the static picker, not
auto-rotation. Picker first, rotation as a v2.

**What unblocks this.** Schema design (`provider_instances`
migrations) + a pass over each adapter to thread `instanceId` through
`startSession`.

**Reference.** t3code:
`apps/web/src/components/settings/ProviderInstanceCard.tsx`,
`packages/contracts/src/providerInstance.ts`. The cursor adapter from
vibe-kanban (`/tmp/vibe-kanban/crates/executors/src/executors/cursor.rs`,
`resolve_cursor_model_name`) is worth yoinking specifically for its
`(base_model, reasoning) → full_model_id` mapping table — covers ~30
cursor variants and is the kind of registry we'll want once instances
multiply.

---

## Reference index

- vibe-kanban: <https://github.com/BloopAI/vibe-kanban> (sunsetting,
  but the relay/workspace code is the most complete public reference
  for desktop-paired-with-cloud agent harnesses).
- t3code: <https://github.com/pingdotgg/t3code> (multi-instance
  provider config; see
  `apps/web/src/components/settings/ProviderInstanceCard.tsx` and
  `packages/contracts/src/providerInstance.ts`).
- Cursor adapter (worth yoinking model+reasoning matrix from):
  `/tmp/vibe-kanban/crates/executors/src/executors/cursor.rs`.
