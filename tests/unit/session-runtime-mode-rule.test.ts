/**
 * One rule for every renderer session: a mode is sent to the backend only if
 * someone chose it (the user, a carried-over mode, a card's own mode, the
 * conversation's stored mode, or the backend's live descriptor). Otherwise
 * the session is unresolved: it shows the renderer's default as a guess,
 * sends no mode, and the backend's `sessionDefaultsFor` picks the project's.
 *
 * `initialRuntimeMode` holds the rule and the two ways into the store
 * (`addSession`, `adoptLiveSessions`) both apply it; the source guard below
 * keeps a new path from building a session some other way.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, win32 } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useAgentStore,
  setStoreDefaultRuntimeMode,
  initialRuntimeMode,
  runtimeModeToSend,
} from '../../src/renderer/stores/agent-store'
import { useProjectSettingsStore } from '../../src/renderer/stores/project-settings-store'
import { launchCardChat } from '../../src/renderer/components/kanban/card-launch'
import type { KanbanCard } from '../../src/shared/kanban'
import type { LiveSessionSummary } from '../../src/shared/live-sessions'

const APP = '/work/app'
const OTHER = '/work/other'

const session = (id: string) => useAgentStore.getState().sessions.find((s) => s.id === id)!

beforeEach(() => {
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  setStoreDefaultRuntimeMode('accept-edits')
  useProjectSettingsStore.setState({ byProject: { [APP]: { 'chat.defaultRuntimeMode': 'plan' }, [OTHER]: {} } })
})

describe('initialRuntimeMode', () => {
  it.each([
    // chosen                 project   shown           sent
    ['full-access',           APP,      'full-access',  'full-access'],
    ['sandbox',               OTHER,    'sandbox',      'sandbox'],
    [undefined,               APP,      'plan',         undefined],
    [undefined,               OTHER,    'accept-edits', undefined],
    [null,                    APP,      'plan',         undefined],
    ['not-a-mode',            OTHER,    'accept-edits', undefined],
    [undefined,               '/not/loaded', 'accept-edits', undefined],
  ])('chosen %s in %s shows %s and sends %s', (chosen, projectPath, shown, sent) => {
    const fields = initialRuntimeMode(projectPath, chosen)
    expect(fields.runtimeMode).toBe(shown)
    expect(runtimeModeToSend(fields)).toBe(sent)
  })
})

describe('every way a session enters the store applies it', () => {
  it('addSession: a mode passed in is kept; none means unresolved', () => {
    const add = useAgentStore.getState().addSession
    add({ id: 'chosen', type: 'claude-code', status: 'idle', projectPath: APP, title: 't', runtimeMode: 'full-access' })
    add({ id: 'open', type: 'claude-code', status: 'idle', projectPath: APP, title: 't' })
    expect(runtimeModeToSend(session('chosen'))).toBe('full-access')
    expect(session('open')).toMatchObject({ runtimeMode: 'plan', runtimeModeUnresolved: true })
    expect(runtimeModeToSend(session('open'))).toBeUndefined()
  })

  it('adoptLiveSessions (a chat the backend or the phone is running): its mode is the backend\'s', () => {
    const live = (threadId: string, runtimeMode?: string) => ({
      threadId, provider: 'claude', status: 'idle', cwd: APP, runtimeMode, createdAt: 0,
    }) as unknown as LiveSessionSummary
    useAgentStore.getState().adoptLiveSessions([live('phone', 'full-access'), live('bare')], 'local')
    expect(runtimeModeToSend(session('phone'))).toBe('full-access')
    expect(runtimeModeToSend(session('bare'))).toBeUndefined()
  })
})

describe('kanban reuse (the reported path)', () => {
  function api(storedMode: string | null) {
    const setRuntimeMode = vi.fn(async () => undefined)
    ;(globalThis as { window?: unknown }).window = {
      api: {
        app: {
          unarchiveConversation: vi.fn(async () => undefined),
          getConversations: vi.fn(async () => [{ id: 'conv', project_path: APP, title: 't', agent_type: 'claude-code', worktree_path: null, worktree_branch: null }]),
          getConversationRuntimeMode: vi.fn(async () => ({ mode: storedMode })),
          getConversationModel: vi.fn(async () => ({ model: null })),
        },
        provider: { setRuntimeMode },
      },
    }
    return setRuntimeMode
  }
  const card = (runtimeMode: string | null) =>
    ({ id: 'k', projectPath: APP, title: 't', description: '', runtimeMode, conversationId: 'conv', worktreePath: null, worktreeBranch: null }) as unknown as KanbanCard

  it('leaves the mode unresolved when neither the conversation nor the card has one', async () => {
    const setRuntimeMode = api(null)
    await launchCardChat(card(null), { openChat: true })
    expect(session('conv')).toMatchObject({ runtimeMode: 'plan', runtimeModeUnresolved: true })
    expect(runtimeModeToSend(session('conv'))).toBeUndefined()
    expect(setRuntimeMode).not.toHaveBeenCalled()
  })

  it('applies the conversation\'s stored mode before the card\'s', async () => {
    api('full-access')
    await launchCardChat(card('sandbox'), { openChat: true })
    expect(runtimeModeToSend(session('conv'))).toBe('full-access')
  })

  it('keeps the mode of a session already in memory', async () => {
    const setRuntimeMode = api(null)
    useAgentStore.getState().addSession({ id: 'conv', type: 'claude-code', status: 'idle', projectPath: APP, title: 't', runtimeMode: 'full-access' })
    await launchCardChat(card('sandbox'), { openChat: true })
    expect(runtimeModeToSend(session('conv'))).toBe('full-access')
    expect(setRuntimeMode).not.toHaveBeenCalled()
  })

  it('does not overwrite a mode the user picked while the stored mode was being read', async () => {
    const setRuntimeMode = api(null)
    let answer!: (value: { mode: string }) => void
    const app = (globalThis as { window: { api: { app: Record<string, unknown> } } }).window.api.app
    app.getConversationRuntimeMode = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    const launch = launchCardChat(card(null), { openChat: true })
    await vi.waitFor(() => expect(answer).toBeDefined())
    useAgentStore.getState().setRuntimeMode('conv', 'plan')
    answer({ mode: 'full-access' })
    await launch
    expect(runtimeModeToSend(session('conv'))).toBe('plan')
    expect(setRuntimeMode).not.toHaveBeenCalled()
  })

  it('falls back to the card\'s own mode', async () => {
    api(null)
    await launchCardChat(card('sandbox'), { openChat: true })
    expect(runtimeModeToSend(session('conv'))).toBe('sandbox')
  })
})

describe('source guard', () => {
  interface Source { path: string; text: string }
  const root = join(__dirname, '../../src/renderer')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : []
  })
  // Platform-neutral: a Windows checkout has backslash paths and, with
  // autocrlf, CRLF line endings. Both are folded before any check.
  const normalise = ({ path, text }: Source): Source => ({ path: path.replace(/\\/g, '/'), text: text.replace(/\r\n/g, '\n') })
  const sources = files(root).map((path) => normalise({ path: relative(root, path), text: readFileSync(path, 'utf8') }))

  /** What the guard asserts, as data, so it can be run over any spelling of the tree. */
  function findings(tree: readonly Source[]) {
    // A fresh session literal is the only place `unreadCount: 0` appears unspread.
    const builders = tree.filter(({ text }) => text.split('\n').some((line) => /\bunreadCount: 0\b/.test(line) && !line.includes('...')))
    const flagWriters = tree.filter(({ text }) => /runtimeModeUnresolved:\s*true/.test(text))
    const store = tree.find((f) => f.path === 'stores/agent-store.ts')?.text ?? ''
    return {
      builders: builders.map((f) => f.path),
      flagWriters: flagWriters.map((f) => f.path),
      storeHelperCalls: store.match(/\.\.\.initialRuntimeMode\(/g)?.length ?? 0,
      storeBuilders: store.split('\n').filter((line) => /^\s+unreadCount: 0,$/.test(line)).length,
    }
  }

  it('only agent-store builds a session object or sets runtimeModeUnresolved', () => {
    const { builders, flagWriters } = findings(sources)
    expect(builders).toEqual(['stores/agent-store.ts'])
    expect(flagWriters).toEqual(['stores/agent-store.ts'])
  })

  it('both builders in agent-store go through initialRuntimeMode', () => {
    const { storeHelperCalls, storeBuilders } = findings(sources)
    expect(storeHelperCalls).toBe(2)
    expect(storeBuilders).toBe(2)
  })

  it('reaches the same verdict on a Windows checkout (backslash paths, CRLF endings)', () => {
    const windows = sources.map(({ path, text }) =>
      normalise({ path: win32.join(...path.split('/')), text: text.replace(/\n/g, '\r\n') }))
    expect(windows.some((f) => f.path.includes('\\'))).toBe(false)
    expect(findings(windows)).toEqual(findings(sources))
    // Without the folding the checks would miss: this is what failed on the Windows runner.
    const raw = sources.map(({ path, text }) => ({ path: win32.join(...path.split('/')), text: text.replace(/\n/g, '\r\n') }))
    expect(findings(raw)).not.toEqual(findings(sources))
  })
})
