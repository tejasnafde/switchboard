# GCP Remote Codex Parity

**Date:** 2026-08-11  
**Status:** Approved

## Goal

Make Codex a first-class Switchboard provider locally and on remote machines,
while fixing the GCP/IAP connection failure and the provider/model mismatch
shown in the composer.

The acceptance bar is user-visible parity with Claude wherever Codex
app-server has an equivalent capability. OpenCode remains supported but is not
expanded unless a shared provider change benefits it automatically.

## Confirmed failures

### GCP/IAP transport

The working `prod` shortcut runs:

```sh
gcloud compute ssh --zone asia-south1-b geoiq-retailiq-v2-in-prod \
  --tunnel-through-iap --project prj-geoiq-product-in-prod
```

Switchboard instead launches plain `ssh` against a cached SSH-config alias.
That bypasses gcloud's current user, identity, host-key alias, and IAP command
resolution. The connection therefore fails with `Permission denied
(publickey)` before Switchboard can switch to the configured runtime user.

Transport identity and execution identity are separate:

```text
gcloud/IAP authentication
  -> SSH login identity selected by gcloud
  -> sudo -H -u ubuntu
  -> /home/ubuntu
  -> Switchboard backend, terminals, Claude, and Codex
```

### Provider/model mismatch

Switching providers updates the renderer store but does not persist the
conversation's `agent_type`. Model and provider-instance selections are
persisted independently. Reopening the conversation can therefore hydrate a
Claude conversation with a Codex model such as `gpt-5.6-sol`.

### Codex protocol drift

The adapter implements the broad event surface but misses or uses stale forms
of current app-server RPCs:

- no `model/list` or live `setModel` implementation;
- resume records a thread id without calling `thread/resume`;
- forks are degraded despite `thread/fork` support;
- approval responses use `approve`/`deny` instead of Codex
  `accept`/`decline`;
- request-user-input handling watches legacy method names;
- skill selection is sent as a generic slash command instead of a Codex skill
  input;
- remote Codex is blocked even though the remote backend already contains the
  adapter;
- rate-limit, plan, peer-tool, and stall behavior are less complete than the
  Claude path.

## Chosen architecture

Keep Switchboard's existing whole-backend remote boundary. The remote backend
owns provider processes, credentials, session state, terminals, files, git,
and the database. Remoteness remains a connection-layer concern; provider
adapters do not learn SSH.

This matches the useful core of T3 Code's remote model and Omnigent's runner
model without adding a plugin system or a second control plane.

### Machine transport

Replace the implicit "everything is plain SSH" assumption with a discriminated
transport:

```ts
type MachineTransport =
  | { kind: 'ssh' }
  | {
      kind: 'gcloud-iap'
      instance: string
      project: string
      zone: string
    }
```

The existing SSH fields remain for display, ordinary hosts, and backwards
compatibility. IAP metadata is discovered from `~/.ssh/config` ProxyCommand
blocks and stored with the machine. Existing machines are enriched by alias
when they connect, so this bug is repaired without requiring delete/re-add.

All probe, provisioning, upload, and tunnel commands go through one transport
builder. For IAP it invokes `gcloud compute ssh` directly with structured argv,
`--command`, and repeated `--ssh-flag` arguments. It never evaluates arbitrary
zsh aliases or interpolates a shell command.

### Runtime user

`remoteUser` stays per-machine and defaults to `ubuntu`. The backend launch,
provider homes, project access, and PTYs all resolve after the sudo boundary.
Visible PTYs explicitly use the runtime user's login shell and may clear once
after startup; background probes and services never emit terminal-clear codes.

### Provider selection persistence

Add one backend operation that atomically changes a conversation's provider
selection:

- update `agent_type`;
- clear the incompatible pinned model;
- set the new provider's default instance id;
- clear incompatible native resume state;
- retain the pending context-handoff marker when history exists.

The renderer applies the same change optimistically, while the backend remains
the durable source of truth. A `session.provider` event reconciles all clients.

### Provider capability contract

Adapters publish explicit capabilities instead of relying on optional methods
and comments:

- local and remote availability;
- streaming and reasoning;
- images;
- approvals and user questions;
- model discovery and switching;
- skills;
- steering and interrupt;
- warm resume and fork;
- peer tools;
- rate-limit reporting.

The picker and session actions consume this contract. Cross-provider contract
tests exercise capabilities declared as supported.

## Codex parity work

### Current app-server protocol

- Generate or model a narrow typed v2 protocol boundary instead of parsing all
  messages through `any`.
- Discover models with `model/list`, including supported reasoning efforts and
  the resolved default.
- Store model changes on the active adapter so the next `turn/start` uses them.
- Call `thread/resume` during startup and surface a degraded-resume event when
  the stored thread cannot be recovered.
- Use `thread/fork` with the last retained turn when available. Retain
  normalized Switchboard messages as the fallback source of truth.
- Map command/file approvals to Codex decisions and handle
  `item/tool/requestUserInput` with its current response shape.
- Send Codex skills as `$name` plus a skill input item when the path is known.
- Normalize plan, review, collaboration, compaction, usage, reroute, and
  warning events without exposing provider-specific JSON to the renderer.

### Remote installation and authentication

The remote package installs a pinned `@openai/codex` release, whose optional
dependencies contain the correct Linux x64 or arm64 binary. Provisioning
verifies the installed version and symlinks `codex` into
`/home/ubuntu/.local/bin`.

Remote provider profiles map to durable config homes under the runtime user's
home:

```text
/home/ubuntu/.claude-<profile>
/home/ubuntu/.codex-<profile>
```

Auth is performed on the VM. Codex uses `codex login --device-auth` under the
selected `CODEX_HOME`. Switchboard does not silently copy local OAuth files.
Auth checks and the composer banner become provider-neutral.

The remote backend advertises provider readiness including binary version,
auth status, and protocol support before the picker enables a provider.

### Session affinity and recovery

A live session remains pinned to machine, runtime user, workspace, provider
instance, and native thread id. Recovery order is:

1. reattach to the live remote adapter;
2. resume the durable native thread under the same provider home;
3. reconstruct context from Switchboard's normalized transcript;
4. clearly label a cold/degraded restart.

Silent host failover or silent loss of context is not allowed.

## Error handling

- Missing gcloud, invalid IAP metadata, auth failure, sudo failure, missing
  runtime, missing provider binary, and provider login failure get distinct
  messages.
- Connection errors retain the attempted transport kind and stage.
- A failed remote Codex install does not break Claude connectivity.
- An unsupported Codex protocol method degrades only the declared capability,
  not the entire session.
- Secrets from the SSH/IAP launcher and Switchboard transport are removed from
  provider child environments.

## Test strategy

All behavior changes follow red-green-refactor.

### Unit and contract tests

- IAP discovery, migration, argv construction, probe, upload, and tunnel.
- Runtime-user command wrapping and visible-terminal initialization.
- Atomic provider-selection persistence and reopen hydration.
- Codex model listing/switching, resume, approval, questions, skills, usage,
  fork, and protocol compatibility.
- Remote package contents, version checks, symlink, auth-home mapping, and
  provider-neutral auth banner.
- Provider capability conformance for Claude and Codex.

### Integration tests

- Fake gcloud/ssh runners verify the whole ConnectionManager lifecycle.
- WsHost tests start Claude and Codex against the same provider contract.
- Remote backend fixture proves Codex is available when installed and returns
  an actionable login prompt when unauthenticated.

### Manual acceptance

1. Connect the existing production machine without changing `.zshrc` or
   `~/.ssh/config`.
2. Confirm the backend and a new terminal run as Ubuntu in `/home/ubuntu`.
3. Log in to a remote Codex profile using the banner's command.
4. Start a remote Codex chat, stream reasoning and tool calls, answer a
   question, approve/deny a command, attach an image, interrupt, and steer.
5. Change models and reopen the conversation; provider and model remain valid.
6. Restart Switchboard and resume the same Codex thread.
7. Fork the conversation and continue from the retained point.

## Implementation order

1. Machine transport model and GCP/IAP connection fix.
2. Atomic provider selection and mismatch repair.
3. Typed Codex protocol corrections and core parity.
4. Remote Codex install, auth, capability reporting, and gate removal.
5. Native resume/fork, peer tools, plans, rate limits, and watchdog parity.
6. Targeted suites, full typecheck/tests/build, then manual-test handoff.
