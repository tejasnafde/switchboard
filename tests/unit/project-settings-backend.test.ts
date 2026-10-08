/**
 * Project overrides on the backend: stored under the worktree manager's
 * `pathKey`, so any spelling of a project folder finds the same rows;
 * tolerant of setting keys a newer build wrote; and read by the backend's
 * own consumer (the mode a new session starts in).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMigratedDb } from './helpers/test-db'

const warnings: string[] = []

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (message: string) => { warnings.push(message) },
    error: () => {},
  }),
}))

vi.mock('../../src/main/db/provider-instances', () => ({ getProviderInstanceFull: () => null }))

import { addProject, createConversation, getSetting, listSettingsWithPrefix, setSetting } from '../../src/main/db/database'
import {
  getSettingForProject,
  listProjectOverrides,
  removeProjectOverride,
  setProjectOverride,
} from '../../src/main/project-settings'
import { sessionDefaultsFor } from '../../src/main/provider/session-defaults'
import { pathKey } from '../../src/main/worktree'
import { PROJECT_OVERRIDE_PREFIX, projectOverrideKey } from '../../src/shared/project-settings'

const root = mkdtempSync(join(tmpdir(), 'sb-project-settings-'))
const repo = join(root, 'Repo')
const other = join(root, 'other')
mkdirSync(repo)
mkdirSync(other)
const alias = join(root, 'alias')
symlinkSync(repo, alias, 'junction')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const settingKeys = () => listSettingsWithPrefix(PROJECT_OVERRIDE_PREFIX).map((r) => r.key)

beforeEach(() => {
  createMigratedDb()
  warnings.length = 0
})

describe('project overrides', () => {
  it('lands on the same rows through a junction', () => {
    setProjectOverride(alias, 'chat.followUpDefault', 'queue')
    expect(listProjectOverrides([repo, other])).toEqual({ [repo]: { 'chat.followUpDefault': 'queue' }, [other]: {} })
    expect(settingKeys()).toEqual([projectOverrideKey(pathKey(repo), 'chat.followUpDefault')])
    removeProjectOverride(repo, 'chat.followUpDefault')
    expect(settingKeys()).toEqual([])
  })

  it('matches a case variant on Windows, where the filesystem ignores case', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      setProjectOverride(repo, 'chat.showFileDiffs', 'true')
      expect(listProjectOverrides([repo.toUpperCase()])[repo.toUpperCase()]).toEqual({ 'chat.showFileDiffs': 'true' })
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('ignores and logs an override of a setting this build does not know, and keeps the row', () => {
    const unknown = projectOverrideKey(pathKey(repo), 'chat.fromTheFuture')
    setSetting(unknown, 'x')
    setProjectOverride(repo, 'defaultSessionEnvMode', 'worktree')
    expect(listProjectOverrides([repo])[repo]).toEqual({ defaultSessionEnvMode: 'worktree' })
    expect(getSetting(unknown)).toBe('x')
    expect(warnings.some((w) => w.includes('chat.fromTheFuture'))).toBe(true)
  })

  it('refuses a setting that is not scopable, and a value the setting does not accept', () => {
    expect(() => setProjectOverride(repo, 'theme', 'light')).toThrow(/cannot be set per project/)
    expect(() => setProjectOverride(repo, 'chat.defaultRuntimeMode', 'yolo')).toThrow(/not a value/)
    expect(settingKeys()).toEqual([])
  })

  it('answers settings:get with a project path with the effective value, and without one with the global row', () => {
    setSetting('chat.defaultRuntimeMode', 'accept-edits')
    setProjectOverride(repo, 'chat.defaultRuntimeMode', 'plan')
    expect(getSettingForProject('chat.defaultRuntimeMode', alias)).toBe('plan')
    expect(getSettingForProject('chat.defaultRuntimeMode', other)).toBe('accept-edits')
    expect(getSettingForProject('chat.defaultRuntimeMode', undefined)).toBe('accept-edits')
    expect(getSettingForProject('theme', repo)).toBeNull()
  })
})

describe('the backend consumer', () => {
  it('starts a new session in its project\'s mode, and a session elsewhere in the global one', () => {
    setSetting('chat.defaultRuntimeMode', 'accept-edits')
    setProjectOverride(repo, 'chat.defaultRuntimeMode', 'plan')
    expect(sessionDefaultsFor('t-new', 'claude-code', {}, repo).runtimeMode).toBe('plan')
    expect(sessionDefaultsFor('t-other', 'claude-code', {}, other).runtimeMode).toBe('accept-edits')
    // A request still wins over every stored default.
    expect(sessionDefaultsFor('t-new', 'claude-code', { runtimeMode: 'full-access' }, repo).runtimeMode).toBe('full-access')
  })

  it('follows the parent project for a worktree chat', () => {
    setProjectOverride(repo, 'chat.defaultRuntimeMode', 'plan')
    const worktree = join(repo, '.switchboard', 'worktrees', 'x')
    addProject(repo, 'Repo')
    createConversation('t-wt', repo, 'claude-code', 'Worktree chat', worktree, 'wt-x')
    expect(sessionDefaultsFor('t-wt', 'claude-code', {}, worktree).runtimeMode).toBe('plan')
  })
})
