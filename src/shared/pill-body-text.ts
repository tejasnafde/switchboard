import type { UserMessagePillsMeta } from './provider-events'

const TOKEN = /\[\[pill:([A-Za-z0-9_-]+)\]\]/g

/**
 * A stored display body as plain text, for a client that draws no chips (the
 * React Native app): each known `[[pill:id]]` becomes `[label]` and an unknown
 * one is dropped, the rule the desktop and Android chips follow.
 */
export function pillBodyText(body: string, pillsMeta: UserMessagePillsMeta | undefined): string {
  return body.replace(TOKEN, (_token, id: string) => {
    const pill = pillsMeta && Object.prototype.hasOwnProperty.call(pillsMeta, id) ? pillsMeta[id] : undefined
    return pill ? `[${pill.label}]` : ''
  })
}
