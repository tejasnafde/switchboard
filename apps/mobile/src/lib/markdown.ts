/**
 * A small Markdown parser for the chat feed.
 *
 * Agent replies are Markdown, and the app was rendering them as raw text -
 * literal `**bold**`, `###` headings, and fenced code blocks shown with their
 * backticks. This produces a flat block list that React Native can render with
 * plain <Text>/<View>, which is all the feed needs.
 *
 * Deliberately NOT a full CommonMark implementation, and no dependency: the
 * input is agent chat output, not arbitrary documents. Supported: fenced code,
 * ATX headings, bullet and ordered lists (nested), block quotes, horizontal
 * rules, tables-as-code, paragraphs; inline code, bold, italic, strikethrough
 * and links. Anything unrecognised falls through as text, which is the correct
 * failure mode for a chat bubble.
 *
 * Pure and unit-tested; the renderer stays dumb.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block =
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'listItem'; ordered: boolean; marker: string; depth: number; inlines: Inline[] }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'rule' }

// ── inline ──────────────────────────────────────────────────────────────────

/**
 * Ordered by precedence. Code spans come first so `**` inside backticks stays
 * literal, which matters constantly in agent output ("run `npm i -D **`").
 */
const INLINE_PATTERNS: Array<{
  re: RegExp
  build: (m: RegExpExecArray, recurse: (s: string) => Inline[]) => Inline
}> = [
  { re: /^`+([^`]+?)`+/, build: (m) => ({ kind: 'code', text: m[1] }) },
  {
    re: /^\[([^\]]*)\]\(([^)\s]+)[^)]*\)/,
    build: (m, recurse) => ({ kind: 'link', href: m[2], children: recurse(m[1]) }),
  },
  //
  // Emphasis runs must begin AND end on a non-space character - CommonMark's
  // flanking rule. Without it `2 * 3 * 4` parses as italics and the asterisks
  // disappear, turning arithmetic into "2  3  4".
  { re: /^\*\*\*(\S|\S[^*]*?\S)\*\*\*/, build: (m, r) => ({ kind: 'strong', children: [{ kind: 'em', children: r(m[1]) }] }) },
  { re: /^\*\*(\S|\S[\s\S]*?\S)\*\*/, build: (m, r) => ({ kind: 'strong', children: r(m[1]) }) },
  { re: /^__(\S|\S[\s\S]*?\S)__/, build: (m, r) => ({ kind: 'strong', children: r(m[1]) }) },
  { re: /^~~(\S|\S[\s\S]*?\S)~~/, build: (m, r) => ({ kind: 'strike', children: r(m[1]) }) },
  { re: /^\*(\S|\S[^*\n]*?\S)\*/, build: (m, r) => ({ kind: 'em', children: r(m[1]) }) },
  // Underscore emphasis only at a word boundary, or snake_case_names break up.
  { re: /^_(\S|\S[^_\n]*?\S)_(?![A-Za-z0-9])/, build: (m, r) => ({ kind: 'em', children: r(m[1]) }) },
  { re: /^(https?:\/\/[^\s<>()]+)/, build: (m) => ({ kind: 'link', href: m[1], children: [{ kind: 'text', text: m[1] }] }) },
]

/** Merge adjacent text runs so the renderer emits fewer nodes. */
function coalesce(inlines: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const node of inlines) {
    const prev = out[out.length - 1]
    if (node.kind === 'text' && prev?.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: prev.text + node.text }
      continue
    }
    out.push(node)
  }
  return out
}

export function parseInline(src: string, depth = 0): Inline[] {
  if (src.length === 0) return []
  // Emphasis can nest; a hard cap keeps a pathological input from recursing far.
  if (depth > 4) return [{ kind: 'text', text: src }]

  const out: Inline[] = []
  let rest = src
  let guard = 0

  while (rest.length > 0 && guard++ < 5000) {
    let matched = false
    for (const { re, build } of INLINE_PATTERNS) {
      const m = re.exec(rest)
      if (m === null) continue
      out.push(build(m, (s) => parseInline(s, depth + 1)))
      rest = rest.slice(m[0].length)
      matched = true
      break
    }
    if (matched) continue
    // No pattern at this position: take one char as text and advance. Slower
    // than scanning to the next marker but never loops.
    out.push({ kind: 'text', text: rest[0] })
    rest = rest.slice(1)
  }

  return coalesce(out)
}

// ── blocks ──────────────────────────────────────────────────────────────────

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []

  const flushParagraph = (): void => {
    if (para.length === 0) return
    blocks.push({ kind: 'paragraph', inlines: parseInline(para.join('\n').trim()) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence !== null) {
      flushParagraph()
      const marker = fence[1][0]
      const body: string[] = []
      i++
      // An unterminated fence runs to the end of the message, which is the
      // normal case while a code block is still streaming in.
      for (; i < lines.length; i++) {
        const close = FENCE.exec(lines[i])
        if (close !== null && close[1][0] === marker) break
        body.push(lines[i])
      }
      blocks.push({ kind: 'code', lang: fence[2] === '' ? null : fence[2], text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      continue
    }

    if (RULE.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInline(heading[2].trim()) })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      flushParagraph()
      // Fold consecutive quote lines into one block.
      const parts = [quote[1]]
      while (i + 1 < lines.length) {
        const next = QUOTE.exec(lines[i + 1])
        if (next === null) break
        parts.push(next[1])
        i++
      }
      blocks.push({ kind: 'quote', inlines: parseInline(parts.join('\n').trim()) })
      continue
    }

    const ordered = ORDERED.exec(line)
    if (ordered !== null) {
      flushParagraph()
      blocks.push({
        kind: 'listItem',
        ordered: true,
        marker: `${ordered[2]}.`,
        depth: Math.floor(ordered[1].length / 2),
        inlines: parseInline(ordered[3]),
      })
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet !== null) {
      flushParagraph()
      blocks.push({
        kind: 'listItem',
        ordered: false,
        marker: '•',
        depth: Math.floor(bullet[1].length / 2),
        inlines: parseInline(bullet[2]),
      })
      continue
    }

    para.push(line)
  }

  flushParagraph()
  return blocks
}

/** Plain-text projection. Used for previews and for accessibility labels. */
export function inlinesToText(inlines: Inline[]): string {
  return inlines
    .map((n) => {
      switch (n.kind) {
        case 'text':
        case 'code':
          return n.text
        default:
          return inlinesToText(n.children)
      }
    })
    .join('')
}
