/**
 * The Labs flag list: every flag is off by default, its env var beats its
 * stored row, a dependent flag is off while its parent is, and each feature's
 * own reader agrees with `labsFlagOn` for every combination.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  LABS_FLAGS,
  LABS_SETTING_KEYS,
  labsFlagCapabilities,
  labsFlagOn,
  labsFlagStates,
  type LabsFlagId,
} from '../../src/shared/labs'
import {
  AGENT_SECRET_REQUEST_CAPABILITY,
  AGENT_SECRET_REQUEST_ENABLED,
  agentSecretRequestEnabled,
} from '../../src/shared/agent-secret-request'
import { AGENT_VISUAL_PREVIEW_ENABLED, agentVisualPreviewEnabled } from '../../src/shared/visual-preview'
import { LIMIT_AUTO_RESUME_ENABLED, limitAutoResumeEnabled, type SettingReader } from '../../src/shared/limit-resume'
import {
  HUB_CHILDREN_CAPABILITY,
  HUB_CHILDREN_ENABLED,
  HUB_REMOTE_CHILDREN_CAPABILITY,
  HUB_REMOTE_CHILDREN_ENABLED,
  hubChildrenEnabled,
  hubRemoteChildrenEnabled,
} from '../../src/shared/hub'
import { INSTINCT_BRIDGE_ENABLED, instinctBridgeEnabled } from '../../src/shared/bridge'
import { ACP_REGISTRY_SEARCH_ENABLED } from '../../src/renderer/components/settings/acp-registry-source'
import { isSettingReadAllowed, isSettingWriteAllowed, PHONE_SCOPES, FULL_SCOPES } from '../../src/shared/device-auth'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))
const { OPENCODE_V2_ACP_ENABLED, opencodeV2AcpEnabled } =
  await import('../../src/main/provider/adapters/opencode/version')

const stored =
  (on: LabsFlagId[]): SettingReader =>
  (key) =>
    LABS_FLAGS.some((f) => f.setting === key && on.includes(f.id)) ? 'true' : null

describe('LABS_FLAGS', () => {
  it('lists each flag once with its labs.<id> key, every one off by default', () => {
    expect(LABS_FLAGS.map((f) => f.id)).toEqual([
      'agent_secret_request',
      'agent_visual_preview',
      'limit_auto_resume',
      'opencode_v2_acp',
      'hub_children',
      'hub_remote_children',
      'acp_registry_search',
      'instinct_bridge',
    ])
    for (const f of LABS_FLAGS) {
      expect(f.setting).toBe(`labs.${f.id}`)
      expect(f.defaultOn).toBe(false)
    }
  })

  it('keeps each default equal to the feature constant', () => {
    expect([
      AGENT_SECRET_REQUEST_ENABLED,
      AGENT_VISUAL_PREVIEW_ENABLED,
      LIMIT_AUTO_RESUME_ENABLED,
      OPENCODE_V2_ACP_ENABLED,
      HUB_CHILDREN_ENABLED,
      HUB_REMOTE_CHILDREN_ENABLED,
      ACP_REGISTRY_SEARCH_ENABLED,
      INSTINCT_BRIDGE_ENABLED,
    ]).toEqual(LABS_FLAGS.map((f) => f.defaultOn))
  })

  it('says when a change applies, and none needs a restart', () => {
    expect(Object.fromEntries(LABS_FLAGS.map((f) => [f.id, f.applies]))).toEqual({
      agent_secret_request: 'new_chats',
      agent_visual_preview: 'new_chats',
      limit_auto_resume: 'at_once',
      opencode_v2_acp: 'new_chats',
      hub_children: 'new_chats',
      hub_remote_children: 'new_chats',
      acp_registry_search: 'dialog_open',
      instinct_bridge: 'at_once',
    })
  })
})

describe('labsFlagOn', () => {
  it('is on by the env var, by the stored row, and off otherwise', () => {
    expect(labsFlagOn('agent_secret_request', {}, stored([]))).toBe(false)
    expect(labsFlagOn('agent_secret_request', { SB_AGENT_SECRET_REQUEST: '1' }, stored([]))).toBe(true)
    expect(labsFlagOn('agent_secret_request', { SB_AGENT_SECRET_REQUEST: '0' }, stored([]))).toBe(false)
    expect(labsFlagOn('agent_secret_request', {}, stored(['agent_secret_request']))).toBe(true)
    expect(labsFlagOn('agent_secret_request', {}, (k) => (k === 'labs.agent_secret_request' ? 'false' : null))).toBe(
      false,
    )
  })

  it('reports an env-forced flag as forced and on with its row stored off', () => {
    const states = labsFlagStates({ SB_LIMIT_AUTO_RESUME: '1' }, (k) =>
      k === 'labs.limit_auto_resume' ? 'false' : null,
    )
    expect(states.find((s) => s.id === 'limit_auto_resume')).toEqual({
      id: 'limit_auto_resume',
      forced: true,
      on: true,
    })
    expect(states.filter((s) => s.forced).map((s) => s.id)).toEqual(['limit_auto_resume'])
  })

  it('keeps a dependent flag off while its parent is off, whatever its own row or env says', () => {
    expect(labsFlagOn('hub_remote_children', {}, stored(['hub_remote_children']))).toBe(false)
    expect(labsFlagOn('hub_remote_children', { SB_HUB_REMOTE_CHILDREN: '1' }, stored([]))).toBe(false)
    expect(labsFlagOn('hub_remote_children', { SB_HUB_CHILDREN: '1' }, stored(['hub_remote_children']))).toBe(true)
  })

  it('agrees with each feature reader for every env and row combination', () => {
    const readers: Partial<Record<LabsFlagId, (env: NodeJS.ProcessEnv, get: SettingReader) => boolean>> = {
      agent_secret_request: agentSecretRequestEnabled,
      agent_visual_preview: agentVisualPreviewEnabled,
      limit_auto_resume: limitAutoResumeEnabled,
      opencode_v2_acp: opencodeV2AcpEnabled,
      hub_children: hubChildrenEnabled,
      hub_remote_children: hubRemoteChildrenEnabled,
      instinct_bridge: instinctBridgeEnabled,
    }
    for (let mask = 0; mask < 1 << 4; mask++) {
      // Each flag's env var and row, with the hub parent on or off.
      const envOn = mask & 1
      const rowOn = mask & 2
      const parentEnv = mask & 4
      const parentRow = mask & 8
      for (const [id, reader] of Object.entries(readers) as Array<
        [LabsFlagId, NonNullable<(typeof readers)[LabsFlagId]>]
      >) {
        const flag = LABS_FLAGS.find((f) => f.id === id)!
        const env: NodeJS.ProcessEnv = {}
        if (envOn) env[flag.envVar!] = '1'
        if (parentEnv) env.SB_HUB_CHILDREN = '1'
        const rows = new Set<string>()
        if (rowOn) rows.add(flag.setting)
        if (parentRow) rows.add('labs.hub_children')
        const get: SettingReader = (k) => (rows.has(k) ? 'true' : null)
        expect({ id, mask, on: reader(env, get) }).toEqual({ id, mask, on: labsFlagOn(id, env, get) })
      }
    }
  })
})

describe('labsFlagCapabilities', () => {
  it('advertises a flag capability only while the flag is on', () => {
    expect(labsFlagCapabilities({}, stored([]))).toEqual([])
    expect(labsFlagCapabilities({}, stored(['agent_secret_request']))).toEqual([AGENT_SECRET_REQUEST_CAPABILITY])
    expect(labsFlagCapabilities({ SB_HUB_CHILDREN: '1' }, stored(['hub_remote_children']))).toEqual([
      HUB_CHILDREN_CAPABILITY,
      HUB_REMOTE_CHILDREN_CAPABILITY,
    ])
  })
})

describe('Labs rows and device scopes', () => {
  it('lets every scope read a Labs row and only admin write one', () => {
    expect(LABS_SETTING_KEYS).toHaveLength(LABS_FLAGS.length)
    for (const key of LABS_SETTING_KEYS) {
      expect(isSettingReadAllowed(PHONE_SCOPES, key)).toBe(true)
      expect(isSettingWriteAllowed(PHONE_SCOPES, key)).toBe(false)
      expect(isSettingWriteAllowed(FULL_SCOPES, key)).toBe(true)
    }
  })
})
