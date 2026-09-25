/**
 * Every page and every row of the Settings page, as data.
 *
 * The pages render their rows from these definitions (label, description,
 * default), and search reads the same list, so a row cannot exist on a page
 * without being searchable, or be found under a label the page does not show.
 * Pure so the search and the changed-count rules are unit-tested.
 */
import { currentPlatform, shortcutLabel, shortcutsFor, type ShortcutPlatform } from '@shared/shortcuts'
import { DEFAULT_RECENT_SESSION_LIMIT } from '../sidebar/recent-session-limit'

export type SettingsPageId =
  | 'general'
  | 'appearance'
  | 'chat'
  | 'accounts'
  | 'projects'
  | 'keyboard'
  | 'devices'
  | 'data'
  | 'about'

export interface SettingsPage {
  id: SettingsPageId
  title: string
  description: string
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'general', title: 'General', description: 'How Switchboard behaves on this Mac.' },
  { id: 'appearance', title: 'Appearance', description: 'How the window looks.' },
  { id: 'chat', title: 'Chat & agents', description: 'Defaults for new and running chats.' },
  { id: 'accounts', title: 'Accounts & models', description: 'The accounts each agent signs in with, and how much of each one is used.' },
  { id: 'projects', title: 'Projects', description: 'Settings that belong to one project.' },
  { id: 'keyboard', title: 'Keyboard', description: 'Every shortcut, with the keys for this computer.' },
  { id: 'devices', title: 'Devices & machines', description: 'Phones paired with this Mac.' },
  { id: 'data', title: 'Archive & data', description: 'Archived chats.' },
  { id: 'about', title: 'About', description: 'A unified developer workspace that multiplexes terminals and agent chats.' },
]

export interface SettingRowDef {
  id: string
  page: SettingsPageId
  section: string
  label: string
  description?: string
  /** The value a row holds before the user changes it. Only rows that hold a value have one. */
  defaultValue?: string
  /** How the default reads in the UI, when the raw value does not ('dark' is Dark). */
  defaultLabel?: string
  /** A shortcut row's keys, shown and searched. */
  keys?: string
}

export const PRIVACY_POLICY_URL = 'https://tn07.dev/privacy'

const ROWS = {
  notifyTurnEnd: {
    id: 'notifications.turnEnd', page: 'general', section: 'Notifications',
    label: 'Notify when an agent finishes a turn',
    description: "Only fires when the app isn't focused or you're on a different chat.",
    defaultValue: 'true',
  },
  notifyTest: {
    id: 'notifications.test', page: 'general', section: 'Notifications',
    label: 'Send test notification',
    description: 'Checks that macOS lets Switchboard notifications through.',
  },
  updates: {
    id: 'updates.check', page: 'general', section: 'Updates',
    label: 'Update status',
    description: 'Check for a newer Switchboard, and restart to install one that has downloaded.',
  },
  recentLimit: {
    id: 'sidebar.recentLimit', page: 'general', section: 'Sidebar',
    label: 'Recent conversations',
    description: 'Rows shown before the Recents section offers Show more.',
    defaultValue: String(DEFAULT_RECENT_SESSION_LIMIT),
    defaultLabel: `${DEFAULT_RECENT_SESSION_LIMIT} conversations`,
  },
  ideIdleTtl: {
    id: 'ide.idleTtl', page: 'general', section: 'Embedded IDE',
    label: 'Shut down when hidden after',
    description: 'Idle minutes before the code-server workbench is killed to free CPU/RAM. Reopening (⌘⇧E) relaunches it in ~2s.',
    defaultValue: '5',
    defaultLabel: '5 minutes',
  },
  analytics: {
    id: 'privacy.analytics', page: 'general', section: 'Privacy',
    label: 'Share anonymous usage counts',
    description: 'Sends launch, session, tour and crash counts with the app version, platform, chip and a random install id, never a path, name or message; one click here turns it off.',
    defaultValue: 'true',
  },
  theme: {
    id: 'appearance.theme', page: 'appearance', section: 'Theme',
    label: 'Theme',
    description: 'Translucent blurs the desktop behind the window (macOS). System follows the macOS light or dark appearance.',
    defaultValue: 'dark',
    defaultLabel: 'Dark',
  },
  followUp: {
    id: 'chat.followUp', page: 'chat', section: 'While the agent works',
    label: 'Follow-up while the agent works',
    description: 'What Enter does with a message sent mid-turn. Steer hands it to the agent at its next step; Queue holds it until the turn ends. ⌥Enter does the other one. OpenCode always queues.',
    defaultValue: 'steer',
    defaultLabel: 'Steer',
  },
  streaming: {
    id: 'chat.streaming', page: 'chat', section: 'While the agent works',
    label: 'Stream assistant messages',
    description: 'Show token-by-token output while a response is in progress. Off renders the final reply in one shot when the turn completes.',
    defaultValue: 'true',
  },
  envMode: {
    id: 'chat.envMode', page: 'chat', section: 'Defaults for new chats',
    label: 'Recommended workspace',
    description: "Which option is highlighted first. You still choose for every new thread. Local runs the agent in the project root; New worktree creates a fresh git worktree off HEAD so parallel threads don't trample each other.",
    defaultValue: 'local',
    defaultLabel: 'Local (project root)',
  },
  fileDiffs: {
    id: 'chat.fileDiffs', page: 'chat', section: 'In the chat',
    label: 'Show file diff cards in chat',
    description: 'Show per-file diffs inline after each turn. Off shows a "Changed N files" button that expands them for that turn only.',
    defaultValue: 'false',
  },
  providers: {
    id: 'accounts.instances', page: 'accounts', section: 'Accounts',
    label: 'Provider accounts',
    description: 'Named credential sets for Claude Code, Codex and OpenCode, their default models, and each account\'s usage limits.',
  },
  launchConfigs: {
    id: 'projects.launchConfigs', page: 'projects', section: 'Launch configs',
    label: 'Project launch configs',
    description: 'The terminals a chat in each project opens with, and the worktree setup command.',
  },
  mobile: {
    id: 'devices.mobile', page: 'devices', section: 'Mobile pairing',
    label: 'Mobile pairing',
    description: 'Pair a phone by QR code, revoke paired devices, and connect the Google account phones use for IAP.',
  },
  archived: {
    id: 'data.archived', page: 'data', section: 'Archived conversations',
    label: 'Archived conversations',
    description: 'Search and unarchive the chats you archived from the sidebar.',
  },
  about: {
    id: 'about.app', page: 'about', section: 'Switchboard',
    label: 'Switchboard',
    description: 'Built with Electron + React + TypeScript + Love',
  },
  tourReplay: {
    id: 'about.tourReplay', page: 'about', section: 'Feature tour',
    label: 'Replay the feature tour',
    description: "A short, replayable walk-through of what's shipped. Auto-opens on first launch after a release adds new features.",
  },
  tourAutoplay: {
    id: 'about.tourAutoplay', page: 'about', section: 'Feature tour',
    label: 'Auto-open the tour after a release adds new features',
    defaultValue: 'true',
  },
  tourSteps: {
    id: 'about.tourSteps', page: 'about', section: 'Feature tour',
    label: 'Jump to a step',
    description: 'Play one clip of the tour.',
  },
  diagnostics: {
    id: 'about.diagnostics', page: 'about', section: 'Diagnostics',
    label: 'Diagnostics',
    description: 'Chip, OS, memory and the largest processes, with a report to copy and the logs folder.',
  },
} satisfies Record<string, SettingRowDef>

export const SETTING_ROW: { readonly [K in keyof typeof ROWS]: SettingRowDef } = ROWS

/**
 * One read-only row per command in the shortcut registry, sectioned by its
 * group, labelled with this platform's keys. Rebinding comes later.
 */
export function shortcutRows(platform: ShortcutPlatform = currentPlatform()): SettingRowDef[] {
  return shortcutsFor(platform).map((c) => ({
    id: `keyboard.${c.id}`,
    page: 'keyboard',
    section: c.group,
    label: c.label,
    keys: shortcutLabel(c.id, platform),
  }))
}

/** The search index: every row above plus one per shortcut, in page order. */
export const SETTING_ROWS: readonly SettingRowDef[] = (() => {
  const rows: SettingRowDef[] = [...Object.values(ROWS), ...shortcutRows()]
  const order = SETTINGS_PAGES.map((p) => p.id)
  return rows.sort((a, b) => order.indexOf(a.page) - order.indexOf(b.page))
})()

export function pageTitle(id: SettingsPageId): string {
  return SETTINGS_PAGES.find((p) => p.id === id)?.title ?? id
}

/**
 * Rows matching every whitespace-separated term of `query`, case-insensitive,
 * across the label, description, section, page title and keys. Empty query,
 * no results: the page shows its own content instead.
 */
export function searchSettingRows(query: string, rows: readonly SettingRowDef[] = SETTING_ROWS): SettingRowDef[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  return rows.filter((row) => {
    const haystack = [row.label, row.description, row.section, pageTitle(row.page), row.keys]
      .filter(Boolean).join(' ').toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/** The default as the user sees it, for the Changed tooltip. */
export function defaultValueLabel(row: SettingRowDef): string {
  if (row.defaultLabel) return row.defaultLabel
  if (row.defaultValue === 'true') return 'On'
  if (row.defaultValue === 'false') return 'Off'
  return row.defaultValue ?? ''
}

/** A row is changed once its loaded value differs from its default. */
export function isSettingChanged(row: SettingRowDef, values: Readonly<Record<string, string>>): boolean {
  const value = values[row.id]
  return row.defaultValue !== undefined && value !== undefined && value !== row.defaultValue
}

export function changedCountByPage(
  values: Readonly<Record<string, string>>,
  rows: readonly SettingRowDef[] = SETTING_ROWS,
): Record<SettingsPageId, number> {
  const counts = Object.fromEntries(SETTINGS_PAGES.map((p) => [p.id, 0])) as Record<SettingsPageId, number>
  for (const row of rows) if (isSettingChanged(row, values)) counts[row.page] += 1
  return counts
}
