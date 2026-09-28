import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { withTimeout } from '../../shared/promise-timeout'
import { getProviderInstanceFull, type ProviderInstanceRow } from '../db/provider-instances'
import { createMainLogger } from '../logger'
import { scanCodexSessionCopies } from '../projects/session-scanner'
import { findCodexPath } from '../provider/adapters/codex-adapter'
import { buildOpencodeEnv, findOpencodePath } from '../provider/adapters/opencode/env'
import { resolveInstanceEnv } from '../provider/instance-env'
import { CodexProbeSession } from '../provider/usage/codex-usage'
import { NativeForkUnsupportedError } from './native-fork'

const log = createMainLogger('conversations:native-fork')

const RPC_TIMEOUT_MS = 30_000
const CLIENT_INFO = { name: 'switchboard', title: 'Switchboard', version: '0.1.0' }

export interface NativeForkRunners {
  /** The thread's rollout under the instance's own CODEX_HOME, or null. */
  readCodexRollout(instanceId: string, threadId: string): Promise<string | null>
  forkCodexThread(
    instanceId: string,
    params: { threadId: string; lastTurnId: string; cwd: string },
  ): Promise<{ threadId: string; path: string | null }>
  forkOpencodeSession(instanceId: string, params: { sessionId: string; cwd: string }): Promise<string>
}

export interface NativeForkBinaries {
  codex(): string | null
  opencode(): string | null
}

function instanceOf(instanceId: string): ProviderInstanceRow {
  const instance = getProviderInstanceFull(instanceId)
  if (!instance) throw new Error(`Provider instance ${instanceId} is missing`)
  return instance
}

function codexHomeOf(env: Record<string, string>): string {
  return env.CODEX_HOME || join(homedir(), '.codex')
}

export function createNativeForkRunners(
  binaries: NativeForkBinaries = { codex: findCodexPath, opencode: findOpencodePath },
  envOf: (instanceId: string) => Record<string, string> = (id) => resolveInstanceEnv(instanceOf(id)),
  opencodeEnvOf: (instanceId: string) => Record<string, string> = (id) => buildOpencodeEnv(instanceOf(id).env),
): NativeForkRunners {
  return {
    async readCodexRollout(instanceId, threadId) {
      const copies = await scanCodexSessionCopies(new Set([threadId]), [codexHomeOf(envOf(instanceId))])
      const path = copies.find((copy) => copy.id === threadId)?.filePath
      return path ? readFile(path, 'utf8') : null
    },

    async forkCodexThread(instanceId, params) {
      const bin = binaries.codex()
      if (!bin) throw new Error('Codex CLI not found')
      const probe = new CodexProbeSession(bin, envOf(instanceId))
      try {
        await probe.send('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, RPC_TIMEOUT_MS)
        probe.notify('initialized')
        const result = await probe.send('thread/fork', {
          threadId: params.threadId,
          lastTurnId: params.lastTurnId,
          cwd: params.cwd,
          excludeTurns: true,
        }, RPC_TIMEOUT_MS) as { thread?: { id?: unknown; path?: unknown } } | null
        const threadId = result?.thread?.id
        if (typeof threadId !== 'string' || !threadId) throw new Error('Codex thread/fork did not return a thread id')
        return { threadId, path: typeof result?.thread?.path === 'string' ? result.thread.path : null }
      } finally {
        probe.dispose()
      }
    },

    async forkOpencodeSession(instanceId, params) {
      const bin = binaries.opencode()
      if (!bin) throw new Error('OpenCode CLI not found')
      const child = spawn(bin, ['acp', '--cwd', params.cwd], {
        cwd: params.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: opencodeEnvOf(instanceId),
      })
      child.stderr.on('data', (data: Buffer) => log.debug(`opencode fork stderr: ${data.toString().slice(0, 500)}`))
      const exited = new Promise<never>((_, reject) => {
        child.once('error', reject)
        child.once('close', (code) => reject(new Error(`opencode acp exited (code ${code ?? 'null'})`)))
      })
      exited.catch((error: unknown) => log.debug('opencode fork child ended', error))
      const connection = new ClientSideConnection(() => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
      }), ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ))
      try {
        const init = await withTimeout(Promise.race([
          connection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
          exited,
        ]), RPC_TIMEOUT_MS, 'initialize')
        if (!init.agentCapabilities?.sessionCapabilities?.fork) {
          throw new NativeForkUnsupportedError('OpenCode does not advertise session/fork')
        }
        const forked = await withTimeout(Promise.race([
          connection.unstable_forkSession({ sessionId: params.sessionId, cwd: params.cwd, mcpServers: [] }),
          exited,
        ]), RPC_TIMEOUT_MS, 'session/fork')
        return forked.sessionId
      } finally {
        child.kill('SIGTERM')
      }
    },
  }
}
