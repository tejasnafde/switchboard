/**
 * Masks a saved secret where it shows up in what Switchboard shows, stores or
 * sends on (design section 9). While a secret file is live, its value is held
 * here as `Buffer`s, one set per chat (keyed by the root conversation id),
 * and zero-filled when the file is deleted, expires, or its chat is archived.
 *
 * Each value is matched as its exact bytes, its base64 (and base64url) form
 * and its URL-encoded form, and replaced with `[secret NAME]`. Values under
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
}

function forms(value: Buffer): Buffer[] {
  const text = value.toString('utf8')
  const found = [
    Buffer.from(value),
    Buffer.from(value.toString('base64').replace(/=+$/, ''), 'latin1'),
    Buffer.from(value.toString('base64url'), 'latin1'),
    Buffer.from(encodeURIComponent(text), 'latin1'),
  ]
  const unique: Buffer[] = []
  for (const form of found) {
    if (unique.some((u) => u.equals(form))) form.fill(0)
    else unique.push(form)
  }
  return unique.sort((a, b) => b.length - a.length)
}

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
    chat.set(secretId, { name, patterns: forms(value) })
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

  armed(rootThreadId: string): boolean {
    return this.chats.has(rootThreadId)
  }

  /** Bytes in the chat's longest pattern, 0 when none: the stream carry holds one less. */
  longest(rootThreadId: string): number {
    let max = 0
    for (const armed of this.chats.get(rootThreadId)?.values() ?? [])
      for (const pattern of armed.patterns) max = Math.max(max, pattern.length)
    return max
  }

  /** `text` with every match masked, or null when nothing matched. */
  redactText(rootThreadId: string, text: string): string | null {
    const chat = this.chats.get(rootThreadId)
    if (!chat || text.length === 0) return null
    const bytes = Buffer.from(text, 'utf8')
    const hits: Array<{ start: number; end: number; name: string }> = []
    for (const { name, patterns } of chat.values()) {
      for (const pattern of patterns) {
        for (let at = bytes.indexOf(pattern); at !== -1; at = bytes.indexOf(pattern, at + pattern.length))
          hits.push({ start: at, end: at + pattern.length, name })
      }
    }
    if (hits.length === 0) return null
    hits.sort((a, b) => a.start - b.start || b.end - a.end)
    // UTF-8 is self-synchronising and every pattern is whole characters, so
    // a cut at a match edge never splits a character.
    const parts: Buffer[] = []
    let from = 0
    for (const hit of hits) {
      if (hit.start < from) continue
      parts.push(bytes.subarray(from, hit.start), Buffer.from(secretMask(hit.name), 'utf8'))
      from = hit.end
    }
    parts.push(bytes.subarray(from))
    return Buffer.concat(parts).toString('utf8')
  }

  /**
   * Every string inside `value` (plain objects and arrays) masked. Returns the
   * same object when nothing matched, and copies only the changed path.
   */
  redactDeep<T>(rootThreadId: string, value: T): { value: T; hit: boolean } {
    if (!this.chats.has(rootThreadId)) return { value, hit: false }
    let hit = false
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const masked = this.redactText(rootThreadId, v)
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
        let out: Record<string, unknown> | null = null
        for (const [key, item] of Object.entries(v)) {
          const next = walk(item)
          if (next !== item) (out ??= { ...(v as Record<string, unknown>) })[key] = next
        }
        return out ?? v
      }
      return v
    }
    const out = walk(value) as T
    return { value: out, hit }
  }
}

/** The backend's one matcher: the secret store arms it, every output path reads it. */
export const secretRedactor = new SecretRedactor()
