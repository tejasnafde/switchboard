/** Text of the HTML preview's error console and its "Send to agent" draft. */

/** `ReferenceError: steps is not defined · :88`, first line of the message only. */
export function previewConsoleLine(message: string, line: number | undefined): string {
  const first = message.split('\n')[0].replace(/^Uncaught /, '')
  const text = first.length > 200 ? `${first.slice(0, 197)}...` : first
  return line && line > 0 ? `${text} · :${line}` : text
}

export function previewErrorsForAgent(path: string, errors: readonly string[]): string {
  return [`The preview of ${path} logged these errors:`, ...errors.map((e) => `- ${e}`)].join('\n')
}

/**
 * The URL a Content Security Policy console report names, or null when the
 * message is not one. The page's CSP stops most outside requests before the
 * session's request filter sees them, so these reports are how the pane
 * learns what was blocked. `duplicate` marks the second report Chromium logs
 * for one blocked fetch, which the pane drops.
 */
export function cspBlockedUrl(message: string): { url: string; duplicate: boolean } | null {
  if (!message.includes('Content Security Policy')) return null
  const quoted = message.match(/'([a-z][a-z0-9+.-]*:[^']+)'/i)
  if (quoted && /violates|Refused to/.test(message)) return { url: quoted[1], duplicate: false }
  const loaded = message.match(/cannot load (\S+?)\. /)
  if (loaded) return { url: loaded[1], duplicate: true }
  return null
}

/** "Send to agent" draft for requests an inline live page tried and the sandbox blocked. */
export function liveBlockedForAgent(name: string, labels: readonly string[]): string {
  return [
    `The live page "${name}" tried to load these, and the sandbox blocked them:`,
    ...labels.map((label) => `- ${label}`),
    'There is no network there: put the data inline, and load libraries only from /_sb/.',
  ].join('\n')
}
