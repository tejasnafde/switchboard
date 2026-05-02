/**
 * Onboarding tour registry.
 *
 * Single source of truth for the "what's new" / first-run feature tour.
 * Each entry corresponds to:
 *   - one HTML scene at `videos/scenes/<id>/index.html`  (hand-authored)
 *   - one MP4 at `videos/dist/<id>.mp4`                   (rendered by HyperFrames)
 *
 * The renderer streams MP4s via the `sb-tour://<id>.mp4` custom protocol
 * registered in main (see ipc/app.ts). Missing MP4s degrade gracefully
 * — the modal renders the description without video — so we can ship
 * the wiring before every clip is in the can.
 *
 * `tourVersion` bumps trigger auto-open on next launch (compared against
 * `tour.lastSeenVersion` in settings). Bump it whenever you add a new
 * step or rerecord a clip you want existing users to see.
 */

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
  | { kind: 'open-settings'; tab: 'general' | 'providers' | 'workspaces' | 'archived' | 'tour' | 'about' }
  | { kind: 'noop' }

/**
 * Bump when the tour list changes meaningfully. Auto-open fires on the
 * next launch for any user whose `tour.lastSeenVersion` is older.
 */
export const TOUR_VERSION = '2026-05-02'

export const FEATURE_TOUR_STEPS: FeatureTourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Switchboard',
    description:
      'Terminals, AI agents, and project context in one window. Add a folder from the sidebar to get started — everything else flows from there.',
  },
  {
    id: 'kanban-view',
    title: 'Two modes: Chats & Board',
    description:
      'Toggle the whole app between engineering view (chats + terminals + files) and PM view (a workspace-scoped kanban board). Click the segmented toggle in the title bar, or hit ⌘⇧K. Cards on the board double as chats — click ▶ to start a conversation rooted at the card’s worktree.',
  },
  {
    id: 'slash-menu',
    title: 'Slash commands & agent skills',
    description:
      'Type `/` in any chat to switch runtime mode, archive, clear, or invoke an agent-defined skill. Claude SDK commands and Codex skills appear inline alongside Switchboard built-ins.',
    tryIt: { kind: 'focus-chat-with-slash' },
  },
  {
    id: 'plan-mode',
    title: 'Plan mode & runtime modes',
    description:
      'Plan mode locks the agent to read-only tools. Sandbox prompts before writes. Accept-edits and Full-access skip the prompts. Block events render as a red denial pill in chat.',
  },
  {
    id: 'panes',
    title: 'Multi-pane terminals & chat',
    description:
      'Split any pane horizontally or vertically — terminals and chats live in the same tmux-style tree. Drag the handle to resize, ⌘W closes the focused pane.',
  },
  {
    id: 'file-viewer-context',
    title: 'File viewer & context bridge',
    description:
      '⌘⇧E flips the right pane to a file tree + viewer with Shiki highlighting and markdown preview. ⌘P fuzzy-finds any file, ⌘L pipes terminal/file selections straight into the chat draft.',
  },
  {
    id: 'terminal-templates',
    title: 'Named terminal templates',
    description:
      'Save the current terminal layout as a template, star your favorite, and apply it to any new chat. Templates live in workspace.yaml so they sync across machines via git.',
  },
  {
    id: 'workspace-config',
    title: 'Workspace orchestration',
    description:
      'Drop a .switchboard/workspace.yaml into any project to declare terminals, define startup commands, and orchestrate wait-then launch chains. Live edits hot-reload the layout instantly.',
  },
  {
    id: 'switch-agent',
    title: 'Switch agents on the fly',
    description:
      'Use the agent dropdown in any chat to swap between Claude Code, Codex, and OpenCode mid-session. The status bar and model picker update in lockstep.',
  },
  {
    id: 'resume-search',
    title: 'Session resume & full-text search',
    description:
      'Past sessions live in the sidebar — click to resume any thread. ⌘⇧F searches every message across every project; click a result to jump straight to it.',
    tryIt: { kind: 'open-search' },
  },
  {
    id: 'workspaces',
    title: 'Sidebar workspaces',
    description:
      'Group projects under named, color-tagged workspaces — Work, Personal, side quests. Filter the whole tree by chat title with the new search input. Collapse state persists across launches.',
  },
]
