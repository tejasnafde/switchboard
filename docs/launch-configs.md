# Writing Switchboard launch configs

**Audience: an AI agent working inside some repo, asked to set up Switchboard launch configs for that repo.**

A launch config tells Switchboard which terminals to open (and what to run in
them) when a chat is opened for a project. Think of it as the terminal half of a
dev environment, checked into the repo so it travels with the code.

Your job, when pointed at this doc: inspect the repo, figure out the terminals a
developer actually wants on day one, and write a correct
`.switchboard/launch-config.yaml`. This doc is the complete spec - you should not
need to read Switchboard's source.

---

## 1. Where the file goes

```
<repo-root>/.switchboard/launch-config.yaml
```

- One file per repo. Create the `.switchboard/` directory if it doesn't exist.
- Commit it (it's meant to sync across machines via git).
- Switchboard hot-reloads the file: editing it re-spawns the active chat's
  terminals, so you can iterate without restarting the app.
- Paths inside the file are relative to the repo root (see cwd rules below), so
  the config stays portable across machines.

> Legacy note: older repos may have `.switchboard/workspace.yaml`. That's the old
> name for this exact file. Switchboard still reads it, but write the new
> `launch-config.yaml` name. If you find a `workspace.yaml`, rename it and
> convert its top-level `templates:` key to `configs:` (see below).

---

## 2. Quick start

The simplest possible config - one terminal at the repo root:

```yaml
terminals:
  - label: shell
```

A realistic single-layout config:

```yaml
terminals:
  - label: dev
    cwd: "."
    on_start: "npm run dev"
  - label: tests
    cwd: "."
    on_start: "npm test -- --watch"
  - label: shell
```

That opens three side-by-side terminals; the first runs the dev server, the
second the test watcher, the third is a plain shell.

---

## 3. The layout model

Switchboard arranges terminals as **rows** (stacked top to bottom) of **panes**
(placed left to right within a row).

You have two ways to express a layout:

### 3a. `terminals:` - a single row, flat

Every entry becomes a pane placed left-to-right in one row.

```yaml
terminals:
  - label: dev
    on_start: "npm run dev"
  - label: shell
```

```
┌─────────────┬─────────────┐
│ dev         │ shell       │
└─────────────┴─────────────┘
```

### 3b. `rows:` - explicit multi-row grid

Use this when you want more than one row. Each row has its own `panes:` list.

```yaml
rows:
  - panes:
      - label: dev
        on_start: "npm run dev"
      - label: api
        cwd: services/api
        on_start: "npm run start:api"
  - panes:
      - label: tests
        on_start: "npm test -- --watch"
      - label: shell
```

```
┌─────────────┬─────────────┐
│ dev         │ api         │   ← row 1
├─────────────┼─────────────┤
│ tests       │ shell       │   ← row 2
└─────────────┴─────────────┘
```

`rows:` and `terminals:` are mutually exclusive within one config. If both are
present, `rows:` wins. Prefer `terminals:` for a single row; reach for `rows:`
only when you genuinely want a grid.

Keep it modest: 2-4 panes is the sweet spot. Don't open a pane per package in a
20-package monorepo.

---

## 4. Pane fields

Each pane (whether under `terminals:` or a row's `panes:`) accepts:

| Field      | Required | Meaning |
|------------|----------|---------|
| `label`    | no (recommended) | Tab title shown in the terminal strip. Defaults to `Terminal N`. Keep it short. |
| `cwd`      | no       | Working directory. See resolution rules below. Defaults to the repo root. |
| `on_start` | no       | A shell command run once, after the shell initializes. |
| `wait_for` | no       | A substring to wait for in the terminal output before running `on_start`. |

No other fields are read. Don't invent keys (e.g. `env`, `color`, `shell`) -
they're silently ignored.

### cwd resolution

- omitted or `"."` → repo root
- relative (e.g. `services/api`) → `<repo-root>/services/api`
- absolute (starts with `/`) → used as-is (avoid this; it breaks portability)

### on_start

Runs the command as if the user typed it and pressed enter, once, after the
shell is ready. Use it for long-running processes (`npm run dev`), watchers
(`npm test -- --watch`), or a one-shot setup line. It is not a script - it's a
single command line. Chain with `&&` if you need multiple steps.

### wait_for

Gates `on_start` until the given substring appears in the terminal's output.
Use it to sequence startup: e.g. a worker terminal that should only start once
the API prints "listening on".

```yaml
rows:
  - panes:
      - label: api
        on_start: "npm run start:api"          # prints "listening on 3000"
      - label: worker
        wait_for: "listening on"                # waits for the api line...
        on_start: "npm run worker"              # ...then starts
```

`wait_for` watches that pane's own output. It fires once, then clears. If the
substring never appears, `on_start` never runs, so choose a string you're
confident will be printed.

---

## 5. Named configs (multiple layouts)

A repo can define several named layouts. New chats start from `default`; the
user can switch to another from the terminal strip's launch-config picker, and
their choice is pinned per chat.

```yaml
configs:
  default:
    terminals:
      - label: dev
        on_start: "npm run dev"
      - label: shell
  backend:
    rows:
      - panes:
          - label: api
            cwd: services/api
            on_start: "npm run start:api"
          - label: db
            cwd: services/api
            on_start: "docker compose up postgres"
  minimal:
    terminals:
      - label: shell
```

Rules:

- `default` is special: it's what new chats use and it can't be deleted or
  renamed. Always define a `default` if you use the `configs:` map.
- The top-level `terminals:` / `rows:` shorthand (sections 3a/3b) is just sugar
  for `configs: { default: { ... } }`. Use the shorthand when you only need one
  layout; use the `configs:` map when you need several.
- Name configs for the workflow they serve (`default`, `backend`, `frontend`,
  `e2e`, `minimal`), not for the tools inside them.

---

## 6. How to build a good config for a repo (agent checklist)

1. **Find the run commands.** Read `package.json` scripts, `Makefile`,
   `Justfile`, `docker-compose.yml`, `README`, `Procfile`, `mise/asdf` config,
   etc. Identify the real "start developing" command(s) and the test command.
2. **Detect the shape.** Single app → one row via `terminals:`. Monorepo /
   services → consider a `rows:` grid or multiple named `configs:`, with each
   pane's `cwd` pointed at the right package/service directory.
3. **Pick 2-4 panes** that a developer wants open immediately. Typical set: dev
   server, test watcher, and a free shell. Add a logs/db pane only if the repo
   clearly needs it.
4. **Wire dependencies with `wait_for`** only if startup ordering actually
   matters. Otherwise skip it.
5. **Use repo-relative `cwd`.** Never hardcode absolute or machine-specific
   paths.
6. **Keep `on_start` to real commands** that exist in this repo. Don't guess a
   `npm run dev` if the script is actually `npm start` or `pnpm dev`.
7. **Write the file** to `<repo-root>/.switchboard/launch-config.yaml`.
8. **Sanity-check the YAML**: valid indentation, `label`s present, exactly one of
   `terminals:`/`rows:` per config, and a `default` if using `configs:`.

---

## 7. Copy-paste starting template

```yaml
# .switchboard/launch-config.yaml
# Terminals Switchboard opens when a chat for this repo starts.
# cwd is relative to the repo root; on_start runs one command after the shell is ready.

terminals:
  - label: dev
    cwd: "."
    on_start: "<the repo's dev command>"
  - label: tests
    cwd: "."
    on_start: "<the repo's test-watch command>"
  - label: shell
```

Replace the `<...>` placeholders with the commands you found in step 1, delete
panes you don't need, and you're done.

---

## 8. Common mistakes to avoid

- Absolute or `~`-based `cwd` values (breaks on other machines). Use
  repo-relative paths.
- Both `terminals:` and `rows:` in the same config (only `rows:` will apply).
- Extra fields that aren't `label` / `cwd` / `on_start` / `wait_for`.
- Overloading `on_start` with a multi-line script - use a single command, chain
  with `&&` if needed, or point it at a script file in the repo.
- Ten panes. Keep it to the handful a developer actually wants open.
- Using `configs:` without a `default` entry.
