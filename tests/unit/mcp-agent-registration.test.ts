import { describe, expect, it } from 'vitest'
import {
  acpSwitchboardMcpServer,
  CODEX_SWITCHBOARD_TOOL_TIMEOUT_SEC,
  codexSwitchboardMcpArgs,
  isSwitchboardCodexElicitation,
  isSwitchboardOpencodeReadTool,
  isSwitchboardOpencodeTool,
} from '../../src/main/mcp/agent-registration'

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

  it('allows a slow host call past Codex\'s 60 second default; no call waits on a card any more', () => {
    expect(CODEX_SWITCHBOARD_TOOL_TIMEOUT_SEC).toBe(180)
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
    // A user server named switchboard_x shares the prefix but is not ours.
    expect(isSwitchboardOpencodeTool('switchboard_x_delete_repo')).toBe(false)
    expect(isSwitchboardOpencodeTool('switchboard_made_up_tool')).toBe(false)
    expect(isSwitchboardOpencodeTool('github_create_issue')).toBe(false)
  })

  it('knows the diff, line comment and review tools, and only the diff as a read plan mode allows', () => {
    for (const tool of ['get_pr_diff', 'comment_on_line', 'draft_review']) expect(isSwitchboardOpencodeTool(`switchboard_${tool}`)).toBe(true)
    expect(isSwitchboardOpencodeReadTool('switchboard_get_pr_diff')).toBe(true)
    expect(isSwitchboardOpencodeReadTool('switchboard_comment_on_line')).toBe(false)
    for (const tool of ['link_pull_request', 'unlink_pull_request', 'list_thread_pull_requests']) expect(isSwitchboardOpencodeTool(`switchboard_${tool}`)).toBe(true)
    expect(isSwitchboardOpencodeReadTool('switchboard_list_thread_pull_requests')).toBe(true)
    expect(isSwitchboardOpencodeReadTool('switchboard_link_pull_request')).toBe(false)
    expect(isSwitchboardOpencodeReadTool('switchboard_draft_review')).toBe(false)
  })
})
