/**
 * Masks a saved secret where it shows up in what Switchboard shows, stores or
 * sends on (design section 9). While a secret file is live, its value is held
 * here as `Buffer`s, one set per chat (keyed by the root conversation id),
 * and zero-filled when the file is deleted, expires, or its chat is archived.
 *
 * Each value is matched as its exact bytes, its base64 form (padded and
 * not) and its base64url form, and as its characters where each one may be
 * written as itself or escaped: a percent escape of its UTF-8 bytes in any
 * case (so every URL and form encoder, `+` for a space included), a
 * backslash escape (JSON, a shell double-quoted string), a JSON `\uXXXX`, or
 * for a `'` the shell's `'\''` and `'"'"'`. A match is replaced with
 * `[secret NAME]`. Values under
 * `SECRET_MATCH_MIN_CHARS` characters are not matched: they hit too often.
 * Masking changes only our copies: the model saw the value, and the
 * provider's own transcript still holds it.
 */

export const SECRET_MATCH_MIN_CHARS = 8

export function secretMask(name: string): string {
  return `[secret ${name}]`
}

interface Armed {
  name: string
  /** Longest first, so a form that contains another wins. */
  patterns: Buffer[]
  /** The value's code points, for the escaped forms (`matchEscaped`). */
  codePoints: Uint32Array
}

function forms(value: Buffer): Buffer[] {
  const base64 = value.toString('base64')
  const url = encodeURIComponent(value.toString('utf8'))
  const found = [
    Buffer.from(value),
    Buffer.from(base64, 'latin1'),
    Buffer.from(base64.replace(/=+$/, ''), 'latin1'),
    Buffer.from(value.toString('base64url'), 'latin1'),
    Buffer.from(url, 'latin1'),
    Buffer.from(
      url.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
      'latin1',
    ),
  ]
  const unique: Buffer[] = []
  for (const form of found) {
    if (unique.some((u) => u.equals(form))) form.fill(0)
    else unique.push(form)
  }
  return unique.sort((a, b) => b.length - a.length)
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
const hex4 = (n: number) => n.toString(16).padStart(4, '0')
const JSON_SHORT: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' }

/** ASCII that is not a letter or digit: the characters a backslash may escape. */
function isAsciiPunct(cp: number): boolean {
  return cp >= 0x20 && cp < 0x7f && !/[0-9A-Za-z]/.test(String.fromCharCode(cp))
}

/** The ways one character can be written. `fold`: compare without case (hex digits). */
function spellings(cp: number): Array<{ text: string; fold: boolean }> {
  const char = String.fromCodePoint(cp)
  const out = [{ text: char, fold: false }]
  let percent = ''
  for (const byte of Buffer.from(char, 'utf8')) percent += `%${hex2(byte)}`
  out.push({ text: percent, fold: true })
  if (cp === 0x20) out.push({ text: '+', fold: false })
  if (isAsciiPunct(cp)) out.push({ text: `\\${char}`, fold: false })
  if (JSON_SHORT[cp]) out.push({ text: JSON_SHORT[cp], fold: false })
  let unicode = ''
  for (let i = 0; i < char.length; i++) unicode += `\\u${hex4(char.charCodeAt(i))}`
  out.push({ text: unicode, fold: true })
  if (cp === 0x27) out.push({ text: `'\\''`, fold: false }, { text: `'"'"'`, fold: false })
  return out
}

/** 1: `spelling` is at `pos`. 0: it is not. -1: the text ends partway through a match. */
function spelledAt(text: string, pos: number, spelling: { text: string; fold: boolean }): 1 | 0 | -1 {
  for (let i = 0; i < spelling.text.length; i++) {
    if (pos + i >= text.length) return -1
    const a = text[pos + i]
    const b = spelling.text[i]
    if (a !== b && !(spelling.fold && a.toLowerCase() === b.toLowerCase())) return 0
  }
  return 1
}

/**
 * Match the value's characters, each in any spelling, from `start`. Every
 * reachable position is followed (an escape can be a prefix of another
 * spelling), so no input backtracks. `end`: the longest match, or -1.
 * `partial`: the text ended while a match was still possible.
 */
function matchEscaped(text: string, start: number, codePoints: Uint32Array): { end: number; partial: boolean } {
  let at = [start]
  let partial = false
  for (const cp of codePoints) {
    const next = new Set<number>()
    const ways = spellings(cp)
    for (const pos of at) {
      for (const way of ways) {
        const found = spelledAt(text, pos, way)
        if (found === 1) next.add(pos + way.text.length)
        else if (found === -1) partial = true
      }
    }
    if (next.size === 0) return { end: -1, partial }
    at = [...next]
  }
  return { end: Math.max(...at), partial }
}

/** The first UTF-16 unit of every spelling of the first character: where a match can start. */
function firstUnits(codePoints: Uint32Array): Set<string> {
  return new Set(spellings(codePoints[0]).map((way) => way.text[0]))
}

/** Longest any spelling of the value can be, in UTF-16 units. */
function longestSpelling(codePoints: Uint32Array): number {
  let total = 0
  for (const cp of codePoints) total += Math.max(...spellings(cp).map((way) => way.text.length))
  return total
}

/**
 * The chats whose secrets apply: a root conversation id, or a list of them (a
 * fork matches its own secrets and those of the chats it was forked from).
 */
export type SecretScope = string | readonly string[]

const scopeRoots = (scope: SecretScope): readonly string[] => (typeof scope === 'string' ? [scope] : scope)

export class SecretRedactor {
  /** Root conversation id to its armed secrets, by secret id. */
  private readonly chats = new Map<string, Map<string, Armed>>()
  private readonly rootOf = new Map<string, string>()

  /**
   * Hold a saved value for `rootThreadId`. Copies it, so the caller may
   * zero-fill its own buffer. False when it is too short to be matched.
   */
  add(rootThreadId: string, secretId: string, name: string, value: Buffer): boolean {
    this.drop(secretId)
    if ([...value.toString('utf8')].length < SECRET_MATCH_MIN_CHARS) return false
    let chat = this.chats.get(rootThreadId)
    if (!chat) {
      chat = new Map()
      this.chats.set(rootThreadId, chat)
    }
    const codePoints = Uint32Array.from(value.toString('utf8'), (char) => char.codePointAt(0) ?? 0)
    chat.set(secretId, { name, patterns: forms(value), codePoints })
    this.rootOf.set(secretId, rootThreadId)
    return true
  }

  has(secretId: string): boolean {
    return this.rootOf.has(secretId)
  }

  /** The file is gone: zero-fill and forget its value. */
  drop(secretId: string): void {
    const root = this.rootOf.get(secretId)
    if (root === undefined) return
    this.rootOf.delete(secretId)
    const chat = this.chats.get(root)
    const armed = chat?.get(secretId)
    for (const pattern of armed?.patterns ?? []) pattern.fill(0)
    armed?.codePoints.fill(0)
    chat?.delete(secretId)
    if (chat?.size === 0) this.chats.delete(root)
  }

  dropChat(rootThreadId: string): void {
    for (const secretId of [...(this.chats.get(rootThreadId)?.keys() ?? [])]) this.drop(secretId)
  }

  clear(): void {
    for (const secretId of [...this.rootOf.keys()]) this.drop(secretId)
  }

  /** Any chat holds a value. Lets hot paths skip the root lookup. */
  any(): boolean {
    return this.chats.size > 0
  }

  armed(scope: SecretScope): boolean {
    return scopeRoots(scope).some((root) => this.chats.has(root))
  }

  /** Length of the scope's longest pattern or escaped spelling, 0 when none. */
  private longest(scope: SecretScope): number {
    let max = 0
    for (const armed of this.armedIn(scope)) {
      for (const pattern of armed.patterns) max = Math.max(max, pattern.length)
      max = Math.max(max, longestSpelling(armed.codePoints))
    }
    return max
  }

  /**
   * Where a stream should start holding `text` back: the first index from
   * which the rest could still grow into a match, or `text.length` when none
   * can. Text before it can be sent, since no match can span the cut.
   */
  holdFrom(scope: SecretScope, text: string): number {
    const armed = this.armedIn(scope)
    if (armed.length === 0 || text.length === 0) return text.length
    let tailStart = Math.max(0, text.length - this.longest(scope))
    const low = text.charCodeAt(tailStart)
    if (tailStart > 0 && low >= 0xdc00 && low <= 0xdfff) tailStart--
    const tail = text.slice(tailStart)
    const bytes = Buffer.from(tail, 'utf8')
    let hold = tail.length
    for (const { patterns, codePoints } of armed) {
      for (const pattern of patterns) {
        for (let k = Math.min(pattern.length - 1, bytes.length); k > 0; k--) {
          const at = bytes.length - k
          if (bytes[at] !== pattern[0]) continue
          if (bytes.subarray(at).equals(pattern.subarray(0, k))) {
            hold = Math.min(hold, bytes.subarray(0, at).toString('utf8').length)
            break
          }
        }
      }
      const starts = firstUnits(codePoints)
      for (let at = 0; at < hold; at++) {
        if (starts.has(tail[at]) && matchEscaped(tail, at, codePoints).partial) {
          hold = at
          break
        }
      }
    }
    return tailStart + hold
  }

  private armedIn(scope: SecretScope): Armed[] {
    return scopeRoots(scope).flatMap((root) => [...(this.chats.get(root)?.values() ?? [])])
  }

  /** `text` with every match masked, or null when nothing matched. */
  redactText(scope: SecretScope, text: string): string | null {
    const armed = this.armedIn(scope)
    if (armed.length === 0 || text.length === 0) return null
    const bytes = Buffer.from(text, 'utf8')
    const hits: Array<{ start: number; end: number; name: string }> = []
    for (const { name, patterns, codePoints } of armed) {
      for (const pattern of patterns) {
        for (let at = bytes.indexOf(pattern); at !== -1; at = bytes.indexOf(pattern, at + pattern.length))
          hits.push({ start: at, end: at + pattern.length, name })
      }
      const starts = firstUnits(codePoints)
      for (let at = 0; at < text.length; at++) {
        if (!starts.has(text[at])) continue
        const { end } = matchEscaped(text, at, codePoints)
        if (end === -1) continue
        const start = Buffer.byteLength(text.slice(0, at), 'utf8')
        hits.push({ start, end: start + Buffer.byteLength(text.slice(at, end), 'utf8'), name })
        at = end - 1
      }
    }
    if (hits.length === 0) return null
    hits.sort((a, b) => a.start - b.start || b.end - a.end)
    // UTF-8 is self-synchronising and every pattern is whole characters, so
    // a cut at a match edge never splits a character.
    const parts: Buffer[] = []
    let from = 0
    for (const hit of hits) {
      // An overlapping hit (two values that share bytes) widens the mask
      // already placed, so no tail of the later value is left in the clear.
      if (hit.start < from) {
        from = Math.max(from, hit.end)
        continue
      }
      parts.push(bytes.subarray(from, hit.start), Buffer.from(secretMask(hit.name), 'utf8'))
      from = hit.end
    }
    parts.push(bytes.subarray(from))
    return Buffer.concat(parts).toString('utf8')
  }

  /** `text` with the live secrets of every chat masked, or null: for logs, which belong to no chat. */
  redactAnyText(text: string): string | null {
    return this.redactText([...this.chats.keys()], text)
  }

  /** `holdFrom` over the live secrets of every chat. */
  holdFromAny(text: string): number {
    return this.holdFrom([...this.chats.keys()], text)
  }

  /**
   * Every string inside `value` (plain objects and arrays), object keys too,
   * masked. Returns the same object when nothing matched, and copies only the
   * changed path. Two keys that mask to the same text both stay.
   */
  redactDeep<T>(scope: SecretScope, value: T): { value: T; hit: boolean } {
    if (!this.armed(scope)) return { value, hit: false }
    let hit = false
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const masked = this.redactText(scope, v)
        if (masked === null) return v
        hit = true
        return masked
      }
      if (Array.isArray(v)) {
        let changed = false
        const out = v.map((item) => {
          const next = walk(item)
          if (next !== item) changed = true
          return next
        })
        return changed ? out : v
      }
      if (v && typeof v === 'object') {
        const proto = Object.getPrototypeOf(v)
        if (proto !== Object.prototype && proto !== null) return v
        const entries = Object.entries(v)
        let changed = false
        const next = entries.map(([key, item]): [string, unknown] => {
          const maskedKey = this.redactText(scope, key)
          const nextItem = walk(item)
          if (maskedKey !== null) hit = true
          if (maskedKey !== null || nextItem !== item) changed = true
          return [maskedKey ?? key, nextItem]
        })
        if (!changed) return v
        const out: Record<string, unknown> = {}
        for (const [key, item] of next) {
          let unique = key
          for (let n = 2; Object.hasOwn(out, unique); n++) unique = `${key} (${n})`
          // Not `out[unique] =`: a `__proto__` key would set the prototype.
          Object.defineProperty(out, unique, { value: item, enumerable: true, writable: true, configurable: true })
        }
        return out
      }
      return v
    }
    const out = walk(value) as T
    return { value: out, hit }
  }
}

/** The backend's one matcher: the secret store arms it, every output path reads it. */
export const secretRedactor = new SecretRedactor()
