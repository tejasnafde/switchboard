/**
 * Thin vscode glue for the Switchboard bridge. All protocol logic lives in
 * protocol.js (pure, unit-tested from the main repo). The extension host is
 * Node 24, so the global WebSocket client is available - zero dependencies.
 *
 * Folder identity MUST come from vscode.workspace.workspaceFolders at runtime:
 * env is static across every extension host the server spawns, one per
 * connected webview.
 */
'use strict'
const vscode = require('vscode')
const { buildHello, buildSelection, parseMessage, backoffDelayMs } = require('./protocol')

let socket = null
let reconnectAttempt = 0
let reconnectTimer = null
let disposed = false

function log(msg) {
  console.log(`[sb-bridge] ${msg}`)
}

function workspaceFolder() {
  const folders = vscode.workspace.workspaceFolders
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null
}

async function handleOpen(msg) {
  try {
    const doc = await vscode.workspace.openTextDocument(msg.path)
    const editor = await vscode.window.showTextDocument(doc)
    if (msg.line !== undefined) {
      const start = Math.max(0, msg.line - 1)
      const end = Math.max(start, (msg.endLine !== undefined ? msg.endLine : msg.line) - 1)
      const range = new vscode.Range(start, 0, end, doc.lineAt(Math.min(end, doc.lineCount - 1)).text.length)
      editor.selection = new vscode.Selection(range.start, range.end)
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
    }
  } catch (err) {
    log(`open failed for ${msg.path}: ${err && err.message}`)
  }
}

async function handleConfig(msg) {
  const config = vscode.workspace.getConfiguration()
  for (const [key, value] of Object.entries(msg.settings)) {
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Global)
    } catch (err) {
      log(`config update failed for ${key}: ${err && err.message}`)
    }
  }
}

function connect() {
  const port = process.env.SB_BRIDGE_PORT
  const token = process.env.SB_BRIDGE_TOKEN
  const folder = workspaceFolder()
  if (!port || !token) {
    log('SB_BRIDGE_PORT/SB_BRIDGE_TOKEN missing - not spawned by Switchboard, staying idle')
    return
  }
  if (!folder) {
    log('no workspace folder open - staying idle')
    return
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
  socket = ws
  ws.addEventListener('open', () => {
    reconnectAttempt = 0
    ws.send(JSON.stringify(buildHello(folder)))
    log(`connected, hello sent for ${folder}`)
  })
  ws.addEventListener('message', (event) => {
    const msg = parseMessage(String(event.data))
    if (!msg) return
    if (msg.type === 'open') void handleOpen(msg)
    else if (msg.type === 'config') void handleConfig(msg)
  })
  ws.addEventListener('close', () => {
    socket = null
    if (disposed) return
    const delay = backoffDelayMs(reconnectAttempt++)
    log(`disconnected, reconnecting in ${delay}ms`)
    reconnectTimer = setTimeout(connect, delay)
  })
  ws.addEventListener('error', () => {
    // close fires after error; reconnect is scheduled there
  })
}

function sendSelection(intent) {
  const editor = vscode.window.activeTextEditor
  if (!editor || !socket || socket.readyState !== WebSocket.OPEN) return
  const sel = editor.selection
  const text = editor.document.getText(sel.isEmpty ? editor.document.lineAt(sel.active.line).range : sel)
  socket.send(
    JSON.stringify(
      buildSelection(editor.document.uri.fsPath, sel.start.line + 1, sel.end.line + 1, text, intent)
    )
  )
}

function requestSwitchboardTerminal() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'terminal' }))
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('switchboard.sendSelection', () => sendSelection()),
    vscode.commands.registerCommand('switchboard.quickEdit', () => sendSelection('edit')),
    vscode.commands.registerCommand('switchboard.openTerminal', requestSwitchboardTerminal),
    // Terminals live in Switchboard, not in the workbench - dispose any that
    // open and flip Switchboard's right pane to its terminal strip instead.
    vscode.window.onDidOpenTerminal((terminal) => {
      terminal.dispose()
      // Close the panel too: left open with zero terminals, the workbench
      // auto-creates a new one on next show - an intent loop.
      void vscode.commands.executeCommand('workbench.action.closePanel')
      requestSwitchboardTerminal()
    })
  )
  connect()
}

function deactivate() {
  disposed = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (socket) socket.close()
}

module.exports = { activate, deactivate }
