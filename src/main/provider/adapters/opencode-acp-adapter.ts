/**
 * OpenCode over the generic ACP adapter (`./acp/acp-adapter.ts`): the launch
 * config for a long-lived `opencode acp` child, plus what only OpenCode
 * needs: reading the user's opencode.json for MCP servers and permission
 * rules, the inline config that lets Switchboard's own MCP tools through
 * without a second prompt, the 1.x version gate, model variants, and the
 * session summary the session scanner reads.
 *
 * Replaced the legacy shell-out adapter (deleted 2026-05-02), which spawned
 * `opencode run --format json` per turn with a 10-30s cold boot.
 */

import { existsSync, promises as fs } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { formatOpencodeModelLabel } from '@shared/models'
import { createMainLogger as createLogger } from '../../logger'
import { generateTitle } from '../../../shared/auto-title'
import { encodeClaudeProjectPath } from '../../projects/session-scanner'
import type { RuntimeMode } from '../types'
import type { SessionSummary } from '@shared/types'
import { findOpencodePath, buildOpencodeEnv } from './opencode/env'
import { assertSupportedOpencode } from './opencode/version'
import { isSwitchboardOpencodeReadTool, isSwitchboardOpencodeTool, SWITCHBOARD_OPENCODE_TOOLS } from '../../mcp/agent-registration'
import { AcpAdapter } from './acp/acp-adapter'
import type { AcpLaunchConfig, AcpSessionPrep } from './acp/launch-config'

export { mapSessionUpdate, mapAvailableCommands, pickPermissionOptions, parseImageInput } from './acp/acp-adapter'

const log = createLogger('provider:opencode-acp')

function opencodePermissionNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

type OpencodePermissionValue = 'allow' | 'ask' | 'deny'

export interface OpencodeUserPermissionRule {
  key: string
  value: OpencodePermissionValue
}

interface OpencodeUserPermissionContext {
  permissionRules?: readonly OpencodeUserPermissionRule[]
  userMcpServerNames?: readonly string[]
  canTrustUserConfig?: boolean
}

export function opencodePermissionGlobMatchesTool(pattern: string, toolName: string): boolean {
  const memo = new Map<string, boolean>()
  const matches = (pi: number, ti: number): boolean => {
    const key = `${pi}:${ti}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    let result: boolean
    if (pi === pattern.length) {
      result = ti === toolName.length
    } else if (pattern[pi] === '*') {
      result = matches(pi + 1, ti) || (ti < toolName.length && matches(pi, ti + 1))
    } else if (ti < toolName.length && (pattern[pi] === '?' || pattern[pi] === toolName[ti])) {
      result = matches(pi + 1, ti + 1)
    } else {
      result = false
    }

    memo.set(key, result)
    return result
  }
  return matches(0, 0)
}

export function opencodePermissionGlobCouldMatchServerTools(pattern: string, serverName: string): boolean {
  const prefix = `${serverName}_`
  const memo = new Map<string, boolean>()
  const matchesPrefix = (pi: number, si: number): boolean => {
    const key = `${pi}:${si}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    let result: boolean
    if (si === prefix.length) {
      result = true
    } else if (pi === pattern.length) {
      result = false
    } else if (pattern[pi] === '*') {
      result = matchesPrefix(pi + 1, si) || matchesPrefix(pi, si + 1)
    } else if (pattern[pi] === '?' || pattern[pi] === prefix[si]) {
      result = matchesPrefix(pi + 1, si + 1)
    } else {
      result = false
    }

    memo.set(key, result)
    return result
  }
  return matchesPrefix(0, 0)
}

function normalizedOpencodeServerNames(mcpServerNames: readonly string[]): string[] {
  return mcpServerNames.map((name) => opencodePermissionNamePart(name.trim())).filter(Boolean)
}

export function canAutoAllowSwitchboardOpencodeTool(
  toolName: string,
  userMcpServerNames: readonly string[],
  permissionRules: readonly OpencodeUserPermissionRule[],
  canTrustUserConfig = true,
): boolean {
  if (!canTrustUserConfig || !isSwitchboardOpencodeTool(toolName)) return false
  const servers = normalizedOpencodeServerNames(userMcpServerNames)
  if (servers.includes('switchboard')) return false
  if (servers.some((server) => toolName.startsWith(`${server}_`))) return false
  return !permissionRules.some((rule) => {
    return (rule.value === 'ask' || rule.value === 'deny') && opencodePermissionGlobMatchesTool(rule.key, toolName)
  })
}

function shouldAskForOpencodeMcpServer(
  serverName: string,
  permissionRules: readonly OpencodeUserPermissionRule[],
): boolean {
  return !permissionRules.some((rule) => {
    return rule.value === 'deny' && opencodePermissionGlobCouldMatchServerTools(rule.key, serverName)
  })
}

export function buildOpencodeMcpPermissionContent(
  _mode: RuntimeMode,
  mcpServerNames: readonly string[],
  switchboardMcp: boolean,
  userPolicy: OpencodeUserPermissionContext = {},
): string | null {
  if (userPolicy.canTrustUserConfig === false) return null
  const permission: Record<string, 'allow' | 'ask'> = {}
  const permissionRules = userPolicy.permissionRules ?? []
  const servers = normalizedOpencodeServerNames(mcpServerNames)
  for (const server of servers) {
    if (shouldAskForOpencodeMcpServer(server, permissionRules)) permission[`${server}_*`] = 'ask'
  }
  if (switchboardMcp) {
    const userMcpServerNames = userPolicy.userMcpServerNames ?? servers
    for (const tool of SWITCHBOARD_OPENCODE_TOOLS) {
      if (canAutoAllowSwitchboardOpencodeTool(tool, userMcpServerNames, permissionRules)) permission[tool] = 'allow'
    }
  }
  if (Object.keys(permission).length === 0) return null
  return JSON.stringify({ permission })
}

function removeJsonComments(input: string): string {
  let out = ''
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        inString = false
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

function removeTrailingJsonCommas(input: string): string {
  let out = ''
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        inString = false
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (/\s/.test(input[j] ?? '')) j++
      if (input[j] === '}' || input[j] === ']') continue
    }
    out += ch
  }
  return out
}

function parseOpencodeConfigObject(source: string, label: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(removeTrailingJsonCommas(removeJsonComments(source)))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    log.warn(`opencode config ${label} did not contain an object`)
  } catch (err) {
    log.warn(`failed to parse opencode config ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

function collectMcpNamesFromConfig(config: Record<string, unknown>, out: Set<string>): void {
  const mcp = config.mcp
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return
  for (const [name, value] of Object.entries(mcp as Record<string, unknown>)) {
    const enabled = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { enabled?: unknown }).enabled
      : undefined
    if (enabled !== false) out.add(name)
  }
}

function isOpencodePermissionValue(value: unknown): value is OpencodePermissionValue {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function collectPermissionRulesFromConfig(config: Record<string, unknown>, out: OpencodeUserPermissionRule[]): void {
  const permission = config.permission
  if (isOpencodePermissionValue(permission)) {
    out.push({ key: '*', value: permission })
    return
  }
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return
  for (const [key, value] of Object.entries(permission as Record<string, unknown>)) {
    if (key && isOpencodePermissionValue(value)) out.push({ key, value })
  }
}

function opencodeGlobalConfigHome(env: Record<string, string | undefined>): string | null {
  return env.HOME || homedir() || null
}

const OPENCODE_ROOT_CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc', 'config'] as const
const OPENCODE_PROJECT_CONFIG_FILES = ['opencode.json', 'opencode.jsonc'] as const

function pushOpencodeConfigFiles(out: string[], dir: string, names: readonly string[]): void {
  for (const name of names) out.push(join(dir, name))
}

function opencodeProjectConfigDirs(cwd: string): string[] {
  const dirs: string[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir)
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
  }
  return dirs
}

function opencodeConfigFileSources(cwd: string, env: Record<string, string | undefined>): string[] {
  const files: string[] = []
  const xdgConfig = env.XDG_CONFIG_HOME
  if (xdgConfig) pushOpencodeConfigFiles(files, join(xdgConfig, 'opencode'), OPENCODE_ROOT_CONFIG_FILES)

  const configHome = opencodeGlobalConfigHome(env)
  if (configHome) pushOpencodeConfigFiles(files, join(configHome, '.config', 'opencode'), OPENCODE_ROOT_CONFIG_FILES)

  if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG)

  const projectDirs = opencodeProjectConfigDirs(cwd)
  for (const dir of projectDirs) pushOpencodeConfigFiles(files, dir, OPENCODE_PROJECT_CONFIG_FILES)
  for (const dir of projectDirs) pushOpencodeConfigFiles(files, join(dir, '.opencode'), OPENCODE_PROJECT_CONFIG_FILES)

  if (env.OPENCODE_CONFIG_DIR) {
    pushOpencodeConfigFiles(files, env.OPENCODE_CONFIG_DIR, OPENCODE_ROOT_CONFIG_FILES)
  }

  return [...new Set(files)]
}

interface CollectedOpencodeUserConfig {
  mcpServerNames: string[]
  permissionRules: OpencodeUserPermissionRule[]
  canTrustUserConfig: boolean
}

async function collectConfiguredOpencodeUserConfig(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CollectedOpencodeUserConfig> {
  const names = new Set<string>()
  const permissionRules: OpencodeUserPermissionRule[] = []
  let canTrustUserConfig = true

  for (const file of opencodeConfigFileSources(cwd, env)) {
    if (!existsSync(file)) continue
    try {
      const parsed = parseOpencodeConfigObject(await fs.readFile(file, 'utf8'), file)
      if (parsed) {
        collectMcpNamesFromConfig(parsed, names)
        collectPermissionRulesFromConfig(parsed, permissionRules)
      } else {
        canTrustUserConfig = false
      }
    } catch (err) {
      log.warn(`failed to read opencode config ${file}: ${err instanceof Error ? err.message : String(err)}`)
      canTrustUserConfig = false
    }
  }

  if (env.OPENCODE_CONFIG_CONTENT) {
    const parsed = parseOpencodeConfigObject(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT')
    if (parsed) {
      collectMcpNamesFromConfig(parsed, names)
      collectPermissionRulesFromConfig(parsed, permissionRules)
    } else {
      canTrustUserConfig = false
    }
  }

  return { mcpServerNames: [...names].sort(), permissionRules, canTrustUserConfig }
}

const OPENCODE_PERMISSION_STRENGTH: Record<OpencodePermissionValue, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
}

function permissionIsAtLeastAsProtective(value: unknown, baseline: OpencodePermissionValue): boolean {
  return isOpencodePermissionValue(value)
    && OPENCODE_PERMISSION_STRENGTH[value] >= OPENCODE_PERMISSION_STRENGTH[baseline]
}

function generatedRulesForScalarDefault(
  generated: Record<string, unknown>,
  baseline: OpencodePermissionValue,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(generated)) {
    if (permissionIsAtLeastAsProtective(value, baseline)) out[key] = value
  }
  return out
}

function mergeOpencodeInlineConfig(existing: string | undefined, injected: string): string {
  if (!existing) return injected
  const base = parseOpencodeConfigObject(existing, 'existing OPENCODE_CONFIG_CONTENT')
  const extra = parseOpencodeConfigObject(injected, 'Switchboard OPENCODE_CONFIG_CONTENT')
  if (!base || !extra) return injected
  const extraPermission = extra.permission && typeof extra.permission === 'object' && !Array.isArray(extra.permission)
    ? extra.permission as Record<string, unknown>
    : {}
  if (isOpencodePermissionValue(base.permission)) {
    return JSON.stringify({
      ...base,
      permission: {
        '*': base.permission,
        ...generatedRulesForScalarDefault(extraPermission, base.permission),
      },
    })
  }
  const basePermission = base.permission && typeof base.permission === 'object' && !Array.isArray(base.permission)
    ? base.permission as Record<string, unknown>
    : {}
  return JSON.stringify({
    ...base,
    permission: {
      ...extraPermission,
      ...basePermission,
    },
  })
}


function displayToolName(toolName: string, mcpServerNames: readonly string[]): string {
  for (const server of mcpServerNames) {
    const prefix = `${server}_`
    if (toolName.startsWith(prefix) && toolName.length > prefix.length) {
      return `${server} · ${toolName.slice(prefix.length)}`
    }
  }
  const split = toolName.indexOf('_')
  if (split <= 0 || split >= toolName.length - 1) return toolName
  return `${toolName.slice(0, split)} · ${toolName.slice(split + 1)}`
}

async function prepareOpencodeSession(input: {
  cwd: string
  env: Record<string, string>
  runtimeMode: RuntimeMode
  switchboardMcp: boolean
}): Promise<AcpSessionPrep> {
  const userConfig = await collectConfiguredOpencodeUserConfig(input.cwd, input.env)
  const mcpServerNames = userConfig.mcpServerNames
    .map((name) => opencodePermissionNamePart(name.trim()))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const mcpPermissionContent = buildOpencodeMcpPermissionContent(
    input.runtimeMode,
    userConfig.mcpServerNames,
    input.switchboardMcp,
    {
      permissionRules: userConfig.permissionRules,
      userMcpServerNames: userConfig.mcpServerNames,
      canTrustUserConfig: userConfig.canTrustUserConfig,
    },
  )
  const env = mcpPermissionContent
    ? { ...input.env, OPENCODE_CONFIG_CONTENT: mergeOpencodeInlineConfig(input.env.OPENCODE_CONFIG_CONTENT, mcpPermissionContent) }
    : input.env
  return {
    env,
    mcpServerNames,
    // OpenCode asks about MCP tools only when the user's config says so. In
    // plan mode only our read tools skip the prompt, so a write is denied here too.
    autoAllowSwitchboardTool: (toolName, mode) =>
      (mode !== 'plan' || isSwitchboardOpencodeReadTool(toolName))
      && canAutoAllowSwitchboardOpencodeTool(toolName, mcpServerNames, userConfig.permissionRules, userConfig.canTrustUserConfig),
    displayToolName: (toolName) => displayToolName(toolName, mcpServerNames),
  }
}

/** Writes the summary that makes the session visible to the session scanner. */
async function persistOpencodeSessionSummary(input: { sessionId: string; message: string; session: { cwd: string; createdAt: number } }): Promise<void> {
  try {
    const opencodeDir = join(homedir(), '.opencode', 'sessions')
    const projectSessionsDir = join(opencodeDir, encodeClaudeProjectPath(input.session.cwd))
    await fs.mkdir(projectSessionsDir, { recursive: true })
    const summaryPath = join(projectSessionsDir, `${input.sessionId}.json`)
    const summary: Pick<SessionSummary, 'id' | 'source' | 'title' | 'startedAt'> & { projectPath: string } = {
      id: input.sessionId,
      source: 'opencode',
      title: generateTitle(input.message),
      startedAt: input.session.createdAt,
      projectPath: input.session.cwd,
    }
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2))
    log.info(`persisted opencode session summary to ${summaryPath}`)
  } catch (err) {
    log.warn(`Failed to persist OpenCode session summary: ${err instanceof Error ? err.message : String(err)}`)
  }
}

type OpencodeModelMeta = { opencode?: { modelId?: string; variant?: string | null; availableVariants?: string[] } }

export const OPENCODE_ACP_LAUNCH: AcpLaunchConfig = {
  provider: 'opencode',
  label: 'OpenCode',
  notFoundMessage: 'OpenCode not found. Install: curl -fsSL https://opencode.ai/install | bash',
  signInHint: 'Run `opencode auth login` in a terminal, then try again.',
  // OpenCode ships only `build` and `plan`. The finer-grained modes
  // (`sandbox` / `accept-edits` / `full-access`) become local permission
  // policy on top of `requestPermission`; the agent-side mode stays `build`.
  modes: { kind: 'fixed', plan: 'plan', other: 'build' },
  expectedCapabilities: ['resume', 'image'],
  findBinary: findOpencodePath,
  args: (cwd) => ['acp', '--cwd', cwd],
  // OPENCODE_ENABLE_QUESTION_TOOL=1 enables the AskUserQuestion-style tool
  // for ACP clients (off by default since not all clients support
  // interactive question UIs). We do, so flip it on. Instance env vars
  // overlay `buildOpencodeEnv`'s shell + settings-DB layers so per-instance
  // keys win.
  buildEnv: (overlay) => buildOpencodeEnv({ OPENCODE_ENABLE_QUESTION_TOOL: '1', ...overlay }),
  preflight: assertSupportedOpencode,
  prepareSession: prepareOpencodeSession,
  modelLabel: (model) => formatOpencodeModelLabel(model.modelId),
  modelVariants: (meta) => {
    const variants = (meta as OpencodeModelMeta | null | undefined)?.opencode
    if (!variants) return null
    return {
      modelId: variants.modelId,
      availableVariants: Array.isArray(variants.availableVariants) ? variants.availableVariants : [],
      variant: typeof variants.variant === 'string' ? variants.variant : '',
    }
  },
  onFirstPrompt: persistOpencodeSessionSummary,
}

export class OpencodeAcpAdapter extends AcpAdapter {
  constructor() {
    super(OPENCODE_ACP_LAUNCH)
  }
}
