/**
 * Pure half of the sb-bridge extension: message build/parse/validate and the
 * reconnect backoff schedule. CommonJS - the VS Code extension host
 * require()s it, and vitest imports it directly. No dependencies, no vscode.
 *
 * Wire format (JSON, one object per WebSocket frame):
 *   ext -> main  {type:'hello', folder}
 *   main -> ext  {type:'open', path, line?, endLine?}
 *   main -> ext  {type:'config', settings}  - live vscode settings to apply
 *   ext -> main  {type:'selection', path, startLine, endLine, text, intent?}
 *                intent 'edit' opens the quick-edit prompt instead of a draft pill
 *   ext -> main  {type:'terminal'} - user wants a terminal; Switchboard's pane opens
 */
'use strict'

function buildHello(folder) {
  return { type: 'hello', folder }
}

function buildSelection(path, startLine, endLine, text, intent) {
  const msg = { type: 'selection', path, startLine, endLine, text }
  if (intent) msg.intent = intent
  return msg
}

const isStr = (v) => typeof v === 'string' && v.length > 0
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** Per-type required/optional field validators. Unknown types are rejected. */
const isSettingsObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const VALIDATORS = {
  hello: (m) => isStr(m.folder),
  terminal: () => true,
  config: (m) => isSettingsObj(m.settings),
  open: (m) => isStr(m.path) && (m.line === undefined || isNum(m.line)) && (m.endLine === undefined || isNum(m.endLine)),
  selection: (m) =>
    isStr(m.path) && isNum(m.startLine) && isNum(m.endLine) && typeof m.text === 'string' &&
    (m.intent === undefined || m.intent === 'edit'),
}

/** Parse one frame. Returns the message object, or null on anything malformed. */
function parseMessage(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null
  const validate = VALIDATORS[msg.type]
  if (!validate || !validate(msg)) return null
  return msg
}

const BACKOFF_BASE_MS = 500
const BACKOFF_CAP_MS = 15000

/** Reconnect delay for the given attempt number (0-based): 500ms doubling to a 15s cap. */
function backoffDelayMs(attempt) {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
}

module.exports = { buildHello, buildSelection, parseMessage, backoffDelayMs }
