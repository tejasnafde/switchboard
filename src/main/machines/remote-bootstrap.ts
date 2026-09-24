/**
 * The shell the tunnel runs on the remote before `node index.cjs`: reap a
 * lingering server, restart the managed code-server, publish the managed CLI
 * PATH, then exec the backend.
 *
 * Built as fragments rather than one literal so the two rules that failed in
 * the field are stated once and unit-testable as strings (the remote itself is
 * not reachable from CI):
 *
 *  1. Reaping must ESCALATE and be BOUNDED. The old single `kill` + `sleep 1`
 *     lost to a server wedged at 99% CPU, so the replacement server EADDRINUSE'd
 *     behind ssh's -L forward while the tunnel reported success.
 *  2. Reaping must stay IDENTITY-GUARDED. `pkill -f node` would have solved (1)
 *     and is exactly wrong: on a shared VM it takes out unrelated listeners and
 *     a healthy code-server. Every signal here is aimed at a pid we recorded
 *     ourselves, and re-verified against `/proc/<pid>/cmdline` immediately
 *     before escalating - between TERM and KILL the pid can be freed and reused,
 *     and `kill -0` cannot tell that apart. The guard matches the FULL managed
 *     executable path for the backend (`$D/index.cjs`), never a basename: a
 *     shared VM can easily run some OTHER `index.cjs` under a different
 *     directory, and a basename-only grep cannot tell the two apart.
 *     `grep -F` (literal, not regex) plus `--` (end of options) keeps that match
 *     safe even though the expanded path contains `.` and is not attacker-
 *     controlled but should never be interpreted as one anyway.
 *  3. The code-server guard cannot match the launcher path the way the backend
 *     matches `$D/index.cjs`. `bin/code-server` is a shell wrapper that ends in
 *     `exec "$ROOT/lib/node" "$ROOT" "$@"` - `exec` replaces the process image
 *     without a new pid, so once it runs, `/proc/<pid>/cmdline` no longer
 *     contains `bin/code-server` at all; it contains `$D/code-server/lib/node`
 *     and `$D/code-server` (the bundled node binary and its entry argument).
 *     A pid recorded right after `nohup` already lost that race by the time
 *     reaping runs on the NEXT connection, so matching the launcher path left
 *     the identity guard permanently false and the stale IDE process unreaped
 *     - the fresh code-server then EADDRINUSE'd on the loopback IDE port. The
 *     fix is to match the installation-owned directory prefix `$D/code-server/`
 *     instead: it is still a fixed string rooted at OUR server dir (never a
 *     bare `code-server` basename another VM tenant could satisfy), and it
 *     survives the exec because `lib/node`'s own path is prefixed by it.
 */

/** Shell-side spelling of the managed CLI bin dir (expanded on the remote). */
export const MANAGED_BIN_SHELL_DIR = '$HOME/.local/bin'

/** Fixed-string /proc/<pid>/cmdline match for the backend process (rule 2 above). */
export const BACKEND_CMDLINE_MATCH = '$D/index.cjs'

/**
 * Fixed-string /proc/<pid>/cmdline match for the managed code-server process
 * (rule 3 above) - an installation-owned directory prefix, not the launcher
 * path, because it must still be present after `bin/code-server` execs into
 * `lib/node`. Exported so tests can exercise the exact string production uses
 * rather than a paraphrase of it.
 */
export const IDE_CMDLINE_MATCH = '$D/code-server/'

export interface StaleProcessKillOpts {
  /** Shell variable already holding the recorded pid. */
  pidVar: string
  /**
   * Literal fixed string that must appear in /proc/<pid>/cmdline for us to
   * signal it - either the FULL executable path (e.g. `$D/index.cjs`) or, for
   * a launcher that re-`exec`s into a different binary before the NEXT
   * connection's reap runs (code-server's `bin/code-server` -> `lib/node`),
   * an installation-owned directory prefix that is still present after that
   * exec (e.g. `$D/code-server/`). Never a bare basename either way. May
   * itself contain a shell variable reference (`$D`) meant to expand on the
   * REMOTE at run time; it is embedded inside a double-quoted grep argument,
   * so that expansion happens and `grep -F` still treats the (expanded)
   * result as a literal string rather than a regex.
   */
  cmdlineMatch: string
  /** Upper bound, in seconds, on the graceful TERM wait before KILL. */
  graceSeconds: number
}

/**
 * TERM -> bounded wait -> KILL, every step gated on the pid still being the
 * process we started. Emits no output and always succeeds, so it can sit in the
 * middle of a `;`-joined bootstrap without aborting it.
 */
export function buildStaleProcessKill(opts: StaleProcessKillOpts): string {
  const { pidVar: v, cmdlineMatch: match, graceSeconds } = opts
  // Re-evaluated on each loop turn and once more before KILL: this IS the
  // recycled-pid guard, not just an initial check. `-F` (fixed string, not
  // regex) so a `.` in the path cannot match any-char, and `--` ends option
  // parsing so a pattern that happened to expand starting with `-` is never
  // read as a grep flag.
  const isOurs = `grep -qsaF -- "${match}" "/proc/$${v}/cmdline"`
  const counter = `N_${v}`
  return (
    `if [ -n "$${v}" ] && ${isOurs}; then ` +
    `kill -TERM "$${v}" 2>/dev/null; ` +
    `${counter}=0; ` +
    `while [ $${counter} -lt ${graceSeconds} ] && ${isOurs}; do sleep 1; ${counter}=$((${counter}+1)); done; ` +
    `if ${isOurs}; then kill -KILL "$${v}" 2>/dev/null; sleep 1; fi; ` +
    `fi;`
  )
}

/**
 * Put Switchboard's managed CLI bin dir on PATH for everything the bootstrap
 * launches, and name it explicitly so the backend does not have to re-guess.
 *
 * The tunnel's remote command runs in a NON-INTERACTIVE ssh shell: no profile,
 * so no ~/.local/bin - which is precisely where provisioning links the `claude`
 * and `codex` it installed. Without this the server could not see the tools it
 * had just been given.
 */
export function buildManagedPathExport(): string {
  return (
    `PATH="${MANAGED_BIN_SHELL_DIR}:$PATH"; export PATH; ` +
    `SWITCHBOARD_MANAGED_BIN="${MANAGED_BIN_SHELL_DIR}"; export SWITCHBOARD_MANAGED_BIN;`
  )
}

export interface RemoteBootstrapOpts {
  /** Shell form of the server dir (e.g. `$HOME/.switchboard-server`). */
  serverDir: string
  /** Port the backend's WebSocket listener binds. */
  port: number
  /** Loopback port the managed code-server binds. */
  idePort: number
  /** Loopback port the sb-bridge WebSocket binds. */
  bridgePort: number
  /** Seconds to wait for a graceful exit before escalating to KILL. */
  graceSeconds?: number
}

/**
 * SB_BRIDGE_PORT/SB_BRIDGE_TOKEN are exported BEFORE both launches so the
 * code-server tree (its extension hosts inherit the env, which is how
 * resources/sb-bridge/extension.js finds the socket) and the backend that hosts
 * the bridge agree on one token. Minting it here, in the single shell that
 * starts both, is what keeps them in sync - a token generated independently on
 * either side could never match.
 */
export function buildRemoteBootstrapCommand(opts: RemoteBootstrapOpts): string {
  const grace = opts.graceSeconds ?? 10
  return (
    `D=${opts.serverDir}; ` +
    `P="$(cat "$D/server.pid" 2>/dev/null)"; ` +
    // `$D` here is a shell variable reference, not yet expanded - it is
    // resolved on the REMOTE, from the `D=` assignment above, when the
    // generated grep actually runs (see buildStaleProcessKill).
    buildStaleProcessKill({ pidVar: 'P', cmdlineMatch: BACKEND_CMDLINE_MATCH, graceSeconds: grace }) +
    ` IP="$(cat "$D/ide.pid" 2>/dev/null)"; ` +
    // NOT the launched path (`nohup "$D/code-server/bin/code-server" ...`):
    // that script `exec`s into "$D/code-server/lib/node" "$D/code-server", so
    // by the time this guard runs on the NEXT connection, `cmdline` no longer
    // contains `bin/code-server` at all. IDE_CMDLINE_MATCH is the
    // installation-owned prefix that is still there post-exec (it prefixes
    // `lib/node`'s own path) while staying rooted at OUR server dir - kept
    // separate from and as precise as the backend's own match so a shared
    // VM's other processes, including someone else's code-server, can never
    // satisfy either guard.
    buildStaleProcessKill({ pidVar: 'IP', cmdlineMatch: IDE_CMDLINE_MATCH, graceSeconds: grace }) +
    ` ${buildManagedPathExport()} ` +
    `SB_BRIDGE_PORT=${opts.bridgePort}; export SB_BRIDGE_PORT; ` +
    `SB_BRIDGE_TOKEN="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || ` +
    `od -An -tx1 -N16 /dev/urandom | tr -dc 'a-f0-9')"; export SB_BRIDGE_TOKEN; ` +
    `if [ -x "$D/code-server/bin/code-server" ]; then ` +
    `nohup "$D/code-server/bin/code-server" --auth none --bind-addr 127.0.0.1:${opts.idePort} ` +
    `--extensions-dir "$D/ide-extensions" --user-data-dir "$D/ide-data" > "$D/ide.log" 2>&1 & echo $! > "$D/ide.pid"; fi; ` +
    `SWITCHBOARD_REMOTE=1 PORT=${opts.port} node $D/index.cjs`
  )
}
