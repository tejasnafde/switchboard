/**
 * Agent digest: a one-line status the agent reports mid-reply, wrapped in
 * <agent_digest>...</agent_digest>. The sidebar session list and the kanban
 * card preview show this line instead of a raw, mid-sentence cut of the
 * assistant's prose (e.g. "I'll start by looking at the existing cost
 * tracking code in src/main...").
 *
 * The raw message text is stored unchanged (see docs/feature-parity/
 * agent-digest.json) - these two functions only run at render time:
 * `extractDigest` pulls the status line out for previews, `stripDigest`
 * removes the tag(s) from the text shown in the chat transcript itself.
 *
 * Both are pure and provider-agnostic so the same logic drives the Claude
 * and Codex prompts' expectations and every surface that renders the text
 * (desktop renderer, mobile, and - ported to Kotlin - native Android).
 */

const OPEN_TAG = '<agent_digest>'
const CLOSE_TAG = '</agent_digest>'
const MAX_DIGEST_LENGTH = 120

/** Fresh instance per call - a shared module-level `RegExp` with the `g`
 * flag would be safe for `.replace`/`.matchAll` alone (both reset
 * `lastIndex`), but a fresh instance removes any doubt when this module is
 * used from multiple call sites without deliberately reasoning about it. */
function digestTagPattern(): RegExp {
  return /<agent_digest>([\s\S]*?)<\/agent_digest>/g
}

/**
 * Returns the LAST complete `<agent_digest>...</agent_digest>` in `text`,
 * trimmed and capped at ~120 chars. `undefined` when no complete tag with
 * non-empty content is present (an in-progress, unclosed tag never counts -
 * its content is not final yet).
 */
export function extractDigest(text: string): string | undefined {
  if (!text) return undefined
  let last: string | undefined
  for (const match of text.matchAll(digestTagPattern())) {
    const inner = match[1].trim()
    if (inner) last = inner
  }
  if (last === undefined) return undefined
  return last.length > MAX_DIGEST_LENGTH
    ? `${last.slice(0, MAX_DIGEST_LENGTH - 1)}…`
    : last
}

/**
 * Longest suffix of `text` that is also a non-empty prefix of `OPEN_TAG`,
 * e.g. "hello <agent_di" -> "<agent_di" (length 9). Used to hide a tag
 * while it is still streaming in, character by character.
 */
function trailingPartialOpenTagLength(text: string): number {
  const maxLen = Math.min(text.length, OPEN_TAG.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (text.endsWith(OPEN_TAG.slice(0, len))) return len
  }
  return 0
}

/**
 * Removes every complete `<agent_digest>...</agent_digest>` tag from
 * `text`. Also hides a trailing PARTIAL tag so it never flashes on screen
 * mid-stream: an unclosed `<agent_digest>...` (with or without a partial
 * `</agent_dig` close in progress), or a bare prefix of the open tag itself
 * such as `<agent_di`.
 *
 * Known tradeoff: a message whose final character happens to be a lone `<`
 * (or another short prefix of the open tag) that is genuinely part of the
 * message, not a digest tag, is trimmed too. This only affects the last
 * few characters of a full message and is the standard cost of streaming-
 * safe tag hiding.
 */
export function stripDigest(text: string): string {
  if (!text) return text
  const withoutComplete = text.replace(digestTagPattern(), '')
  const openIdx = withoutComplete.indexOf(OPEN_TAG)
  if (openIdx !== -1) {
    // An open tag with no matching close anywhere after it - the rest of
    // the text (body plus any partial close tag) is still streaming in.
    return withoutComplete.slice(0, openIdx)
  }
  const partialLen = trailingPartialOpenTagLength(withoutComplete)
  return partialLen > 0 ? withoutComplete.slice(0, withoutComplete.length - partialLen) : withoutComplete
}

/**
 * The prompt rule appended for providers with a clean instructions seam
 * (Claude Code SDK `systemPrompt`, Codex app-server `developerInstructions`
 * - see claude-adapter.ts and codex-adapter.ts). OpenCode's ACP has no such
 * seam (`NewSessionRequest` carries only `cwd`/`mcpServers`/
 * `additionalDirectories`), so it does not receive this rule - see
 * docs/feature-parity/agent-digest.json.
 */
export const AGENT_DIGEST_PROMPT_RULE =
  'Report your progress with a one-line status update wrapped in ' +
  '<agent_digest></agent_digest> tags: what you are doing right now, or the ' +
  'result when you are done. Emit one when you start a substantial step, and ' +
  'again at the end of your reply. Keep it under 120 characters, one line, no ' +
  'markdown. Example: <agent_digest>Writing cost-per-model table, 2 of 4 ' +
  'providers done</agent_digest>. This tag is stripped before your reply is ' +
  'shown to the user, so it never appears in the chat itself - it only drives ' +
  'status previews elsewhere in the app.'
