import type { ChildState } from '@shared/hub'

/** The `.sidebar-recent-dot` colour of a child state, shared by the sidebar rows and the children strip. */
export function childDot(state: ChildState): 'needs-you' | 'working' | 'finished' | 'limited' | 'idle' {
  switch (state) {
    case 'needs_you':
    case 'asked_hub':
    case 'blocked':
    case 'failed':
      return 'needs-you'
    case 'working':
    case 'starting':
      return 'working'
    case 'result_ready':
    case 'settled':
      return 'finished'
    case 'limited':
      return 'limited'
    case 'paused':
      return 'idle'
  }
}
