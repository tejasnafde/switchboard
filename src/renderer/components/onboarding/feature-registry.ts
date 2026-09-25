/**
 * Onboarding tour registry.
 *
 * Single source of truth for the "what's new" / first-run feature tour.
 * Each entry corresponds to one MP4 at `videos/dist/<id>.mp4`, recorded from
 * the real app by `videos/capture-tour.mjs` (the scene id there must match).
 *
 * The renderer streams MP4s via the `sb-tour://<id>.mp4` custom protocol
 * registered in main (see ipc/app.ts). Missing MP4s degrade gracefully
 * - the modal renders the description without video - so we can ship
 * the wiring before every clip is in the can.
 *
 * `tourVersion` bumps trigger auto-open on next launch (compared against
 * `tour.lastSeenVersion` in settings). Bump it whenever you add a new
 * step or rerecord a clip you want existing users to see.
 */

import type { SettingsPageId } from '../settings/settings-rows'

export interface FeatureTourStep {
  /** Stable id; doubles as scene + mp4 filename. kebab-case. */
  id: string
  /** Bold heading shown above the video. */
  title: string
  /** 1–2 sentence body shown below the video. */
  description: string
  /**
   * Optional deep-link hint surfaced as a "Try it" pill. Renderer-side
   * handler interprets it (e.g. focus chat + insert "/").
   */
  tryIt?: TryItAction
}

export type TryItAction =
  | { kind: 'focus-chat-with-slash' }
  | { kind: 'open-search' }
  | { kind: 'open-settings'; page: SettingsPageId }
  | { kind: 'noop' }

/**
 * Bump when the tour list changes meaningfully. Auto-open fires on the
 * next launch for any user whose `tour.lastSeenVersion` is older.
 */
export const TOUR_VERSION = '2026-09-15'

export const FEATURE_TOUR_STEPS: FeatureTourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Switchboard',
    description:
      'Terminals, AI agents, and project context in one window. Add a folder from the sidebar to get started - everything else flows from there.',
  },
  {
    id: 'chats-and-board',
    title: 'Two views: Chats and Board',
    description:
      'Flip between the engineering view (chats, terminals, IDE) and a workspace-scoped kanban board with the Chats / Board toggle in the title bar, or ⌘⇧K. Cards double as chats: press ▶ to start a conversation rooted at the card\u2019s worktree.',
  },
  {
    id: 'slash-menu',
    title: 'Slash commands and agent skills',
    description:
      'Type `/` in any chat to switch runtime mode, archive, clear, or invoke an agent-defined skill. Claude Code commands and Codex skills appear inline next to Switchboard built-ins.',
    tryIt: { kind: 'focus-chat-with-slash' },
  },
  {
    id: 'runtime-modes',
    title: 'Runtime modes',
    description:
      'Pick a mode per chat from the composer. Plan Only locks the agent to read-only tools and renders every blocked write as a red denial pill. Sandbox asks before each tool. Accept Edits and Full Access skip the prompts.',
  },
  {
    id: 'panes',
    title: 'Terminals beside every chat',
    description:
      'Each chat owns a tmux-style terminal strip. ⌘T opens a window, ⌘⇧T a new row, ⌘\\ a tab; drag the handles to resize and ⌘W closes the focused pane. Panes start in the project folder.',
  },
  {
    id: 'dual-chat',
    title: 'Two chats side by side',
    description:
      'Open beside (⌘⇧\\) puts a second chat next to the first to compare agents or delegate. The highlighted chat owns the IDE, terminals and shortcuts; Copy prompt → other clones a draft while each send stays independent.',
  },
  {
    id: 'ide',
    title: 'Embedded IDE and context bridge',
    description:
      '⌘⇧E flips the right pane to a full VS Code workbench served locally. Click any file pill in a message to open it at that line; ⌘L inside the editor or a terminal sends the selection to the chat draft as context.',
  },
  {
    id: 'diff-review',
    title: 'Review every edit in chat',
    description:
      'After each turn, the files the agent changed appear as diff cards in the conversation. Keep or reject per hunk; the working tree updates on the spot.',
  },
  {
    id: 'launch-config',
    title: 'Named launch configs',
    description:
      'Declare terminals and startup commands in .switchboard/launch-config.yaml under named configs. Switch the config for any chat from the terminal strip; edits to the file reload live and the file travels with the repo.',
  },
  {
    id: 'switch-agent',
    title: 'Switch agents per chat',
    description:
      'Pick Claude Code, Codex, or OpenCode for any chat, along with a named credential profile and model. The status bar and model list follow. Switching hands the new agent a bounded summary of the conversation so far.',
  },
  {
    id: 'resume-search',
    title: 'Session resume and full-text search',
    description:
      'Past sessions live in the sidebar - click to resume any thread. ⌘⇧F searches every message across every project; pick a result to jump straight to it.',
    tryIt: { kind: 'open-search' },
  },
  {
    id: 'remote-machines',
    title: 'Remote machines (experimental)',
    description:
      'Run agents and terminals on another computer over SSH. Add a machine from the sidebar - Switchboard uses your existing SSH config, installs a small helper on first connect, and tunnels everything. Chats and terminals started under that machine run there.',
  },
  {
    id: 'workspaces',
    title: 'Sidebar workspaces',
    description:
      'Group projects under named, color-tagged workspaces - Work, Personal, side quests. Filter the whole tree by chat title from the search box. Collapse state persists across launches.',
  },
]
