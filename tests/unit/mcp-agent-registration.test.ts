import { describe, expect, it } from 'vitest'
import {
  acpSwitchboardMcpServer,
  CODEX_SWITCHBOARD_TOOL_TIMEOUT_SEC,
  codexSwitchboardMcpArgs,
  isSwitchboardCodexElicitation,
  isSwitchboardOpencodeTool,
} from '../../src/main/mcp/agent-registration'
import { HOST_WRITE_APPROVAL_TTL_MS } from '../../src/shared/agent-host-writes'

const launch = {
  command: 'C:\\Program Files\\Switchboard\\Switchboard.exe',
  args: ['/data/mcp/switchboard-mcp.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_MCP_TOKEN: 'a"b' },
}

describe('Codex', () => {
  it('overrides config with TOML values, escaping what needs it', () => {
    expect(codexSwitchboardMcpArgs(launch)).toEqual([
      '-c', 'mcp_servers.switchboard.command="C:\\\\Program Files\\\\Switchboard\\\\Switchboard.exe"',
      '-c', 'mcp_servers.switchboard.args=["/data/mcp/switchboard-mcp.cjs"]',
      '-c', 'mcp_servers.switchboard.env={ELECTRON_RUN_AS_NODE="1",SWITCHBOARD_MCP_TOKEN="a\\"b"}',
      '-c', `mcp_servers.switchboard.tool_timeout_sec=${CODEX_SWITCHBOARD_TOOL_TIMEOUT_SEC}`,
    ])
  })

  it('waits on a call longer than a card lives, so the card always closes first', () => {
    expect(CODEX_SWITCHBOARD_TOOL_TIMEOUT_SEC * 1000).toBeGreaterThan(HOST_WRITE_APPROVAL_TTL_MS)
  })

  it('recognises only our own server\'s confirm', () => {
    expect(isSwitchboardCodexElicitation({ serverName: 'switchboard' })).toBe(true)
    expect(isSwitchboardCodexElicitation({ serverName: 'github' })).toBe(false)
    expect(isSwitchboardCodexElicitation(null)).toBe(false)
  })
})

describe('OpenCode', () => {
  it('describes the server as an ACP stdio entry', () => {
    expect(acpSwitchboardMcpServer(launch)).toEqual({
      name: 'switchboard',
      command: launch.command,
      args: launch.args,
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'SWITCHBOARD_MCP_TOKEN', value: 'a"b' }],
    })
  })

  it('names our tools with the server prefix', () => {
    expect(isSwitchboardOpencodeTool('switchboard_reply_to_conversation')).toBe(true)
    expect(isSwitchboardOpencodeTool('switchboardish_tool')).toBe(false)
    expect(isSwitchboardOpencodeTool('github_create_issue')).toBe(false)
  })
})
