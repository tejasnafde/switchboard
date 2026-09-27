/**
 * How each agent is told about the Switchboard MCP server, and how each one
 * names our tools when it asks about them. Pure, so every adapter's
 * registration and its no-second-prompt rule are tested without a CLI.
 *
 * - Claude: the SDK's `mcpServers` option; tools are `mcp__switchboard__<tool>`.
 * - Codex: `-c mcp_servers.switchboard.*` overrides on `codex app-server`, one
 *   process per chat, so the token is per chat too. It confirms a non-read-only
 *   tool with an empty-form `mcpServer/elicitation/request` naming the server.
 * - OpenCode: the ACP `session/new` `mcpServers` list; tools are `switchboard_<tool>`.
 */
import { SWITCHBOARD_MCP_SERVER_NAME, type SwitchboardMcpLaunch } from './switchboard-mcp-server'
import { HOST_WRITE_APPROVAL_TTL_MS } from '@shared/agent-host-writes'

/**
 * Codex gives up on an MCP call after 60 seconds by default, which is less
 * time than a person needs to read and edit a reply. Past the card's own
 * expiry, so the card always closes first and a late approval cannot post.
 */
export const CODEX_SWITCHBOARD_TOOL_TIMEOUT_SEC = Math.ceil(HOST_WRITE_APPROVAL_TTL_MS / 1000) + 300

/** A TOML basic string. JSON's escapes are a subset TOML accepts. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function codexSwitchboardMcpArgs(launch: SwitchboardMcpLaunch): string[] {
  const key = `mcp_servers.${SWITCHBOARD_MCP_SERVER_NAME}`
  const env = Object.entries(launch.env).map(([k, v]) => `${k}=${tomlString(v)}`).join(',')
  return [
    '-c', `${key}.command=${tomlString(launch.command)}`,
    '-c', `${key}.args=[${launch.args.map(tomlString).join(',')}]`,
    '-c', `${key}.env={${env}}`,
    '-c', `${key}.tool_timeout_sec=${CODEX_SWITCHBOARD_TOOL_TIMEOUT_SEC}`,
  ]
}

/** Codex's yes/no confirm for one of OUR tools: accepted, because the server shows the real card. */
export function isSwitchboardCodexElicitation(params: unknown): boolean {
  return (params as { serverName?: unknown } | null)?.serverName === SWITCHBOARD_MCP_SERVER_NAME
}

export interface AcpStdioMcpServer {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}

export function acpSwitchboardMcpServer(launch: SwitchboardMcpLaunch): AcpStdioMcpServer {
  return {
    name: SWITCHBOARD_MCP_SERVER_NAME,
    command: launch.command,
    args: launch.args,
    env: Object.entries(launch.env).map(([name, value]) => ({ name, value })),
  }
}

/** OpenCode's name for one of our tools, as a permission request carries it. */
export function isSwitchboardOpencodeTool(toolName: string): boolean {
  return toolName.startsWith(`${SWITCHBOARD_MCP_SERVER_NAME}_`)
}
