# Switchboard

**An open-source command center for AI agents and the development environment around them.**

Switchboard brings coding agents, real terminals, files, git worktrees, and
remote machines into one desktop workspace. Instead of moving between an agent
CLI, terminal tabs, an editor, and a browser, keep the work for a project in
one place and pass live context where it is needed.

Today, Switchboard supports **Claude Code**, **Codex**, and **OpenCode**.
Cursor and additional providers are planned. The provider layer is designed to
grow, and contributions are welcome.

> Status: pre-1.0. macOS Apple Silicon and Windows x64 builds are published
> through GitHub Releases with auto-update. Builds are currently unsigned. See
> [Install](#install) before downloading.

## Why Switchboard?

Coding agents work best when they can see the system you are working in. In a
typical project, that context is fragmented: an agent chat in one place,
frontend and backend processes in terminal tabs, logs elsewhere, and a diff in
your editor.

Switchboard connects those surfaces. Select terminal output, a file range, or a
chat message and send it to the active agent with `Cmd+L`. Run parallel work in
isolated git worktrees. Review the diff an agent actually produced. Keep
conversations, terminals, files, and machines attached to the project rather
than scattered across applications.

## What you can do today

### Work with the agents you already use

- Run Claude Code, Codex, or OpenCode in rendered chat panes.
- Start two agent chats side by side to compare approaches or delegate parallel
  work.
- Choose permission modes per chat: plan, sandbox, accept edits, or full
  access. Plan mode is enforced by Switchboard, not just requested from the
  provider.
- Resume and search Claude Code and Codex history from the project sidebar.
- Use skills and slash commands exposed by the active provider.

### Give agents useful context

- Send selected terminal output, file ranges, or prior chat messages into a
  chat with `Cmd+L`.
- Paste or drop screenshots directly into a supported agent chat.
- Use `Cmd+K` for a focused prompt without leaving the current workspace.
- Open files referenced in a chat directly in the embedded VS Code workbench.

### Keep parallel work under control

- Run real shells in a tmux-style tree of resizable terminal panes.
- Create a kanban card that launches an agent in its own git worktree.
- Fork a conversation from any message, optionally into an isolated worktree.
- Review per-file and per-hunk diffs from a git checkpoint after each agent
  turn.
- Save named terminal templates in `.switchboard/workspace.yaml` and apply
  them to new chats.

### Work across machines

- Connect to a Linux machine through your existing SSH configuration.
- Run Claude Code, terminals, git, and file access on that machine while
  keeping the Switchboard interface on your laptop. Remote Codex and OpenCode
  support is not available yet.
- Reconnect to remote chats and browse recent remote projects while offline.

## Providers

| Provider | Status | Notes |
| --- | --- | --- |
| Claude Code | Supported | Agent SDK integration, sessions, permissions, skills, images, and remote machines |
| Codex | Supported | `codex app-server` integration, sessions, permissions, skills, and images |
| OpenCode | Supported | Agent Client Protocol integration, dynamic models, and skills |
| Cursor | Planned | Not implemented yet. No delivery date. |
| Other agents | Planned | New adapters are welcome through the provider interface. |

Switchboard is not trying to replace the agents themselves. It is the place to
run, compare, and supervise them alongside the terminals and project state
they need. If there is an agent or workflow you want supported, please open an
[issue](https://github.com/tejasnafde/switchboard/issues) or contribute an
adapter.

## Common workflows

### Debug a running service with an agent

Keep the frontend, backend, logs, and database tunnel in terminal panes. When
an error appears, select the relevant output and press `Cmd+L`. The agent gets
the error in context without a copy-paste detour or a screenshot of a terminal.

### Run several approaches without colliding

Create kanban cards for the work you want to explore. Each card can start an
agent in an isolated git worktree, so two agents can change the same repository
without sharing a working tree. Review the resulting diffs in chat and keep
the approach you want.

### Continue work from another machine

Connect to a Linux host over SSH and start a project there. Switchboard
provisions its helper, tunnels the connection, and keeps the familiar Claude
Code chat, terminal, file, and git surface on your laptop.

## How it compares

Switchboard overlaps with several excellent tools. The difference is the
combination of provider-neutral agent chats, live terminal context, git-aware
review, and a project workspace that can run locally or over SSH.

| If you need | Consider | Use Switchboard when |
| --- | --- | --- |
| A Codex-only multi-agent application | Codex app | You want to work with Claude Code, Codex, and OpenCode in the same workspace, with real terminal processes and remote machines. |
| An AI-native terminal or saved terminal layouts | Warp | You want rendered provider chats, terminal-to-agent context, git worktree cards, and provider-independent history. |
| A fast, native terminal for managing CLI agents | cmux | You want the agent conversation, diffs, files, terminals, and project history in one application. |
| An IDE with built-in agent features | Cursor | You want a workspace centered on agents and live processes. Cursor support is planned, but not available yet. |

## See it in action

**Switch agents per chat**

https://github.com/user-attachments/assets/aa42e86a-e986-46e2-9e58-5efd2547a048

**Bridge terminal output into a chat**

https://github.com/user-attachments/assets/2cc1312e-4f2a-4b29-b232-b5797f650dff

**Resume and search conversations**

https://github.com/user-attachments/assets/86c50159-f723-40d6-9315-0836ac48f302

## Install

Download the latest build from the [Releases page](https://github.com/tejasnafde/switchboard/releases/latest).

### macOS, Apple Silicon

Download `Switchboard-X.Y.Z-arm64-mac.zip`. The app is unsigned, so Gatekeeper
will refuse the first launch.

```bash
# Unzip, drag Switchboard.app to /Applications, then:
xattr -d com.apple.quarantine /Applications/Switchboard.app
```

You can also right-click the app, choose **Open**, then choose **Open** again.
macOS may quarantine a replacement after an auto-update, so repeat the command
or the right-click flow after an update if needed.

Intel Macs are not currently built. Open an issue if you need x64 support.

### Windows, x64

Download `Switchboard Setup X.Y.Z.exe`. SmartScreen may show "Windows protected
your PC" on first launch. Choose **More info**, then **Run anyway**. A portable
`.zip` build is also available.

## Develop

```bash
git clone https://github.com/tejasnafde/switchboard.git
cd switchboard
npm install
npm run dev
```

Useful commands:

```bash
npm test           # vitest
npm run typecheck  # TypeScript checks across main, preload, renderer, and shared
npm run build      # typecheck, tests, bundle, and smoke test
npm run dist:mac   # local Apple Silicon build
npm run dist:win   # local Windows x64 build
```

`npm run dist:*` builds for the host platform. Cross-platform release builds
run in the GitHub Actions matrix because the Claude Code SDK includes native
platform binaries. See [`docs/releasing.md`](docs/releasing.md) for the release
process.

## Under the hood

- **One provider interface, three protocols.** Claude Code uses the Agent SDK,
  Codex uses JSON-RPC through `codex app-server`, and OpenCode uses the Agent
  Client Protocol. They normalize into one event stream, so the renderer stays
  provider-agnostic.
- **Permissions enforced by the app.** Plan mode uses a tested policy that
  denies non-read-only tools across providers.
- **Git is the source of truth for edits.** Switchboard takes a checkpoint at
  the start of a turn and derives review cards from the resulting diff.
- **Project context is local and durable.** Real PTYs, an embedded VS Code
  workbench, SQLite with FTS5, encrypted provider credentials, project-scoped
  history, and `.switchboard/workspace.yaml` terminal templates are all part of
  the application.
- **Built and tested.** The build is gated by typechecking and a suite of more
  than 1,200 tests.

For the technical details:

- [`docs/concept.md`](docs/concept.md) explains the original product thesis.
- [`docs/plan.md`](docs/plan.md) records the current implementation status.
- [`docs/architecture/`](docs/architecture/) contains provider and UI details.
- [`docs/keybindings.md`](docs/keybindings.md) lists shortcuts.
- [`docs/releasing.md`](docs/releasing.md) documents releases.

## License

[MIT](LICENSE) © Tejas Nafde
