/**
 * The process each agent spawns as its `switchboard` MCP server.
 *
 * It is a pipe, nothing more: it connects to the backend's loopback listener,
 * sends the chat's token as its first line, then copies stdin to the socket
 * and the socket to stdout. The MCP protocol, the tools and every decision
 * live in the backend, where the chat, its runtime mode and the approval card
 * are.
 *
 * Kept as source and written to disk at startup rather than bundled as a
 * second build output: it then runs the same from the Electron app, the
 * headless server and a provisioned remote VM, with nothing to package or
 * upload. It needs only Node's `fs` and `net`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MCP_PORT_ENV = 'SWITCHBOARD_MCP_PORT'
/**
 * A path, not the token. Agents put their MCP servers' env on a command line
 * (Codex's `-c`, Claude's `--mcp-config`), where any local user can read it
 * with `ps`; the file is readable by this user only.
 */
export const MCP_TOKEN_FILE_ENV = 'SWITCHBOARD_MCP_TOKEN_FILE'
export const MCP_AUTH_KEY = 'switchboardMcpAuth'

export const STDIO_BRIDGE_SOURCE = `'use strict'
// Switchboard MCP stdio bridge. Written by Switchboard at startup; edits are overwritten.
const fs = require('fs')
const net = require('net')
const port = Number(process.env.${MCP_PORT_ENV})
let token = ''
try {
  token = fs.readFileSync(process.env.${MCP_TOKEN_FILE_ENV} || '', 'utf8').trim()
} catch (err) {
  process.stderr.write('switchboard-mcp: cannot read ${MCP_TOKEN_FILE_ENV}: ' + err.message + '\\n')
}
if (!Number.isInteger(port) || port <= 0 || !token) {
  process.stderr.write('switchboard-mcp: ${MCP_PORT_ENV} and a readable ${MCP_TOKEN_FILE_ENV} are required\\n')
  process.exit(2)
}
const socket = net.connect({ host: '127.0.0.1', port })
socket.setNoDelay(true)
socket.on('connect', () => {
  socket.write(JSON.stringify({ ${MCP_AUTH_KEY}: token }) + '\\n')
  process.stdin.pipe(socket)
})
socket.pipe(process.stdout)
socket.on('error', (err) => {
  process.stderr.write('switchboard-mcp: ' + err.message + '\\n')
  process.exitCode = 1
})
// Not process.exit: that can cut off stdout still being flushed to the agent.
socket.on('close', () => process.stdin.destroy())
process.stdin.on('end', () => socket.end())
`

/** Write the bridge under `dir` when it is missing or stale, and return its path. */
export function ensureStdioBridge(dir: string): string {
  const path = join(dir, 'switchboard-mcp.cjs')
  if (!existsSync(path) || readFileSync(path, 'utf8') !== STDIO_BRIDGE_SOURCE) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, STDIO_BRIDGE_SOURCE, { mode: 0o600 })
  }
  return path
}
