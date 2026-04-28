/**
 * OpenCode adapter.
 *
 * Spawns `opencode run --format json` for each turn and parses the JSONL
 * event stream. OpenCode is a terminal coding agent that supports 80+ model
 * providers via OpenAI-compatible APIs — including NVIDIA NIM's free tier.
 *
 * Configure providers in ~/.config/opencode/opencode.json:
 *   {
 *     "provider": {
 *       "nvidia-nim": {
 *         "npm": "@ai-sdk/openai-compatible",
 *         "name": "NVIDIA NIM",
 *         "options": {
 *           "baseURL": "https://integrate.api.nvidia.com/v1",
 *           "apiKey": "{env:NVIDIA_API_KEY}"
 *         },
 *         "models": {
 *           "meta/llama-3.1-70b-instruct": { "name": "Llama 3.1 70B" }
 *         }
 *       }
 *     }
 *   }
 * Then pass model as "nvidia-nim/meta/llama-3.1-70b-instruct".
 *
 * OpenCode JSONL event types (--format json):
 *   Each event wraps its data under `part` — the shape is:
 *     { type, timestamp, sessionID, part: { ...fields } }
 *
 *   step_start   — part.type === "step-start"
 *   text         — part: { type: "text", text, time: { start, end } }
 *   tool_use     — part: { type: "tool", tool, state: { input, output, ... } }
 *   step_finish  — part: { type: "step-finish", reason, tokens: { input, output, ... } }
 *   error        — part.error.{data.message|message}
 *
 * Multi-turn continuity: subsequent sendTurn calls pass --continue which
 * resumes the last session for the working directory. Works correctly when
 * each Switchboard thread uses a distinct cwd (the typical case).
 */

import { spawn, spawnSync, execSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { basename, join as joinPath } from 'path'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { createMainLogger as createLogger } from '../../logger'
import { getSetting } from '../../db/database'
import type {
  ProviderAdapter,
  ProviderSession,
  SessionStartOpts,
  RuntimeEvent,
  RuntimeMode,
  ApprovalDecision,
} from '../types'

/**
 * API keys that Switchboard persists in the settings table and injects into
 * opencode's env at spawn time. Matches the `{env:VAR}` keys users put in
 * their ~/.config/opencode/opencode.json. If a key is set in both the shell
 * env and Switchboard settings, settings wins (so users can override without
 * editing shell profiles).
 */
const OPENCODE_API_KEYS = [
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY', // ai-sdk/google canonical name
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
] as const

const log = createLogger('provider:opencode')
const LOG_PAYLOAD_LIMIT = 4000

function truncate(v: string): string {
  return v.length > LOG_PAYLOAD_LIMIT
    ? `${v.slice(0, LOG_PAYLOAD_LIMIT)}…<truncated>`
    : v
}

/** Find opencode binary on PATH and common install locations */
function findOpencodePath(): string | null {
  const home = process.env.HOME || ''
  const candidates = [
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    `${home}/.local/bin/opencode`,
    `${home}/.npm-global/bin/opencode`,
    `${home}/node_modules/.bin/opencode`,
  ]
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { timeout: 2000 })
      return p
    } catch { /* not found */ }
  }
  try {
    return execSync('which opencode 2>/dev/null', {
      encoding: 'utf-8', timeout: 5000,
    }).trim().split('\n')[0] || null
  } catch {
    return null
  }
}

let cachedPath: string | null | undefined

/**
 * Load env vars from the user's login shell.
 *
 * Electron on macOS doesn't source ~/.zshrc when launched from Finder or
 * via `npm run dev` in a terminal that was opened before the var was
 * exported. That leaves NVIDIA_API_KEY (and similar) missing from
 * process.env, so opencode's `{env:NVIDIA_API_KEY}` resolves to empty and
 * every API call 401s. Pattern borrowed from OpenCode's own desktop app
 * (packages/desktop-electron/src/main/shell-env.ts).
 *
 * Cached after first successful load.
 */
let cachedShellEnv: Record<string, string> | null | undefined
function loadShellEnv(): Record<string, string> | null {
  if (cachedShellEnv !== undefined) return cachedShellEnv
  // Windows shells don't have a POSIX-compatible `env -0` builtin and
  // the wrapper invocation (`bash -il -c 'env -0'`) doesn't exist on
  // most Windows installs. Skip the probe entirely; the user's
  // environment already comes through `process.env` thanks to how
  // Windows propagates env through CreateProcess. opencode model
  // listing degrades to "no extras surfaced from ~/.zshrc" — fine on
  // Windows where users don't typically keep API keys in shell rc.
  if (process.platform === 'win32') {
    log.info('shell env probe skipped on Windows (no POSIX env -0)')
    cachedShellEnv = null
    return null
  }
  const shell = process.env.SHELL || '/bin/sh'
  const name = basename(shell).toLowerCase()
  // Nushell doesn't support `env -0`, skip
  if (name === 'nu' || name === 'nu.exe') {
    cachedShellEnv = null
    return null
  }
  const tryProbe = (flag: '-il' | '-l'): Record<string, string> | null => {
    const out = spawnSync(shell, [flag, '-c', 'env -0'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    })
    if (out.error || out.status !== 0) return null
    const env: Record<string, string> = {}
    for (const line of out.stdout.toString('utf8').split('\0')) {
      if (!line) continue
      const ix = line.indexOf('=')
      if (ix <= 0) continue
      env[line.slice(0, ix)] = line.slice(ix + 1)
    }
    return Object.keys(env).length > 0 ? env : null
  }
  const env = tryProbe('-il') ?? tryProbe('-l')
  cachedShellEnv = env
  if (env) {
    const hasNvidia = 'NVIDIA_API_KEY' in env
    log.info(`shell env loaded: ${Object.keys(env).length} vars (NVIDIA_API_KEY ${hasNvidia ? 'present' : 'MISSING'})`)
  } else {
    log.warn('shell env probe failed — opencode may not see API keys from ~/.zshrc')
  }
  return env
}

/**
 * Read the user's opencode config to extract user-configured provider keys
 * (e.g. ["nvidia-nim", "google"]). Used to dedupe `opencode models` output
 * — the same underlying model can appear under multiple provider IDs (a
 * user's `nvidia-nim/...` config block AND opencode's built-in `nvidia/...`
 * provider from models.dev). We prefer user-configured providers because
 * those are guaranteed to have working API keys wired up.
 *
 * Looks in order of precedence (opencode's own resolution):
 *   $XDG_CONFIG_HOME/opencode/opencode.json
 *   ~/.config/opencode/opencode.json
 *
 * Cached for the adapter's lifetime. Non-fatal on any read/parse error.
 */
let cachedUserProviders: Set<string> | undefined
function getUserConfiguredProviders(): Set<string> {
  if (cachedUserProviders) return cachedUserProviders
  const result = new Set<string>()
  const candidates = [
    process.env.XDG_CONFIG_HOME
      ? joinPath(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')
      : null,
    joinPath(homedir(), '.config', 'opencode', 'opencode.json'),
  ].filter(Boolean) as string[]

  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'))
      const providers = parsed?.provider
      if (providers && typeof providers === 'object') {
        for (const key of Object.keys(providers)) result.add(key)
        log.info(`user-configured opencode providers: ${Array.from(result).join(', ') || '(none)'}`)
        break
      }
    } catch (err: any) {
      log.warn(`failed to read opencode config at ${p}: ${err?.message}`)
    }
  }
  cachedUserProviders = result
  return result
}

/**
 * Dedupe `opencode models` output. The same underlying model often appears
 * under multiple provider IDs:
 *   nvidia/moonshotai/kimi-k2.5        ← models.dev built-in
 *   nvidia-nim/moonshotai/kimi-k2.5    ← user config
 * We prefer the user-configured one because that's where the API key is
 * wired. Group by the "model suffix" (everything after the provider) and
 * keep the best candidate per group.
 */
function dedupeModelIds(ids: string[]): string[] {
  const userProviders = getUserConfiguredProviders()
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const slash = id.indexOf('/')
    if (slash === -1) continue
    const suffix = id.slice(slash + 1)
    const arr = groups.get(suffix) ?? []
    arr.push(id)
    groups.set(suffix, arr)
  }

  const picked: string[] = []
  for (const [, candidates] of groups) {
    if (candidates.length === 1) {
      picked.push(candidates[0])
      continue
    }
    // Prefer user-configured provider. If multiple, pick the longest (more
    // specific, e.g. nvidia-nim over nvidia). If none configured, fall back
    // to alphabetical first so output is deterministic.
    const user = candidates.filter((c) => userProviders.has(c.split('/')[0]))
    if (user.length > 0) {
      picked.push(user.sort((a, b) => b.length - a.length)[0])
    } else {
      picked.push(candidates.sort()[0])
    }
  }
  // Stable order: preserve original ordering within the input
  const order = new Map(ids.map((id, i) => [id, i]))
  picked.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return picked
}

interface ActiveSession {
  session: ProviderSession
  onEvent: (event: RuntimeEvent) => void
  /** Number of turns sent so far — first turn doesn't use --continue */
  turnCount: number
  /** Currently running child process (null between turns) */
  child: ChildProcessWithoutNullStreams | null
  /** Message ID cursor for streaming text chunks */
  currentMessageId: string | null
  /** Accumulated text for the current message (for incremental updates) */
  currentMessageText: string
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const
  private sessions = new Map<string, ActiveSession>()

  async isAvailable(): Promise<boolean> {
    if (cachedPath === undefined) cachedPath = findOpencodePath()
    return cachedPath !== null
  }

  async startSession(
    opts: SessionStartOpts,
    onEvent: (event: RuntimeEvent) => void,
  ): Promise<ProviderSession> {
    if (cachedPath === undefined) cachedPath = findOpencodePath()
    if (!cachedPath) {
      throw new Error('OpenCode not found. Install: curl -fsSL https://opencode.ai/install | bash')
    }

    // If a session already exists for this threadId (e.g. ChatPanel
    // remounted and re-invoked startSession), preserve the model and
    // turnCount that were set via setModel + prior turns. Without this
    // guard, a remount silently clobbers the user's model pick back to
    // whatever the renderer happened to pass in opts.model (usually
    // undefined → falls back to GLM 5.1 default).
    const existing = this.sessions.get(opts.threadId)
    const preservedModel = opts.model && opts.model.length > 0
      ? opts.model
      : existing?.session.model
    const preservedTurnCount = existing?.turnCount ?? 0

    const session: ProviderSession = {
      threadId: opts.threadId,
      provider: 'opencode',
      status: 'idle',
      model: preservedModel,
      runtimeMode: opts.runtimeMode ?? existing?.session.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: existing?.session.createdAt ?? Date.now(),
    }

    this.sessions.set(opts.threadId, {
      session,
      onEvent,
      turnCount: preservedTurnCount,
      child: existing?.child ?? null,
      currentMessageId: null,
      currentMessageText: '',
    })

    onEvent({ type: 'status', threadId: opts.threadId, status: 'idle' })
    log.info(
      `session ${existing ? 'resumed' : 'created'}: ${opts.threadId} ` +
      `model=${preservedModel ?? 'default'} turns=${preservedTurnCount}` +
      `${existing && !opts.model && existing.session.model ? ' (preserved model from previous mount)' : ''}`,
    )
    return session
  }

  async sendTurn(
    threadId: string,
    message: string,
    runtimeMode?: RuntimeMode,
    _images?: Array<{ url: string; mimeType?: string }>,
  ): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) throw new Error(`No OpenCode session: ${threadId}`)
    if (active.child) {
      log.warn(`sendTurn called while turn in progress for ${threadId} — ignoring`)
      return
    }

    if (runtimeMode) active.session.runtimeMode = runtimeMode

    active.session.status = 'running'
    active.onEvent({ type: 'status', threadId, status: 'running' })

    const args = buildRunArgs({
      message,
      model: active.session.model,
      isFirstTurn: active.turnCount === 0,
      runtimeMode: active.session.runtimeMode,
    })

    log.info(`opencode ${args.join(' ')} (cwd=${active.session.cwd})`)

    // Merge login-shell env so NVIDIA_API_KEY and other secrets from
    // ~/.zshrc are visible to opencode. Layering order (later wins):
    //   shell-env < process.env < Switchboard settings-db keys
    // So users can set GEMINI_API_KEY in Settings → Providers and it
    // overrides whatever the shell has (if anything).
    const shellEnv = loadShellEnv()
    const mergedEnv: Record<string, string> = shellEnv
      ? { ...shellEnv, ...(process.env as Record<string, string>) }
      : { ...(process.env as Record<string, string>) }

    const settingsKeys: string[] = []
    for (const key of OPENCODE_API_KEYS) {
      try {
        const val = getSetting(`opencode.env.${key}`)
        if (val && val.length > 0) {
          mergedEnv[key] = val
          settingsKeys.push(key)
        }
      } catch { /* ignore — settings table optional */ }
    }
    if (settingsKeys.length > 0) {
      log.info(`injecting ${settingsKeys.length} API key(s) from settings: ${settingsKeys.join(', ')}`)
    }

    const child = spawn(cachedPath!, args, {
      cwd: active.session.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
    })
    // We never write to stdin (opencode run is non-interactive)
    child.stdin.end()

    active.child = child
    active.turnCount++
    active.currentMessageId = null
    active.currentMessageText = ''

    let sawStop = false
    let sawAnyEvent = false

    // ── Placeholder message so the user sees SOMETHING immediately. ──
    // OpenCode spends 5–30s on cold-boot (MCP init + first network call to
    // NVIDIA NIM) before emitting any JSONL event. Without a placeholder
    // the chat looks frozen — users hit interrupt thinking it hung.
    //
    // We emit a `content` event with a fixed messageId. When the first
    // real `text` event arrives, handleEvent replaces the content. If
    // opencode errors or times out, we update the placeholder with the
    // error text instead.
    const placeholderId = `opencode_waiting_${Date.now()}`
    active.currentMessageId = placeholderId
    active.currentMessageText = ''
    const modelLabel = active.session.model ?? 'default'
    const startedAt = Date.now()

    const emitPlaceholder = (text: string) => {
      active.onEvent({
        type: 'content',
        threadId,
        messageId: placeholderId,
        text,
        streamKind: 'assistant',
      })
    }
    emitPlaceholder(`_Connecting to \`${modelLabel}\`…_`)

    // Heartbeat: update elapsed seconds every 3s until first real event.
    // Kicks the UI out of "feels frozen" territory.
    const heartbeat = setInterval(() => {
      if (sawAnyEvent) return
      const elapsed = Math.floor((Date.now() - startedAt) / 1000)
      emitPlaceholder(`_Waiting for \`${modelLabel}\`… (${elapsed}s)_\n\nFirst response can take 10–30s on NVIDIA NIM free tier. The model is spinning up cold-start compute.`)
    }, 3000)

    // Hard timeout safety — if NOTHING comes back in 3 min, kill and surface
    // a real error instead of hanging forever. NVIDIA NIM free tier can
    // genuinely take 60–120s on cold start (real measurement: GLM 5.1
    // routinely hits 90s+ first-token latency under load), so 120s was
    // borderline. 180s gives room for cold-start without making genuine
    // black holes feel infinite. Bumping further trades user time for
    // false hope — better to fail and let them retry on a different model.
    const timeoutMs = 180_000
    const timeoutHandle = setTimeout(() => {
      if (!active.child) return
      if (sawAnyEvent) return
      log.warn(`opencode timeout after ${timeoutMs}ms — killing child`)
      active.child.kill('SIGTERM')
      // Emit BOTH: a chat-stream message the user can read, and a real
      // error event so the session status flips to 'error' (UI shows the
      // failure pill rather than a stuck "thinking" spinner). Without the
      // error event the renderer never knows the turn ended badly.
      const isFreeTier = active.session.model?.startsWith('nvidia-nim/')
        || active.session.model?.startsWith('opencode/')
      emitPlaceholder(
        `⚠️ \`${modelLabel}\` didn't respond in ${timeoutMs / 1000}s.\n\n` +
        (isFreeTier
          ? `**Free-tier providers (NVIDIA NIM, opencode/*) get rate-limited under load.** ` +
            `Try again in a moment, or switch to a different model from the dropdown — ` +
            `paid providers (Anthropic, OpenAI direct) typically respond in <5s.`
          : `Possible causes: provider overloaded, API key invalid, or network blocked. ` +
            `Check the Electron console for stderr output from opencode.`),
      )
      active.session.status = 'error'
      active.onEvent({
        type: 'error',
        threadId,
        message: `Timed out waiting for ${modelLabel} after ${timeoutMs / 1000}s`,
      })
      active.onEvent({ type: 'status', threadId, status: 'error' })
    }, timeoutMs)

    const clearGuards = () => {
      clearInterval(heartbeat)
      clearTimeout(timeoutHandle)
    }

    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      if (!sawAnyEvent) {
        sawAnyEvent = true
        clearGuards()
        // Replace placeholder with empty string so the "Connecting…" text
        // disappears the moment the real stream starts. We don't actually
        // delete the message (no delete event exists) — emitting empty
        // content causes groupIntoTurns to filter it out. Reset the cursor
        // so the first real text event creates a fresh message.
        active.onEvent({
          type: 'content',
          threadId,
          messageId: placeholderId,
          text: '',
          streamKind: 'assistant',
        })
        active.currentMessageId = null
        active.currentMessageText = ''
      }
      log.debug(`opencode -> ${truncate(trimmed)}`)
      try {
        const event = JSON.parse(trimmed)
        if (handleEvent(event, threadId, active)) {
          sawStop = true
        }
      } catch {
        log.warn(`non-JSON from opencode: ${trimmed.slice(0, 200)}`)
      }
    })

    child.stderr?.on('data', (d: Buffer) => {
      // Bumped from debug → info. Opencode writes setup + MCP cold-boot
      // progress to stderr; without this visible, silent hangs are opaque.
      log.info(`opencode stderr: ${truncate(d.toString())}`)
    })

    child.on('close', (code) => {
      clearGuards()
      active.child = null
      log.info(`opencode exited: code=${code} threadId=${threadId} sawAnyEvent=${sawAnyEvent}`)

      // If the child was killed (by interrupt or our timeout) with no
      // response, replace the placeholder with an explicit aborted message.
      if (!sawAnyEvent) {
        emitPlaceholder(
          code === null
            ? `_Cancelled before \`${modelLabel}\` responded._`
            : `_\`${modelLabel}\` exited (code ${code}) with no response._`,
        )
      }

      if (code !== 0 && code !== null && !sawStop) {
        const msg = `OpenCode exited with code ${code}`
        log.warn(msg)
        active.session.status = 'error'
        active.onEvent({ type: 'error', threadId, message: msg })
        active.onEvent({ type: 'status', threadId, status: 'error' })
        return
      }

      if (!sawStop && sawAnyEvent) {
        active.onEvent({ type: 'turn.completed', threadId })
      }

      active.session.status = 'idle'
      active.onEvent({ type: 'status', threadId, status: 'idle' })
    })

    child.on('error', (err) => {
      clearGuards()
      active.child = null
      active.session.status = 'error'
      active.onEvent({ type: 'error', threadId, message: err.message })
      active.onEvent({ type: 'status', threadId, status: 'error' })
    })
  }

  async interruptTurn(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active?.child) return
    active.child.kill('SIGINT')
    log.info(`interrupted: ${threadId}`)
  }

  async respondToRequest(
    _threadId: string,
    _requestId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {
    // OpenCode runs tools autonomously; no mid-stream approval.
  }

  async setRuntimeMode(threadId: string, mode: RuntimeMode): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.runtimeMode = mode
    log.info(`runtime mode → ${mode} (applied on next turn): ${threadId}`)
  }

  async setModel(threadId: string, model: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    active.session.model = model.length > 0 ? model : undefined
    log.info(`model → ${model || '(default)'} (applied on next turn): ${threadId}`)
  }

  /**
   * Shell out to `opencode models` and parse the `provider/model` lines.
   * Called from IPC so the renderer can populate the model dropdown
   * dynamically instead of relying on a stale hardcoded list.
   *
   * Output format (one per line):
   *   opencode/big-pickle
   *   nvidia-nim/z-ai/glm-5.1
   *   google/gemini-2.5-pro
   *   ...
   *
   * First-run output includes sqlite migration noise on stderr+stdout;
   * we filter by looking for the provider/model slash pattern.
   */
  async listAvailableModels(): Promise<string[]> {
    if (cachedPath === undefined) cachedPath = findOpencodePath()
    if (!cachedPath) return []

    const shellEnv = loadShellEnv()
    const mergedEnv: Record<string, string> = shellEnv
      ? { ...shellEnv, ...(process.env as Record<string, string>) }
      : { ...(process.env as Record<string, string>) }
    for (const key of OPENCODE_API_KEYS) {
      try {
        const val = getSetting(`opencode.env.${key}`)
        if (val && val.length > 0) mergedEnv[key] = val
      } catch { /* ignore */ }
    }

    return new Promise<string[]>((resolve) => {
      const out = spawnSync(cachedPath!, ['models'], {
        env: mergedEnv,
        timeout: 30000,
        encoding: 'utf8',
      })
      if (out.error || out.status !== 0) {
        log.warn(`opencode models failed: ${out.error?.message ?? `status=${out.status}`}`)
        resolve([])
        return
      }
      const lines = (out.stdout ?? '').split('\n')
      const models: string[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        // Each model ID has at least one slash (provider/model) and no spaces
        if (!trimmed || trimmed.includes(' ')) continue
        if (!trimmed.includes('/')) continue
        models.push(trimmed)
      }
      const deduped = dedupeModelIds(models)
      log.info(`opencode models: parsed ${models.length} raw, ${deduped.length} after dedup`)
      resolve(deduped)
    })
  }

  async listSkills(threadId: string): Promise<import('@shared/types').ProviderSkill[]> {
    if (cachedPath === undefined) cachedPath = findOpencodePath()
    if (!cachedPath) return []

    const shellEnv = loadShellEnv()
    const mergedEnv: Record<string, string> = shellEnv
      ? { ...shellEnv, ...(process.env as Record<string, string>) }
      : { ...(process.env as Record<string, string>) }
    for (const key of OPENCODE_API_KEYS) {
      try {
        const val = getSetting(`opencode.env.${key}`)
        if (val && val.length > 0) mergedEnv[key] = val
      } catch { /* ignore */ }
    }

    return new Promise<import('@shared/types').ProviderSkill[]>((resolve) => {
      const out = spawnSync(cachedPath!, ['debug', 'skill'], {
        env: mergedEnv,
        timeout: 10000,
        encoding: 'utf8',
      })
      
      if (out.error || out.status !== 0) {
        log.warn(`opencode debug skill failed: ${out.error?.message ?? `status=${out.status}`}`)
        resolve([])
        return
      }
      
      try {
        // opencode debug skill outputs JSON array of skills
        const skillsRaw = JSON.parse(out.stdout)
        if (!Array.isArray(skillsRaw)) {
          resolve([])
          return
        }
        
        const parsed: import('@shared/types').ProviderSkill[] = skillsRaw.map(s => ({
          name: s.name,
          description: s.description,
          source: 'opencode'
        }))
        
        resolve(parsed)
      } catch (err: any) {
        log.warn(`failed to parse opencode skills: ${err.message}`)
        resolve([])
      }
    })
  }

  async stopSession(threadId: string): Promise<void> {
    const active = this.sessions.get(threadId)
    if (!active) return
    if (active.child) {
      active.child.kill('SIGTERM')
      active.child = null
    }
    this.sessions.delete(threadId)
    log.info(`session stopped: ${threadId}`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Build the CLI args for `opencode run`.
 *
 * Runtime mode → opencode tool-approval equivalent:
 *   plan         → (ideally read-only; opencode v1 doesn't support per-turn
 *                   overrides so we add a system note in the message instead)
 *   sandbox      → default (ask on shell)
 *   accept-edits → same (opencode auto-approves edits by default)
 *   full-access  → --dangerously-skip-permissions equivalent not yet exposed
 */
function buildRunArgs(opts: {
  message: string
  model?: string
  isFirstTurn: boolean
  runtimeMode: RuntimeMode
}): string[] {
  const args: string[] = ['run', '--format', 'json']

  // Always pass --model. Without it, opencode falls back to its built-in
  // default (Anthropic/OpenAI), which hangs indefinitely if those providers
  // aren't authenticated. When the session has no model set (user picked
  // "Default" in the dropdown), fall back to an opencode free-tier model
  // so every user gets something that works without an API key. NVIDIA
  // requires a key; opencode/* built-ins do not.
  const model = opts.model && opts.model.length > 0
    ? opts.model
    : 'opencode/gpt-5-nano'
  args.push('--model', model)

  if (!opts.isFirstTurn) {
    args.push('--continue')
  }

  // Append the user message as the final positional arg
  args.push(opts.message)

  return args
}

/**
 * Process one JSONL line from opencode's --format json output.
 * Returns true if we saw a terminal step_finish (reason=stop).
 */
function handleEvent(
  event: Record<string, unknown>,
  threadId: string,
  active: ActiveSession,
): boolean {
  const type = event.type as string | undefined
  // OpenCode nests per-event data under `part`. Fall back to the event root
  // for any older payload shape.
  const part = (event.part as Record<string, any> | undefined) ?? {}

  switch (type) {
    case 'step_start': {
      // New agent step — nothing visible to emit yet. Reset the cursor so
      // the next text event creates a fresh message; don't generate an id
      // yet (we only need one once text actually arrives, otherwise we
      // create phantom empty messages if the step is tool-only).
      active.currentMessageId = null
      active.currentMessageText = ''
      log.debug(`step_start threadId=${threadId}`)
      break
    }

    case 'text': {
      // Real shape: event.part.text. Fall back to legacy flat `content` if
      // the opencode stream format changes again.
      const content =
        (part.text as string | undefined)
        ?? (event.content as string | undefined)
        ?? ''
      if (!content) break

      if (!active.currentMessageId) {
        active.currentMessageId = `opencode_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      }
      // OpenCode's `text` events each carry the FULL delta for that part in
      // `part.text` — they aren't cumulative token chunks. Replace rather
      // than concatenate so duplicate chunks don't double up.
      active.currentMessageText = content

      active.onEvent({
        type: 'content',
        threadId,
        messageId: active.currentMessageId,
        text: active.currentMessageText,
        streamKind: 'assistant',
      })
      break
    }

    case 'tool_use': {
      // New shape: part.tool (name) + part.state.{input, output}
      const toolName =
        (part.tool as string | undefined)
        ?? (event.name as string | undefined)
        ?? 'unknown'
      const state = (part.state as Record<string, any> | undefined) ?? {}
      const toolId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const inputRaw = state.input ?? event.input
      const outputRaw = state.output ?? event.output
      const inputStr = typeof inputRaw === 'string'
        ? inputRaw
        : JSON.stringify(inputRaw ?? {}, null, 2)
      const outputStr = typeof outputRaw === 'string'
        ? outputRaw
        : JSON.stringify(outputRaw ?? {}, null, 2)

      // Reset text cursor — tool blocks interrupt the text stream
      active.currentMessageId = null
      active.currentMessageText = ''

      active.onEvent({
        type: 'tool.started',
        threadId,
        toolId,
        toolName,
        input: inputStr,
      })
      active.onEvent({
        type: 'tool.completed',
        threadId,
        toolId,
        output: outputStr,
      })
      log.debug(`tool_use: ${toolName} threadId=${threadId}`)
      break
    }

    case 'step_finish': {
      // New shape: part.reason + part.tokens.{input, output}. Older shape
      // was flat event.reason + event.usage.
      const reason = (part.reason as string | undefined) ?? (event.reason as string | undefined)
      const tokens =
        (part.tokens as Record<string, number> | undefined)
        ?? (event.usage as Record<string, number> | undefined)

      if (reason === 'stop') {
        const total = tokens?.input !== undefined && tokens?.output !== undefined
          ? tokens.input + tokens.output
          : undefined

        active.onEvent({
          type: 'turn.completed',
          threadId,
          usedTokens: total,
        })

        if (total !== undefined) {
          active.onEvent({
            type: 'context_window',
            threadId,
            usedTokens: total,
            maxTokens: null,
          })
        }

        log.debug(`step_finish stop threadId=${threadId} tokens=${total}`)
        return true // signal turn done
      }
      // reason === 'tool-calls' — more steps coming, keep streaming
      break
    }

    case 'error': {
      // OpenCode's error event nests the real message inside
      // `event.error.data.message` for API errors, or `event.error.message`
      // for generic errors. Fall back to stringify so we never show
      // "[object Object]" to the user.
      const err = event.error as Record<string, any> | undefined
      const nested = err?.data?.message ?? err?.message
      const status = err?.data?.statusCode
      const url = err?.data?.metadata?.url
      let message = nested
        || (typeof event.message === 'string' ? event.message : '')
        || (typeof event.error === 'string' ? event.error : '')
        || JSON.stringify(event.error ?? event)

      if (status === 401 && url?.includes('nvidia.com')) {
        message = `NVIDIA auth failed (401): ${nested ?? 'missing API key'}.\n\nFix: export NVIDIA_API_KEY="nvapi-..." in the shell you launched Switchboard from, then restart. Switchboard does not source ~/.zshrc automatically — the variable must be set in the parent process env.`
      } else if (status) {
        message = `OpenCode API error ${status}: ${nested ?? message}`
      }

      log.error(`opencode error: ${message}`)
      active.onEvent({ type: 'error', threadId, message })
      break
    }

    default:
      log.debug(`unhandled opencode event type: ${type}`)
  }

  return false
}
