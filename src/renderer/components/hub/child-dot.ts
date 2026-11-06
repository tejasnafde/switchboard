import type { ChildState, HubChildView } from '@shared/hub'

type ChildDot = 'needs-you' | 'working' | 'finished' | 'limited' | 'idle'

/** The `.sidebar-recent-dot` colour of a child state, shared by the sidebar rows and the header's children list. */
export function childDot(state: ChildState): ChildDot {
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

/** A child's dot: Unknown while its machine is not connected and no Stop waits, else its state's. */
export function hubChildDot(c: Pick<HubChildView, 'state' | 'remote'>): ChildDot | 'unknown' {
  return c.remote && !c.remote.connected && !c.remote.stopping ? 'unknown' : childDot(c.state)
}

/** The dot of the header's Hub chip: the most urgent of its children's, so the chip alone says where the hub stands. */
export function hubChipDot(children: ReadonlyArray<Pick<HubChildView, 'state' | 'remote'>>): ChildDot | 'unknown' {
  const dots = new Set(children.map(hubChildDot))
  for (const dot of ['needs-you', 'limited', 'working', 'unknown', 'finished'] as const) if (dots.has(dot)) return dot
  return 'idle'
}
