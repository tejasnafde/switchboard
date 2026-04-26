/**
 * @deprecated Legacy agent manager using Claude CLI --print mode.
 * Retained as fallback for systems without @anthropic-ai/claude-agent-sdk.
 * New sessions should use the provider bridge (src/main/provider/).
 */
import { spawn, execSync, type ChildProcess } from 'child_process'
import { createMainLogger as createLogger } from '../logger'
import type { AgentStartOptions, AgentStatus, ChatMessage } from '@shared/types'

const log = createLogger('agent:legacy')

export type AgentMessageCallback = (agentId: string, message: ChatMessage) => void
export type AgentMessageUpdateCallback = (agentId: string, messageId: string, updates: Partial<ChatMessage>) => void
export type AgentStatusCallback = (agentId: string, status: AgentStatus) => void
export type AgentErrorCallback = (agentId: string, error: string) => void

interface ManagedAgent {
  id: string
  type: 'claude-code' | 'codex' | 'opencode'
  cwd: string
  sessionId?: string
  process: ChildProcess | null
  status: AgentStatus
  messageCount: number
  /** Stable ID for the current streaming text message */
  currentTextMsgId: string | null
  /** Set of tool_use IDs we've already emitted (dedup during streaming) */
  seenToolIds: Set<string>
}

/** Clean env for spawning CLI — strip ELECTRON_RUN_AS_NODE, ensure PATH is complete */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Ensure common paths are in PATH (Electron may not inherit full shell PATH)
  const home = env.HOME || ''
  const extraPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.npm-global/bin`,
    `${home}/.nvm/versions/node/$(node -v 2>/dev/null || echo v20)/bin`,
    `${home}/.local/bin`,
  ].join(':')
  env.PATH = `${extraPaths}:${env.PATH || '/usr/bin:/bin'}`
  return env
}

/** Find the claude CLI binary */
function findClaudePath(): string | null {
  const env = cleanEnv()
  const home = process.env.HOME || ''
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.claude/local/claude`,
    `${home}/.npm-global/bin/claude`,
  ]

  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { timeout: 2000, env })
      return p
    } catch { /* not found */ }
  }

  try {
    return execSync('which claude 2>/dev/null', {
      encoding: 'utf-8', timeout: 5000, env,
    }).trim().split('\n')[0] || null
  } catch {
    return null
  }
}

let cachedClaudePath: string | null | undefined

export class AgentManager {
  private agents = new Map<string, ManagedAgent>()
  private onMessage: AgentMessageCallback
  private onMessageUpdate: AgentMessageUpdateCallback
  private onStatus: AgentStatusCallback
  private onError: AgentErrorCallback

  constructor(
    onMessage: AgentMessageCallback,
    onMessageUpdate: AgentMessageUpdateCallback,
    onStatus: AgentStatusCallback,
    onError: AgentErrorCallback,
  ) {
    this.onMessage = onMessage
    this.onMessageUpdate = onMessageUpdate
    this.onStatus = onStatus
    this.onError = onError
  }

  async start(opts: AgentStartOptions): Promise<void> {
    if (this.agents.has(opts.id)) {
      throw new Error(`Agent ${opts.id} is already running`)
    }

    const managed: ManagedAgent = {
      id: opts.id,
      type: opts.type,
      cwd: opts.cwd,
      sessionId: opts.resumeSessionId,
      process: null,
      status: 'idle',
      messageCount: 0,
      currentTextMsgId: null,
      seenToolIds: new Set(),
    }

    this.agents.set(opts.id, managed)
    this.onStatus(opts.id, 'idle')
    log.info(`session created: ${opts.id} type=${opts.type}`)
  }

  async send(id: string, message: string): Promise<void> {
    const agent = this.agents.get(id)
    if (!agent) throw new Error(`Agent ${id} not found`)

    if (agent.process) {
      log.warn(`agent ${id} busy, ignoring`)
      return
    }

    if (agent.type !== 'claude-code') {
      this.onError(id, 'Only Claude Code is supported currently')
      return
    }

    // Find claude binary
    if (cachedClaudePath === undefined) {
      cachedClaudePath = findClaudePath()
    }
    if (!cachedClaudePath) {
      this.onError(id, 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code')
      return
    }

    const isNewSession = !agent.sessionId
    const args = this.buildArgs(agent, message)

    log.info(`spawning: ${cachedClaudePath} ${args.join(' ').slice(0, 200)}...`)

    agent.status = 'running'
    agent.currentTextMsgId = null
    agent.seenToolIds.clear()
    this.onStatus(id, 'running')

    const env = cleanEnv()
    const proc = spawn(cachedClaudePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: agent.cwd === '.' ? process.cwd() : agent.cwd,
      env,
    })

    agent.process = proc

    let buffer = ''

    proc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          this.handleStreamEvent(id, agent, event)
        } catch {
          // Partial or non-JSON line
        }
      }
    })

    let stderrBuffer = ''
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) {
        stderrBuffer += msg + '\n'
        log.warn(`stderr [${id}]: ${msg.slice(0, 300)}`)
      }
    })

    proc.on('close', (code) => {
      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer)
          this.handleStreamEvent(id, agent, event)
        } catch { /* ignore */ }
      }

      agent.process = null
      agent.messageCount++

      if (code === 0) {
        agent.status = 'idle'
        this.onStatus(id, 'idle')
      } else {
        agent.status = 'error'
        this.onStatus(id, 'error')
        const errDetail = stderrBuffer.trim().slice(0, 200)
        const errMsg = errDetail
          ? `Claude error: ${errDetail}`
          : `Claude exited with code ${code}. Run 'claude' in terminal to check auth.`
        this.onError(id, errMsg)
      }

      log.info(`process exited: ${id} code=${code} sessionId=${agent.sessionId}`)
    })

    proc.on('error', (err) => {
      agent.process = null
      agent.status = 'error'
      this.onStatus(id, 'error')
      this.onError(id, `Failed to start Claude: ${err.message}`)
    })
  }

  private handleStreamEvent(agentId: string, agent: ManagedAgent, raw: any): void {
    if (!raw || !raw.type) return

    switch (raw.type) {
      case 'system': {
        if (raw.session_id) {
          agent.sessionId = raw.session_id
          log.info(`session_id captured: ${raw.session_id}`)
        }
        break
      }

      case 'assistant': {
        const content = raw.message?.content
        if (!content || !Array.isArray(content)) break

        // Combine all text blocks into one streamed message
        const textParts: string[] = []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text)
          }
        }

        const combinedText = textParts.join('\n')

        if (combinedText) {
          if (agent.currentTextMsgId) {
            // UPDATE existing streaming message
            this.onMessageUpdate(agentId, agent.currentTextMsgId, {
              content: combinedText,
            })
          } else {
            // CREATE new streaming message
            const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            agent.currentTextMsgId = msgId
            this.onMessage(agentId, {
              id: msgId,
              role: 'assistant',
              content: combinedText,
              timestamp: Date.now(),
            })
          }
        }

        // Handle tool_use blocks (deduplicated by tool ID)
        for (const block of content) {
          if (block.type === 'tool_use' && block.id) {
            if (agent.seenToolIds.has(block.id)) continue
            agent.seenToolIds.add(block.id)

            // Finalize any current text message before tool call
            agent.currentTextMsgId = null

            const name = block.name || 'Unknown'
            const input = block.input || {}

            this.onMessage(agentId, {
              id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: block.id,
                name,
                input: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
              }],
              timestamp: Date.now(),
            })
          }
        }

        // Update status to thinking when we see content streaming
        if (agent.status !== 'thinking') {
          agent.status = 'thinking'
          this.onStatus(agentId, 'thinking')
        }
        break
      }

      case 'result': {
        // Check if we already streamed text via assistant events BEFORE clearing state
        const alreadyStreamed = agent.currentTextMsgId !== null

        agent.currentTextMsgId = null
        agent.seenToolIds.clear()

        // Skip emitting result text if assistant events already displayed it
        // The result event duplicates the final assistant text
        if (raw.result && !alreadyStreamed) {
          this.onMessage(agentId, {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'assistant',
            content: raw.result,
            timestamp: Date.now(),
          })
        }
        if (raw.session_id) {
          agent.sessionId = raw.session_id
        }
        break
      }
    }
  }

  private buildArgs(agent: ManagedAgent, message: string): string[] {
    const args = ['--print', '--output-format', 'stream-json', '--verbose']

    if (agent.sessionId) {
      args.push('--resume', agent.sessionId)
      args.push('-p', message)
    } else {
      args.push('-p', message)
    }

    return args
  }

  kill(id: string): void {
    const agent = this.agents.get(id)
    if (!agent) return
    if (agent.process) {
      agent.process.kill('SIGTERM')
      agent.process = null
    }
    this.agents.delete(id)
  }

  killAll(): void {
    for (const [id] of this.agents) {
      this.kill(id)
    }
  }

  getStatus(id: string): AgentStatus {
    return this.agents.get(id)?.status ?? 'exited'
  }
}
