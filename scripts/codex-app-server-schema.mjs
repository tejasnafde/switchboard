#!/usr/bin/env node
// Regenerates tests/fixtures/codex-app-server-schema.json from the installed
// Codex CLI: the app-server methods Switchboard uses, with every definition
// their params and responses reference. codex-protocol-schema.test.ts checks
// what codex-adapter.ts and usage/*.ts send and read against it.
//
//   node scripts/codex-app-server-schema.mjs [--codex <path-to-codex>] [--out <file>]
//
// A throwaway CODEX_HOME keeps the run away from every account folder.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Add a method here when the adapter starts to send, answer or read a new one.
const USED = {
  clientRequests: [
    'initialize',
    'thread/start',
    'thread/resume',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'skills/list',
    'model/list',
    'account/read',
    'account/rateLimits/read',
    'account/rateLimitResetCredit/consume',
  ],
  clientNotifications: ['initialized'],
  serverRequests: [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
  ],
  serverNotifications: [
    'thread/started',
    'thread/status/changed',
    'thread/tokenUsage/updated',
    'turn/started',
    'turn/completed',
    'turn/diff/updated',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated',
    'error',
    'account/rateLimits/updated',
    'remoteControl/status/changed',
    'mcpServer/startupStatus/updated',
  ],
}

// Responses whose name does not follow `<Params name minus Params>Response`.
const RESPONSE_NAMES = { 'account/rateLimits/read': '#/definitions/v2/GetAccountRateLimitsResponse' }

const BUNDLE = 'codex_app_server_protocol.schemas.json'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const codex = arg('--codex', 'codex')
const out = resolve(arg('--out', 'tests/fixtures/codex-app-server-schema.json'))

const work = mkdtempSync(join(tmpdir(), 'sb-codex-schema-'))
try {
  const env = { ...process.env, CODEX_HOME: join(work, 'home') }
  mkdirSync(env.CODEX_HOME)
  const version = execFileSync(codex, ['--version'], { env, encoding: 'utf8' }).trim()
  execFileSync(codex, ['app-server', 'generate-json-schema', '--out', join(work, 'schema')], { env, stdio: 'ignore' })
  const bundle = JSON.parse(readFileSync(join(work, 'schema', BUNDLE), 'utf8'))
  writeFileSync(out, JSON.stringify(extract(bundle, version), null, 2) + '\n')
  console.log(`wrote ${out} from ${version}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function lookup(bundle, ref) {
  const path = ref.replace(/^#\/definitions\//, '').split('/')
  let node = bundle.definitions
  for (const key of path) node = node?.[key]
  return node
}

function methodTable(bundle, union) {
  const table = new Map()
  for (const entry of bundle.definitions[union].oneOf) {
    table.set(entry.properties.method.enum[0], entry.properties.params?.$ref ?? null)
  }
  return table
}

function extract(bundle, version) {
  const missing = []
  const methods = {}
  const roots = []
  const unions = {
    clientRequests: 'ClientRequest',
    clientNotifications: 'ClientNotification',
    serverRequests: 'ServerRequest',
    serverNotifications: 'ServerNotification',
  }
  for (const [group, union] of Object.entries(unions)) {
    const table = methodTable(bundle, union)
    methods[group] = {}
    for (const method of USED[group]) {
      if (!table.has(method)) {
        missing.push(`${union} ${method}`)
        continue
      }
      const params = table.get(method)
      const entry = { params }
      if (group.endsWith('Requests')) {
        const response = RESPONSE_NAMES[method] ?? params?.replace(/Params$/, 'Response')
        if (!response || !lookup(bundle, response)) missing.push(`response of ${method} (${response})`)
        entry.response = response
      }
      methods[group][method] = entry
      for (const ref of Object.values(entry)) if (ref) roots.push(ref)
    }
  }
  if (missing.length) throw new Error(`${version} lacks: ${missing.join(', ')}`)

  // Every definition the roots reach, kept at its original path so refs resolve.
  const definitions = {}
  const seen = new Set()
  const visit = (ref) => {
    if (seen.has(ref)) return
    seen.add(ref)
    const node = lookup(bundle, ref)
    if (!node) throw new Error(`unresolved ${ref}`)
    const path = ref.replace(/^#\/definitions\//, '').split('/')
    let target = definitions
    for (const key of path.slice(0, -1)) target = target[key] ??= {}
    target[path.at(-1)] = node
    walk(node)
  }
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') visit(value)
        else walk(value)
      }
    }
  }
  roots.forEach(visit)
  return { codexVersion: version, generatedBy: 'scripts/codex-app-server-schema.mjs', methods, definitions }
}
