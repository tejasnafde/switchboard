/**
 * Labs: the staged flags the Settings > Labs page switches, in one list.
 *
 * Each flag is on when its compiled default is on, when its env var is `1` in
 * Switchboard's own env (fixed for the process, so the page shows it as forced),
 * or when its `labs.<flag>` backend settings row is `'true'`. A flag that needs
 * another is off while that one is off, whatever its own row says. The
 * features read the same rows; `tests/unit/labs.test.ts` keeps their readers
 * equal to `labsFlagOn`.
 *
 * Writes go through `settings:set`. The rows are in `ADMIN_ONLY_SETTING_KEYS`,
 * so a phone credential cannot turn on a tool that reads the user's files.
 */
import type { SettingReader } from './limit-resume'

export type LabsFlagId =
  | 'agent_secret_request'
  | 'agent_visual_preview'
  | 'limit_auto_resume'
  | 'opencode_v2_acp'
  | 'hub_children'
  | 'hub_remote_children'
  | 'acp_registry_search'
  | 'instinct_bridge'

/** When a change takes effect. None is read once at start. */
export type LabsApplies = 'new_chats' | 'at_once' | 'dialog_open'

export interface LabsFlag {
  id: LabsFlagId
  setting: `labs.${LabsFlagId}`
  envVar?: string
  /** The compiled default. Every flag is off until its feature ships. */
  defaultOn: boolean
  applies: LabsApplies
  needs?: LabsFlagId
  /** Advertised in `ready` only while the flag is on. */
  capability?: string
}

export const LABS_FLAGS: readonly LabsFlag[] = [
  {
    id: 'agent_secret_request',
    setting: 'labs.agent_secret_request',
    envVar: 'SB_AGENT_SECRET_REQUEST',
    defaultOn: false,
    applies: 'new_chats',
    capability: 'agent_secret_request_v1',
  },
  {
    id: 'agent_visual_preview',
    setting: 'labs.agent_visual_preview',
    envVar: 'SB_AGENT_VISUAL_PREVIEW',
    defaultOn: false,
    applies: 'new_chats',
  },
  // limit_auto_resume_v1 stays in the fixed list: its get answers `none` while this is off.
  {
    id: 'limit_auto_resume',
    setting: 'labs.limit_auto_resume',
    envVar: 'SB_LIMIT_AUTO_RESUME',
    defaultOn: false,
    applies: 'at_once',
  },
  {
    id: 'opencode_v2_acp',
    setting: 'labs.opencode_v2_acp',
    envVar: 'SB_OPENCODE_V2_ACP',
    defaultOn: false,
    applies: 'new_chats',
  },
  {
    id: 'hub_children',
    setting: 'labs.hub_children',
    envVar: 'SB_HUB_CHILDREN',
    defaultOn: false,
    applies: 'new_chats',
    capability: 'hub_children_v1',
  },
  {
    id: 'hub_remote_children',
    setting: 'labs.hub_remote_children',
    envVar: 'SB_HUB_REMOTE_CHILDREN',
    defaultOn: false,
    applies: 'new_chats',
    needs: 'hub_children',
    capability: 'hub_remote_children_v1',
  },
  {
    id: 'acp_registry_search',
    setting: 'labs.acp_registry_search',
    defaultOn: false,
    applies: 'dialog_open',
  },
  {
    id: 'instinct_bridge',
    setting: 'labs.instinct_bridge',
    envVar: 'SB_INSTINCT_BRIDGE',
    defaultOn: false,
    applies: 'at_once',
    // BRIDGE_DEVICE_CAPABILITY in shared/bridge: the seven tools really run now.
    capability: 'instinct_bridge_v1',
  },
]

export const LABS_SETTING_KEYS: readonly string[] = LABS_FLAGS.map((f) => f.setting)

export function labsFlag(id: LabsFlagId): LabsFlag {
  return LABS_FLAGS.find((f) => f.id === id)!
}

export function labsEnvForced(flag: LabsFlag, env: NodeJS.ProcessEnv): boolean {
  return flag.envVar !== undefined && env[flag.envVar] === '1'
}

/** Env force over the stored row over the default, and off while the flag it needs is off. */
export function labsFlagOn(id: LabsFlagId, env: NodeJS.ProcessEnv, getSetting: SettingReader): boolean {
  const flag = labsFlag(id)
  if (flag.needs && !labsFlagOn(flag.needs, env, getSetting)) return false
  return flag.defaultOn || labsEnvForced(flag, env) || getSetting(flag.setting) === 'true'
}

export interface LabsFlagState {
  id: LabsFlagId
  /** The env var is `1`: the row cannot be switched until Switchboard restarts without it. */
  forced: boolean
  on: boolean
}

export function labsFlagStates(env: NodeJS.ProcessEnv, getSetting: SettingReader): LabsFlagState[] {
  return LABS_FLAGS.map((f) => ({ id: f.id, forced: labsEnvForced(f, env), on: labsFlagOn(f.id, env, getSetting) }))
}

/** The capabilities of the flags that are on now; `readyCapabilities` adds them to the fixed set. */
export function labsFlagCapabilities(env: NodeJS.ProcessEnv, getSetting: SettingReader): string[] {
  return LABS_FLAGS.filter((f) => f.capability && labsFlagOn(f.id, env, getSetting)).map((f) => f.capability!)
}
