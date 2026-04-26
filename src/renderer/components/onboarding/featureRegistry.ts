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
export const TOUR_VERSION = '2026-04-26'

export const FEATURE_TOUR_STEPS: FeatureTourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Switchboard',
    description:
      'Terminals, AI agents, and project context in one window. Add a folder from the sidebar to get started — everything else flows from there.',
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
    id: 'resume-search',
    title: 'Session resume & full-text search',
    description:
      'Past sessions live in the sidebar — click to resume any thread. ⌘⇧F searches every message across every project; click a result to jump straight to it.',
    tryIt: { kind: 'open-search' },
  },
  {
    id: 'switch-agent',
    title: 'Switch agents on the fly',
    description:
      'Use the agent dropdown in any chat to swap between Claude Code, Codex, and OpenCode mid-session. The status bar and model picker update in lockstep.',
  },
]
