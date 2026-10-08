/**
 * The desktop consumers read a project override for chats in that project
 * and the global value everywhere else, and the Settings Scope and Projects
 * rules that show them.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  useAgentStore,
  setStoreDefaultRuntimeMode,
  defaultRuntimeModeFor,
  projectRuntimeModeOverride,
} from '../../src/renderer/stores/agent-store'
import { useProjectSettingsStore, effectiveLocalSetting } from '../../src/renderer/stores/project-settings-store'
import { resolveCardRuntimeMode } from '../../src/renderer/components/kanban/card-launch'
import {
  ALL_PROJECTS_SCOPE,
  NOT_SCOPABLE_REASON,
  launchConfigCount,
  overrideCount,
  projectSummary,
  scopedRow,
  scopeOptions,
  valueLabel,
} from '../../src/renderer/components/settings/project-scope'
import { SETTING_ROW } from '../../src/renderer/components/settings/settings-rows'

const APP = '/work/app'
const OTHER = '/work/other'

beforeEach(() => {
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  setStoreDefaultRuntimeMode('accept-edits')
  useProjectSettingsStore.setState({
    byProject: { [APP]: { 'chat.defaultRuntimeMode': 'plan', 'chat.followUpDefault': 'queue' }, [OTHER]: {} },
  })
})

describe('runtime mode for new chats', () => {
  it('starts a new chat in the project override, and a chat elsewhere in the global default', () => {
    const add = useAgentStore.getState().addSession
    add({ id: 'a', type: 'claude-code', status: 'idle', projectPath: APP, title: 'A' })
    add({ id: 'b', type: 'claude-code', status: 'idle', projectPath: OTHER, title: 'B' })
    const mode = (id: string) => useAgentStore.getState().sessions.find((s) => s.id === id)?.runtimeMode
    expect(mode('a')).toBe('plan')
    expect(mode('b')).toBe('accept-edits')
    // Both are the renderer's guess: neither is sent, the backend picks.
    expect(useAgentStore.getState().sessions.every((s) => s.runtimeModeUnresolved)).toBe(true)
  })

  it('lets only a project override beat a mode carried over from another chat', () => {
    expect(projectRuntimeModeOverride(APP)).toBe('plan')
    expect(projectRuntimeModeOverride(OTHER)).toBeUndefined()
    expect(defaultRuntimeModeFor(null)).toBe('accept-edits')
  })

  it("gives a kanban card with no mode of its own no mode, so the backend picks the project's", async () => {
    expect(await resolveCardRuntimeMode(null, null)).toBeUndefined()
  })

  it('resolves the follow-up default the same way', () => {
    expect(effectiveLocalSetting('chat.followUpDefault', APP, 'steer')).toBe('queue')
    expect(effectiveLocalSetting('chat.followUpDefault', OTHER, 'steer')).toBe('steer')
  })
})

describe('Settings project scope', () => {
  const projects = [
    { path: APP, name: 'app', sessions: [{ id: 's', startedAt: 5 } as never], workspaceId: null },
    { path: OTHER, name: 'other', sessions: [], workspaceId: 'w1' },
  ]
  const workspaces = [{ id: 'w1', name: 'Work', sortOrder: 0 } as never]

  it('lists All projects first, then Recent, then by workspace, with override counts', () => {
    const options = scopeOptions(projects, workspaces, useProjectSettingsStore.getState().byProject)
    expect(options.map((o) => [o.value, o.group, o.hint])).toEqual([
      [ALL_PROJECTS_SCOPE, undefined, undefined],
      [APP, 'Recent', '2 overrides'],
      [OTHER, 'Work', undefined],
    ])
  })

  it("shows a scopable row's effective value and marks an override; disables the rest of the page", () => {
    const overrides = useProjectSettingsStore.getState().byProject[APP]
    expect(scopedRow(SETTING_ROW.followUp, APP, 'steer', overrides)).toEqual({ value: 'queue', overridden: true })
    expect(scopedRow(SETTING_ROW.fileDiffs, APP, 'false', overrides)).toEqual({ value: 'false', overridden: false })
    expect(scopedRow(SETTING_ROW.streaming, APP, 'true', overrides)).toMatchObject({
      disabledReason: NOT_SCOPABLE_REASON,
    })
    expect(scopedRow(SETTING_ROW.streaming, null, 'true', overrides)).toEqual({ value: 'true', overridden: false })
    // Rows off Chat & agents are never scoped.
    expect(scopedRow(SETTING_ROW.theme, APP, 'dark', overrides)).toEqual({ value: 'dark', overridden: false })
  })

  it('labels values for search results', () => {
    expect(valueLabel(SETTING_ROW.runtimeMode, 'plan')).toBe('Plan')
    expect(valueLabel(SETTING_ROW.fileDiffs, 'true')).toBe('On')
    expect(valueLabel(SETTING_ROW.followUp, undefined)).toBeUndefined()
  })

  it('counts only known overrides, and summarises a project', () => {
    expect(overrideCount({ 'chat.followUpDefault': 'queue', ['chat.future' as never]: 'x' })).toBe(1)
    expect(projectSummary(3, 2)).toBe('3 launch configs · 2 overrides')
    expect(projectSummary(1, 0)).toBe('1 launch config · 0 overrides')
    expect(projectSummary(undefined, 1)).toBe('1 override')
    expect(launchConfigCount(null)).toBe(0)
    expect(launchConfigCount('configs:\n  default:\n    terminals: []\n  dev:\n    terminals: []\n')).toBe(2)
  })
})
