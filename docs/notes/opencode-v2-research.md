# OpenCode v2: what it is, and what Switchboard should do

Researched 2026-09-29. Read-only: `gh` API and the public docs. Nothing was installed or run against an account folder. The v2 install script was downloaded as text and read, not executed (`/tmp/sb-ocv2-job/v2-install.sh.txt`). Source excerpts are from tag `v2.0.19` unless noted.

## TL;DR

- **v2 is a new major release of the same `opencode` CLI.** It has a new core, a client/server split with a shared background service, a new TUI, and a new Desktop app. It is a separate release line (v2.0.0 on 2026-09-11, v2.0.19 on 2026-09-29, about one release a day), published under a new npm package, `@opencode/cli`. The v1 line (`opencode-ai`, 1.18.33) is still the GitHub "Latest" release, so the two ship side by side. The docs site has a "New OpenCode v2 is now available" banner, but nothing is labelled GA or beta.
- **It replaces v1 on disk.** The v2 binary is also called `opencode`. The curl installer writes `~/.opencode/bin/opencode`, the same path v1's curl installer uses. The brew formula `anomalyco/tap/opencode-v2` declares `conflicts_with "opencode"`. v2 also migrates v1's `opencode.db` forward in place and imports `auth.json` into it.
- **`opencode acp` still exists in v2, but Switchboard as written fails on it.** v2's `acp` subcommand takes no options. Switchboard spawns `opencode acp --cwd <dir>` (the adapter and the native-fork runner), and v2's Effect CLI parser rejects unknown flags (`UnrecognizedOption`). That was read from source, not run. Past that, `session/set_model` is gone (the model is now a `session/set_config_option`), and `session/new` returns no `models` field.
- **Recommendation: support v1 only for now.** Detect a v2 binary and refuse with a clear message. Plan a v2 code path as a follow-up once v2's ACP stabilises; it has an open regression right now, #50236. Don't drop v1: it is still the default install everywhere.

## 1. What v2 is

| Fact | Source |
|---|---|
| Tags `v2.0.0` (commit 2026-09-11) through `v2.0.19` (2026-09-29), cut from branch `v2`. There are no GitHub Releases for v2: the Releases page shows only v1.x, with `v1.18.33` as "Latest". | `gh api repos/anomalyco/opencode/tags`, [releases](https://github.com/anomalyco/opencode/releases) |
| New npm package `@opencode/cli` (dist-tags `latest: 2.0.19`, `beta`, `dev`; 2.0.0 published 2026-09-11). `opencode-ai` stays on 1.18.33. | [npm @opencode/cli](https://www.npmjs.com/package/@opencode/cli), [npm opencode-ai](https://www.npmjs.com/package/opencode-ai) |
| The v2 update API reports `{"channel":"latest","version":"2.0.19","package":"@opencode/cli","ref":"refs/heads/v2"}`. | `https://opencode.ai/update/api/latest/cli/npm` |
| Install: `curl -fsSL https://opencode.ai/v2/install \| bash`, `brew install anomalyco/tap/opencode-v2`, `npm i -g @opencode/cli`, or AUR `opencode-beta`. There is also a v2 Desktop app, not on Homebrew yet. | [opencode.ai/v2/docs](https://opencode.ai/v2/docs), [#50144](https://github.com/anomalyco/opencode/issues/50144) |
| Architecture: the CLI is a client of a server. By default commands attach to a shared **background service** (`opencode service start/stop/status`, registration file under `$XDG_STATE_HOME/opencode/`). `--standalone` runs a private server instead. `opencode --port` was removed. | `packages/cli/src/commands/commands.ts` (`ServerParams`, `service`), [#50937](https://github.com/anomalyco/opencode/issues/50937), [#44914](https://github.com/anomalyco/opencode/issues/44914) |
| Status: v1 still gets releases (1.18.33 on 2026-09-28). The v2 docs never say "beta" except for the AUR package name. The issue tracker shows v2 is rough: TUI bugs, a broken VS Code extension ([#49006](https://github.com/anomalyco/opencode/issues/49006), [#41017](https://github.com/anomalyco/opencode/issues/41017)), provider regressions ([#50087](https://github.com/anomalyco/opencode/issues/50087), [#50077](https://github.com/anomalyco/opencode/issues/50077)). | issue search "opencode v2" |

The v1 updater (`packages/opencode/src/installation/index.ts@v1.18.33`) checks `opencode-ai` on npm, the brew `opencode` formula, and GitHub `releases/latest`, and all three are still v1. **A v1 user does not auto-upgrade to v2.** Someone ends up on v2 by installing it deliberately. The branch `2.0` ("2.0 exploration", 2026-04-13) is an old spike, not the release line.

## 2. Does v2 still have `opencode acp`?

Yes. `Spec.make("acp", { description: "Start an Agent Client Protocol server" })` takes **no params** (`packages/cli/src/commands/commands.ts`). The handler (`packages/cli/src/commands/handlers/acp.ts`) starts a **private** server with `Standalone.start()`, which spawns `opencode serve --stdio --port 0` with `extendEnv: true`, so our spawn env reaches it. It then speaks ACP over stdio through `@agentclientprotocol/sdk`. It does not use the shared background service.

Methods registered in v2 (`packages/cli/src/acp/agent.ts`), compared with what Switchboard calls:

| Method | v1 1.18.33 | v2.0.19 | Switchboard impact |
|---|---|---|---|
| CLI flag `acp --cwd <dir>` | yes (yargs option) | **no** | **Fatal.** Spawned in `opencode-acp-adapter.ts:809` and `conversations/native-fork-runners.ts:103`. The Effect CLI parser raises `UnrecognizedOption` ([parser.ts](https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/unstable/cli/internal/parser.ts)), so no ACP starts. From source, not run. |
| `initialize` | yes | yes (protocolVersion 1, `sessionCapabilities: { close, delete, fork, list, resume }`, `loadSession: true`) | ok |
| `session/new` | returns `models` + `modes` | returns **only `configOptions`** (model, effort, mode) | `newSession.models?.availableModels` becomes empty. Only the in-session model list is lost: the picker comes from `opencode models`. |
| `session/set_model` (unstable) | yes | **removed**; use `session/set_config_option` with `configId: "model"` (and `"effort"` for the variant) | `unstable_setSessionModel` (`adapter:1280`) fails with Method not found. It is logged at start (`acp setModel failed`) and **the chat silently runs on the default model**. A mid-chat switch errors. |
| `session/set_mode` | yes | yes | ok (`plan`/`build` still exist; custom agents regressed, [#51478](https://github.com/anomalyco/opencode/issues/51478)) |
| `session/prompt`, `session/cancel` | yes | yes | ok. v2 refuses a second concurrent prompt on one session, which matches our queue. |
| `session/resume`, `session/load`, `session/list`, `session/close`, `session/fork` | yes | yes | Same names. v2 `fork` still copies the whole session with no message id, so our "latest reply only" rule still holds. Resume response is `configOptions`, not `models`. |
| `session/delete` | - | new | unused |
| `session/request_permission` (agent to client) | yes | yes (`allow_once` / `allow_always` / `reject_once`) | our `pickPermissionOptionIds` should still work, unverified |

Also relevant:
- **`OPENCODE_CONFIG_CONTENT` is still honoured** and ranks highest (`packages/core/src/config.ts`, `load`: `...projectSupplementary, ...content`). The v1 `permission` object (`{"switchboard_*":"allow","<server>_*":"ask"}`, from #173) is **migrated** into v2's native `permissions` rules (`packages/core/src/config/normalize.ts` `migratePermissions`), so the injection probably still applies. I did not verify that v2 MCP tool actions are still named `<server>_<tool>`. Needs a live check before shipping a v2 path.
- **Config discovery changed.** v2 reads only `opencode.json` / `opencode.jsonc` (not `config.json` / `config`) and adds `~/.claude` and `~/.agents` as global roots (`packages/core/src/config/discovery.ts`). `collectConfiguredOpencodeUserConfig` would miss rules from those dirs, so its `canTrustUserConfig` / MCP-name view could be incomplete.
- `OPENCODE_ENABLE_QUESTION_TOOL` does not appear in the v2 files read. Not confirmed either way.
- There is an open v2 ACP regression: since 2.0.4, `session/new` ignores the user's config providers, custom agents and default model ([#50236](https://github.com/anomalyco/opencode/issues/50236)). The umbrella issue [#35457](https://github.com/anomalyco/opencode/issues/35457) ("Port ACP support to V2 core") is still open, marked Low, though the v2.0.19 code already runs ACP on the v2 client.

## 3. Config, auth, sessions, binary

- **Directories are unchanged.** XDG roots are the same as v1: `$XDG_CONFIG_HOME/opencode`, `$XDG_DATA_HOME/opencode`, `$XDG_STATE_HOME/opencode`, `$XDG_CACHE_HOME/opencode`. `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` are still honoured (`packages/util/src/global-roots.ts`, `global.ts`, and the isolated test env in `packages/cli/test/fixture/environment.ts`).
- **Sessions and auth live in the same DB file, migrated forward.** The DB is `$XDG_DATA_HOME/opencode/opencode.db`, overridable with `OPENCODE_DB` (`packages/cli/src/database-path.ts`), the same file v1 uses. v2 has all 35 of v1's migrations plus 9 more (workspace, worktree, session inbox, `import_legacy_credentials`). That last one copies `auth.json` into the DB (`packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts`). **Once someone runs v2, their v1 DB carries v2 schema, and credentials added through v2 are not in `auth.json`.** Downgrading to v1 is not guaranteed safe. I did not test how v1 opens a DB with unknown migrations.
- **Binary name and path.** It is `opencode`: the curl install goes to `~/.opencode/bin/opencode` (plus an `opencode2` shim), brew installs `opencode` and conflicts with the v1 formula, and npm `@opencode/cli` installs `opencode`. **It replaces v1 on PATH.** v1 and v2 coexist only if one came from brew or npm and the other from curl.
- **Correction to the question's premise:** Switchboard does *not* set XDG or OpenCode config dirs per OpenCode instance. `CredentialHomeAgent` is `'claude-code' | 'codex'` only (`src/main/provider/credential-home.ts:42`). OpenCode instances are env-overlay (API keys) only, which v2 still receives through the private `acp` server.
- **Side effect to know about:** `opencode models`, which Switchboard runs in `catalog-probe.ts:84` and in the instance Test (`ipc/provider-instances.ts`), attaches in v2 to the **shared background service** unless given `--standalone` (`packages/cli/src/services/server-connection.ts`). That service is spawned once with whatever env its first caller had. On v2, an instance's API-key overlay may not affect the model list or Test result, and Switchboard would start a long-lived background daemon. From source, not run.
- **Switchboard's binary lookup** (`adapters/opencode/env.ts:41`) checks `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/node_modules/.bin`, then `which`. It never checks `~/.opencode/bin`, where both curl installers put the binary, so a curl-only user depends on the app's PATH.

## 4. Recommendation

**Support v1 only for now, detect v2, and refuse clearly.** Reasons: v1 is still what npm `opencode-ai`, brew `opencode` and GitHub Latest install, and v1 never auto-upgrades to v2. v2 ships daily and has an open ACP regression on exactly the catalog we depend on (#50236). A v2 path needs a live verification pass (permissions, question tool, MCP tool names) that unit tests cannot provide.

**What breaks today for a user on v2:** every OpenCode chat fails at start with a CLI usage error, which surfaces as `OpenCode ACP init failed` or the child exiting with a non-zero code. Native forks fail the same way. The model list / Test may also talk to the shared v2 background service. If `--cwd` were accepted, the next failure is quieter: every chat runs on v2's default model because `set_model` is gone.

**Smallest safe change (one small PR):**
1. In `findOpencodePath` / `startSession`, run `opencode --version` once (cached with the path). For a major version of 2 or higher, throw a typed error with copy like: "OpenCode 2.x isn't supported yet. Install OpenCode 1.x (`npm i -g opencode-ai`) or switch back". Surface it the way `TccAccessError` is. Apply the same check in `native-fork-runners.ts` and in the instance Test.
2. Add `~/.opencode/bin/opencode` to the candidate list. Cheap, and it fixes curl-installed v1 on a GUI PATH.
3. A feature-parity manifest entry (desktop/server only; mobile and Android not applicable, since the adapter runs on the backend).

**v2 path later (follow-up, behind a flag such as `opencode_v2_acp`):** drop `--cwd` (spawn `cwd` already covers it: v2 uses `process.cwd()`); switch model changes to `setSessionConfigOption({ configId: 'model' | 'effort' })` whenever `configOptions` is present in the new/resume response, and read models from it; pass `--standalone` to `opencode models`; re-verify permission injection, the question tool and `switchboard_*` tool names live. The branch can be picked from what the agent returns (`configOptions` instead of `models`), so one adapter can serve both versions. Then support both until v1 stops shipping.

## Sources

- Repo: https://github.com/anomalyco/opencode (branch `v2`, tags `v2.0.0` to `v2.0.19`; v1 at `v1.18.33`)
  - v2 ACP: `packages/cli/src/acp/{agent,service,permission,config-option}.ts`, `packages/cli/src/commands/{commands.ts,handlers/acp.ts,handlers/models.ts}`, `packages/cli/src/services/{standalone,server-connection,service-config}.ts`
  - v2 paths/config/db: `packages/util/src/{global,global-roots}.ts`, `packages/cli/src/database-path.ts`, `packages/core/src/config.ts`, `packages/core/src/config/{discovery,normalize}.ts`, `packages/core/src/database/migration/`
  - v1 comparison: `packages/opencode/src/cli/cmd/acp.ts` (`--cwd`), `packages/opencode/src/acp/agent.ts` (`unstable_setSessionModel`), `packages/opencode/src/installation/index.ts` (updater sources)
- Brew formula: https://github.com/anomalyco/homebrew-tap/blob/main/opencode-v2.rb
- Install script: https://opencode.ai/v2/install · Docs: https://opencode.ai/v2/docs · v1 docs banner: https://opencode.ai/docs
- Issues: [#50937](https://github.com/anomalyco/opencode/issues/50937), [#50236](https://github.com/anomalyco/opencode/issues/50236), [#51478](https://github.com/anomalyco/opencode/issues/51478), [#35457](https://github.com/anomalyco/opencode/issues/35457), [#50144](https://github.com/anomalyco/opencode/issues/50144), [#36279](https://github.com/anomalyco/opencode/issues/36279), [#44914](https://github.com/anomalyco/opencode/issues/44914), [#50584](https://github.com/anomalyco/opencode/issues/50584)
- Effect CLI unknown flag: https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/unstable/cli/internal/parser.ts
- Switchboard: `src/main/provider/adapters/opencode-acp-adapter.ts` (spawn :809, set_model :1280, models :893-905), `src/main/provider/adapters/opencode/env.ts:41`, `src/main/conversations/native-fork-runners.ts:103`, `src/main/provider/catalog-probe.ts:84`, `src/main/provider/credential-home.ts:42`
