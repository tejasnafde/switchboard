import type { UserMessagePillsMeta } from './provider-events'

const TOKEN = /\[\[pill:([A-Za-z0-9_-]+)\]\]/g

function pillFor(pillsMeta: UserMessagePillsMeta | undefined, id: string) {
  return pillsMeta && Object.prototype.hasOwnProperty.call(pillsMeta, id) ? pillsMeta[id] : undefined
}

/**
 * A stored display body as plain text, for a surface that draws no chips:
 * each known `[[pill:id]]` becomes `[label]` and an unknown one is dropped,
 * the rule the desktop and Android chips follow.
 */
export function pillBodyText(body: string, pillsMeta: UserMessagePillsMeta | undefined): string {
  return body.replace(TOKEN, (_token, id: string) => {
    const pill = pillFor(pillsMeta, id)
    return pill ? `[${pill.label}]` : ''
  })
}

export type PillBodySegment = { kind: 'text'; text: string } | { kind: 'pill'; id: string; label: string }

/**
 * A stored display body split into text runs and chips, for a client that
 * draws each known `[[pill:id]]` as a chip. An unknown token is dropped and
 * the text around it joins into one run (Android `PillBodyPresenter.parse`).
 */
export function pillBodySegments(body: string, pillsMeta: UserMessagePillsMeta | undefined): PillBodySegment[] {
  const segments: PillBodySegment[] = []
  const appendText = (text: string): void => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last?.kind === 'text') last.text += text
    else segments.push({ kind: 'text', text })
  }
  let cursor = 0
  for (const match of body.matchAll(TOKEN)) {
    appendText(body.slice(cursor, match.index))
    const pill = pillFor(pillsMeta, match[1])
    if (pill) segments.push({ kind: 'pill', id: match[1], label: pill.label })
    cursor = match.index + match[0].length
  }
  appendText(body.slice(cursor))
  return segments
}
