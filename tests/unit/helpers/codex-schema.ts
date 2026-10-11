/**
 * Checks Codex app-server traffic against tests/fixtures/codex-app-server-schema.json
 * (regenerate with `node scripts/codex-app-server-schema.mjs`).
 *
 * ponytail: a validator for only the JSON Schema keywords that file uses
 * (CHECKED below); any other keyword throws, so a regenerated fixture that
 * needs more fails loudly instead of passing unchecked. Strict mode also refuses keys a schema does not
 * declare, which is how a renamed field we send shows up.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Schema = Record<string, unknown>
interface MethodEntry {
  params: string | null
  response?: string
}
interface Fixture {
  codexVersion: string
  methods: Record<
    'clientRequests' | 'clientNotifications' | 'serverRequests' | 'serverNotifications',
    Record<string, MethodEntry>
  >
  definitions: Schema
}

/** Server requests from older Codex builds that the adapter still answers. */
const LEGACY_SERVER_REQUESTS = new Set(['item/userInput/request', 'askUserQuestion'])

export const codexSchema: Fixture = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/codex-app-server-schema.json'), 'utf8'),
)

function resolveRef(ref: string): Schema {
  let node: unknown = codexSchema.definitions
  for (const key of ref.replace(/^#\/definitions\//, '').split('/')) node = (node as Schema | undefined)?.[key]
  if (!node) throw new Error(`unresolved ${ref}; regenerate the Codex schema fixture`)
  return node as Schema
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(declared: unknown, value: unknown): boolean {
  const actual = typeOf(value)
  const types = Array.isArray(declared) ? declared : [declared]
  return types.some((t) => t === actual || (t === 'number' && actual === 'integer'))
}

// Keywords that carry no constraint here (annotations, or bounds we do not check).
const IGNORED = new Set(['$schema', 'title', 'description', 'default', 'format', 'minimum', 'maximum', 'examples'])
const CHECKED = new Set([
  'minLength',
  'type',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  '$ref',
  'anyOf',
  'oneOf',
  'allOf',
])

/** Problems with `value` against `schema`, as `path: reason` strings. */
export function schemaProblems(schema: Schema | string, value: unknown, strict: boolean, path = '$'): string[] {
  const s = typeof schema === 'string' ? resolveRef(schema) : schema
  const unknown = Object.keys(s).filter((k) => !CHECKED.has(k) && !IGNORED.has(k))
  if (unknown.length)
    throw new Error(`schema keyword ${unknown.join(', ')} at ${path} is not checked; extend codex-schema.ts`)
  if (typeof s.$ref === 'string') return schemaProblems(s.$ref, value, strict, path)
  const problems: string[] = []
  if (s.type !== undefined && !typeMatches(s.type, value)) {
    return [`${path}: expected ${JSON.stringify(s.type)}, got ${typeOf(value)}`]
  }
  if (Array.isArray(s.enum) && !s.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} not in enum`]
  if (typeof s.minLength === 'number' && typeof value === 'string' && value.length < s.minLength) {
    return [`${path}: shorter than ${s.minLength}`]
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key] as Schema[] | undefined
    if (branches && !branches.some((b) => schemaProblems(b, value, strict, path).length === 0)) {
      problems.push(`${path}: matches no ${key} branch`)
    }
  }
  for (const branch of (s.allOf as Schema[] | undefined) ?? [])
    problems.push(...schemaProblems(branch, value, strict, path))
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>
    const properties = (s.properties as Record<string, Schema> | undefined) ?? {}
    for (const key of (s.required as string[] | undefined) ?? []) {
      if (!(key in record)) problems.push(`${path}.${key}: required`)
    }
    for (const [key, child] of Object.entries(record)) {
      if (properties[key]) problems.push(...schemaProblems(properties[key], child, strict, `${path}.${key}`))
      else if (typeof s.additionalProperties === 'object') {
        problems.push(...schemaProblems(s.additionalProperties as Schema, child, strict, `${path}.${key}`))
      } else if (s.additionalProperties === false || (strict && s.properties && s.additionalProperties !== true)) {
        problems.push(`${path}.${key}: not in the schema`)
      }
    }
  }
  if (Array.isArray(value) && s.items) {
    value.forEach((item, i) => problems.push(...schemaProblems(s.items as Schema, item, strict, `${path}[${i}]`)))
  }
  return problems
}

/**
 * Whether `path` (dot separated, `[]` for an array element, `name(tag)` for
 * the union branch whose `type` is `tag`) names a property the schema
 * declares. For the fields our code reads.
 */
export function schemaHasPath(ref: string, path: string): boolean {
  let nodes: Schema[] = [resolveRef(ref)]
  for (const raw of path.split('.')) {
    const match = /^([^([]+)(?:\(([^)]+)\))?(\[\])?$/.exec(raw)
    if (!match) throw new Error(`bad path segment ${raw}`)
    const [, key, tag, isArray] = match
    let next = nodes.flatMap(expand).flatMap((n) => {
      const child = (n.properties as Record<string, Schema> | undefined)?.[key]
      return child ? [child] : []
    })
    if (tag) next = next.flatMap(expand).filter((n) => branchTag(n) === tag)
    if (isArray) next = next.flatMap(expand).flatMap((n) => (n.items ? [n.items as Schema] : []))
    if (next.length === 0) return false
    nodes = next
  }
  return true
}

function expand(node: Schema): Schema[] {
  if (typeof node.$ref === 'string') return expand(resolveRef(node.$ref))
  const branches = [node.anyOf, node.oneOf, node.allOf].flatMap((b) => (Array.isArray(b) ? b : [])) as Schema[]
  return [node, ...branches.flatMap(expand)]
}

function branchTag(node: Schema): string | undefined {
  const tag = (node.properties as Record<string, Schema> | undefined)?.type?.enum
  return Array.isArray(tag) && tag.length === 1 ? String(tag[0]) : undefined
}

/**
 * Problems with what a client wrote to a Codex app-server: requests and
 * notifications by method, and answers to server requests by the method of
 * the request they answer. `fromServer` is what the fake server sent.
 */
export function clientTrafficProblems(written: unknown[], fromServer: unknown[]): string[] {
  const serverRequestMethods = new Map<unknown, string>()
  for (const message of fromServer as Array<Record<string, unknown>>) {
    if (message?.method && message.id !== undefined) serverRequestMethods.set(message.id, String(message.method))
  }
  const { clientRequests, clientNotifications, serverRequests } = codexSchema.methods
  const problems: string[] = []
  for (const message of written as Array<Record<string, unknown>>) {
    const method = typeof message.method === 'string' ? message.method : null
    if (method) {
      const table = message.id === undefined ? clientNotifications : clientRequests
      const entry = table[method]
      if (!entry)
        problems.push(`${method}: not in the Codex schema fixture (add it to scripts/codex-app-server-schema.mjs)`)
      else if (entry.params) {
        problems.push(...schemaProblems(entry.params, message.params, true).map((p) => `${method} params ${p}`))
      } else if (message.params !== undefined) problems.push(`${method}: the schema takes no params`)
      continue
    }
    if (!('result' in message)) continue
    const answered = serverRequestMethods.get(message.id)
    const response = answered ? serverRequests[answered]?.response : undefined
    if (!answered || LEGACY_SERVER_REQUESTS.has(answered)) continue
    if (!response) {
      problems.push(`answer to ${answered}: not in the Codex schema fixture`)
      continue
    }
    problems.push(...schemaProblems(response, message.result, true).map((p) => `answer to ${answered} ${p}`))
  }
  return problems
}
