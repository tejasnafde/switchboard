/**
 * The remote bootstrap shell the tunnel runs before `node index.cjs`.
 *
 * Field evidence: a wedged server at 99% CPU ignored the single `kill` the old
 * bootstrap sent, `sleep 1` elapsed, and the fresh server EADDRINUSE'd behind
 * ssh's -L forward. Recovery needs a BOUNDED escalation - TERM, wait, then KILL
 * - while keeping the process-identity guard that stops us signalling a
 * recycled pid or someone else's listener. `pkill` would do the job and is
 * exactly what we must not use: it would take out a healthy code-server (or any
 * unrelated `node index.cjs`) on a shared VM.
 *
 * A second incident this pins down: matching on the BASENAME `index.cjs`
 * (rather than the full managed path) can true-positive on some unrelated
 * process on a shared VM. The guard must be the full executable path, matched
 * as a literal fixed string.
 *
 * A third incident this pins down: code-server's `bin/code-server` is a shell
 * wrapper ending in `exec "$ROOT/lib/node" "$ROOT" "$@"` - `exec` replaces the
 * process image in place, so once it runs, `/proc/<pid>/cmdline` for that pid
 * no longer contains `bin/code-server` at all. A guard matching the launcher
 * path (as the code shipped at one point) is therefore permanently false by
 * the time the NEXT connection's reap runs, and the stale IDE process survives
 * to EADDRINUSE the fresh one. The fix matches the installation-owned
 * directory prefix (`$D/code-server/`) instead, which is still present in the
 * post-exec cmdline because it prefixes `lib/node`'s own path.
 *
 * String assertions are load-bearing here because the fragment targets
 * `/proc/<pid>/cmdline`, which only exists on Linux and cannot be exercised
 * end-to-end from darwin CI. Syntax (`bash -n`) is checked on every platform;
 * the real escalation against a live process additionally runs for real, but
 * only where `/proc` exists.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import {
  buildManagedPathExport,
  buildStaleProcessKill,
  MANAGED_BIN_SHELL_DIR,
  BACKEND_CMDLINE_MATCH,
  IDE_CMDLINE_MATCH,
} from '../../src/main/machines/remoteBootstrap'
import { REMOTE_COMMAND } from '../../src/main/machines/connectDeps'

describe('buildStaleProcessKill', () => {
  const frag = buildStaleProcessKill({ pidVar: 'P', cmdlineMatch: '$D/index.cjs', graceSeconds: 10 })

  it('only signals a pid whose cmdline is still our process, matched as a full path literal', () => {
    // -F (fixed string) and -- (end of options): the match is the whole
    // managed executable path, not a basename, and not interpreted as a
    // regex or a grep flag.
    expect(frag).toContain('grep -qsaF -- "$D/index.cjs" "/proc/$P/cmdline"')
  })

  it('sends TERM first, then escalates to KILL', () => {
    const term = frag.indexOf('kill -TERM "$P"')
    const hard = frag.indexOf('kill -KILL "$P"')
    expect(term).toBeGreaterThan(-1)
    expect(hard).toBeGreaterThan(term)
  })

  it('bounds the graceful wait instead of blocking the bootstrap forever', () => {
    expect(frag).toContain('-lt 10')
    expect(frag).toMatch(/while\b/)
  })

  it('re-verifies process identity before escalating, so a recycled pid is safe', () => {
    // Between TERM and KILL the pid can be freed and handed to an unrelated
    // process. `kill -0` would happily confirm that stranger is alive; only a
    // cmdline re-check proves it is still our server.
    const hard = frag.indexOf('kill -KILL "$P"')
    const guardBeforeKill = frag.lastIndexOf('grep -qsaF -- "$D/index.cjs" "/proc/$P/cmdline"', hard)
    expect(guardBeforeKill).toBeGreaterThan(-1)
    expect(guardBeforeKill).toBeLessThan(hard)
    expect(frag).not.toContain('kill -0')
  })

  it('never reaches for pkill/killall, which would hit unrelated listeners', () => {
    expect(frag).not.toMatch(/pkill|killall|fuser/)
  })

  it('parameterises the identity guard per managed process, keeping code-server distinct', () => {
    const ide = buildStaleProcessKill({
      pidVar: 'IP',
      cmdlineMatch: IDE_CMDLINE_MATCH,
      graceSeconds: 5,
    })
    expect(ide).toContain(`grep -qsaF -- "${IDE_CMDLINE_MATCH}" "/proc/$IP/cmdline"`)
    expect(ide).toContain('-lt 5')
    expect(ide).not.toMatch(/pkill|killall/)
    // The two guards must never be able to satisfy each other.
    expect(ide).not.toContain('index.cjs')
    expect(frag).not.toContain('code-server')
  })

  it('the code-server match is an installation-owned directory prefix, not the launcher path', () => {
    // `bin/code-server` execs into `lib/node`, so a guard pinned to the
    // launcher's own basename or exact script path would go permanently
    // false the instant that exec happens - see the file-header incident (3).
    expect(IDE_CMDLINE_MATCH).toBe('$D/code-server/')
    expect(IDE_CMDLINE_MATCH).not.toContain('bin/code-server')
    expect(IDE_CMDLINE_MATCH).not.toBe('code-server')
  })

  describe('modeling the real code-server exec (bin/code-server -> lib/node)', () => {
    // bin/code-server's actual last line is `exec "$ROOT/lib/node" "$ROOT" "$@"`
    // (verified against coder/code-server's ci/build/code-server.sh). After
    // that exec, /proc/<pid>/cmdline for the SAME pid reads like the
    // NUL-joined argv below - no `bin/code-server` substring survives it.
    const postExecCmdline = (root: string) =>
      [`${root}/lib/node`, root, '--auth', 'none', '--bind-addr', '127.0.0.1:8766'].join('\0')

    it('a directory-prefix match still recognizes the post-exec cmdline as ours', () => {
      const root = '/tmp/sb/code-server'
      const cmdline = postExecCmdline(root)
      // Same fixed-string check the generated fragment runs, applied directly
      // to the modeled post-exec bytes: `$D/code-server/` (with D=/tmp/sb)
      // must still be found even though `bin/code-server` is gone.
      expect(cmdline).not.toContain('bin/code-server')
      expect(cmdline).toContain('/tmp/sb/code-server/')
    })

    it('the OLD launcher-path match would have gone permanently false post-exec', () => {
      const root = '/tmp/sb/code-server'
      const cmdline = postExecCmdline(root)
      const staleLauncherMatch = `${root}/bin/code-server`
      expect(cmdline).not.toContain(staleLauncherMatch)
    })

    // /proc/<pid>/cmdline is Linux-only; these run the ACTUAL generated
    // fragment against real backgrounded bash processes shaped like the
    // pre-exec launcher and the post-exec bundled-node cmdline, rather than a
    // hand-written paraphrase of either.
    // Guaranteed cleanup for both tests below: an EXIT trap fires whether the
    // script finishes normally, an assertion never runs, or `set -e` bails
    // early - a manual kill line at the bottom of the script would not.
    const killOnExitTrap = `trap 'kill -KILL "$IP" 2>/dev/null || true' EXIT`

    ;(platform() === 'linux' ? it : it.skip)(
      'reaps a pid whose cmdline matches the post-exec shape, via the actual generated fragment',
      () => {
        // A real JS-created literal, baked directly into the child's argv
        // text below. It must NOT be the shell variable reference `$D`: a
        // `bash -c '...'` child never expands its parent's un-exported `D`,
        // so a literal "$D" would sit unexpanded in /proc/<pid>/cmdline while
        // the guard's grep pattern (built from the real `D=` assignment in
        // THIS script) expands to the real path - the two would never match.
        const root = `/tmp/sb_rbc_reap_${process.pid}`
        const script = [
          'set -e',
          killOnExitTrap,
          `D=${root}`,
          // Shaped like code-server's cmdline AFTER it execs into lib/node:
          // argv[0] is "$root/code-server/lib/node", argv[1] is "$root/code-server".
          `bash -c 'trap "" TERM; : "${root}/code-server/lib/node" "${root}/code-server"; while :; do sleep 1; done' & IP=$!`,
          'sleep 0.3',
          buildStaleProcessKill({ pidVar: 'IP', cmdlineMatch: IDE_CMDLINE_MATCH, graceSeconds: 1 }),
          'if kill -0 "$IP" 2>/dev/null; then echo SURVIVED; else echo REAPED; fi',
        ].join('\n')
        const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
        expect(out).toBe('REAPED')
      },
    )

    ;(platform() === 'linux' ? it : it.skip)(
      'never reaps an unrelated process holding the recorded pid, via the actual generated fragment',
      () => {
        const script = [
          'set -e',
          killOnExitTrap,
          'D=/tmp/sb_rbc_unrelated_$$',
          // A genuinely unrelated process on a shared VM: no "$D/code-server/"
          // substring anywhere in its cmdline, even though we (incorrectly,
          // for this test) treat its pid as the one we recorded.
          `bash -c 'trap "" TERM; : some_other_tenants_process; while :; do sleep 1; done' & IP=$!`,
          'sleep 0.3',
          buildStaleProcessKill({ pidVar: 'IP', cmdlineMatch: IDE_CMDLINE_MATCH, graceSeconds: 1 }),
          'if kill -0 "$IP" 2>/dev/null; then echo SURVIVED; else echo REAPED; fi',
        ].join('\n')
        const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
        expect(out).toBe('SURVIVED')
      },
    )
  })

  it('is syntactically valid shell on every supported platform', () => {
    // `bash -n` only parses - it never touches /proc - so this runs the ACTUAL
    // generated fragment (not a paraphrase) identically on darwin CI and a
    // Linux remote.
    execFileSync('bash', ['-n', '-c', `P=1; D=/tmp/sb; ${frag}`])
  })

  // /proc/<pid>/cmdline is Linux-only; darwin has no equivalent, so the real
  // escalation below is explicitly skipped elsewhere and only proven end to
  // end where the guard it exercises can actually see a cmdline.
  ;(platform() === 'linux' ? it : it.skip)(
    'escalates for real against the ACTUAL generated fragment: a SIGTERM-ignoring child is dead when it returns',
    () => {
      // Unlike a hand-written paraphrase of the TERM/KILL logic, this executes
      // buildStaleProcessKill's own output. The match target is the `-c`
      // script text of a background bash, which is exactly what shows up in
      // that process's /proc/<pid>/cmdline - no `exec` involved, so nothing
      // replaces it away.
      const marker = `sb_test_marker_${process.pid}`
      const real = buildStaleProcessKill({ pidVar: 'P', cmdlineMatch: marker, graceSeconds: 1 })
      const script = [
        'set -e',
        `bash -c 'trap "" TERM; : ${marker}; while :; do sleep 1; done' & P=$!`,
        'sleep 0.3',
        real,
        'if kill -0 "$P" 2>/dev/null; then echo SURVIVED; else echo REAPED; fi',
      ].join('\n')
      const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
      expect(out).toBe('REAPED')
    },
  )
})

describe('buildManagedPathExport', () => {
  const frag = buildManagedPathExport()

  it('prepends the managed CLI bin dir so provisioning-installed tools win', () => {
    // The 4th field-evidence item: the ssh non-interactive PATH the tunnel
    // inherits omits ~/.local/bin, where provisioning links claude and codex.
    expect(frag).toContain(`PATH="${MANAGED_BIN_SHELL_DIR}:$PATH"`)
    expect(frag).toContain('export PATH')
  })

  it('publishes the managed dir explicitly so the server does not re-guess it', () => {
    expect(frag).toContain(`SWITCHBOARD_MANAGED_BIN="${MANAGED_BIN_SHELL_DIR}"`)
    expect(frag).toContain('export SWITCHBOARD_MANAGED_BIN')
  })
})

describe('REMOTE_COMMAND', () => {
  it('kills a lingering server tracked by pidfile before launching a fresh one', () => {
    expect(REMOTE_COMMAND).toContain('server.pid')
    expect(REMOTE_COMMAND).toContain('kill -TERM "$P"')
    expect(REMOTE_COMMAND).toContain('node $D/index.cjs')
  })

  it('bounds the wait for both managed processes and never broadens to pkill', () => {
    expect(REMOTE_COMMAND).toContain('kill -KILL "$P"')
    expect(REMOTE_COMMAND).toContain('kill -KILL "$IP"')
    expect(REMOTE_COMMAND).not.toMatch(/pkill|killall|fuser/)
  })

  it('guards each kill on that pid still being the process we started, by full path not basename', () => {
    expect(REMOTE_COMMAND).toContain(`grep -qsaF -- "${BACKEND_CMDLINE_MATCH}" "/proc/$P/cmdline"`)
    expect(REMOTE_COMMAND).toContain(`grep -qsaF -- "${IDE_CMDLINE_MATCH}" "/proc/$IP/cmdline"`)
  })

  it('the code-server guard survives the launcher exec: it never pins the bin/code-server path', () => {
    // If this were still `$D/code-server/bin/code-server`, it would go
    // permanently false the moment that script `exec`s into `lib/node` -
    // see the file-header incident (3) - and the stale IDE process would
    // never be reaped.
    expect(REMOTE_COMMAND).not.toContain('grep -qsaF -- "$D/code-server/bin/code-server"')
  })

  it('is syntactically valid shell (the full generated bootstrap, not a fragment)', () => {
    execFileSync('bash', ['-n', '-c', REMOTE_COMMAND])
  })

  it('exports the managed bin PATH before BOTH launches', () => {
    const pathAt = REMOTE_COMMAND.indexOf('export PATH')
    const codeServerAt = REMOTE_COMMAND.indexOf('nohup "$D/code-server/bin/code-server"')
    const nodeAt = REMOTE_COMMAND.indexOf('node $D/index.cjs')
    expect(pathAt).toBeGreaterThan(-1)
    expect(pathAt).toBeLessThan(codeServerAt)
    expect(pathAt).toBeLessThan(nodeAt)
  })

  it('still mints one shared bridge token before either launch', () => {
    const tokenAt = REMOTE_COMMAND.indexOf('export SB_BRIDGE_TOKEN')
    const portAt = REMOTE_COMMAND.indexOf('export SB_BRIDGE_PORT')
    const codeServerAt = REMOTE_COMMAND.indexOf('nohup "$D/code-server/bin/code-server"')
    const nodeAt = REMOTE_COMMAND.indexOf('node $D/index.cjs')
    expect(tokenAt).toBeGreaterThan(-1)
    expect(tokenAt).toBeLessThan(codeServerAt)
    expect(tokenAt).toBeLessThan(nodeAt)
    expect(portAt).toBeLessThan(codeServerAt)
    expect(portAt).toBeLessThan(nodeAt)
  })
})
