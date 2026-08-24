import { describe, expect, it } from 'vitest'
import {
  selectAvailableIapTargets,
  type SavedIapTarget,
} from '../../apps/mobile/src/lib/iapDiscovery'
import type { SshIapTarget } from '@shared/machines'

const discovered = (
  alias: string,
  project: string,
  zone: string,
  instance: string,
): SshIapTarget => ({ alias, project, zone, instance })

describe('selectAvailableIapTargets', () => {
  it('merges backend results and filters targets already saved on this phone', () => {
    const first = discovered('work-a', 'Project-A', 'asia-south1-b', 'vm-a')
    const duplicate = discovered('another-alias', ' project-a ', 'ASIA-SOUTH1-B', 'VM-A')
    const available = discovered('work-b', 'project-b', 'us-central1-a', 'vm-b')
    const saved: SavedIapTarget[] = [
      { project: 'project-a', zone: 'asia-south1-b', instance: 'vm-a' },
    ]

    expect(selectAvailableIapTargets([[first], [duplicate, available]], saved)).toEqual({
      available: [available],
      discoveredCount: 2,
      alreadyAddedCount: 1,
    })
  })

  it('distinguishes all-added results from no discovery results', () => {
    const target = discovered('work-a', 'project-a', 'zone-a', 'vm-a')
    expect(selectAvailableIapTargets([[target]], [target])).toEqual({
      available: [],
      discoveredCount: 1,
      alreadyAddedCount: 1,
    })
    expect(selectAvailableIapTargets([], [])).toEqual({
      available: [],
      discoveredCount: 0,
      alreadyAddedCount: 0,
    })
  })
})
