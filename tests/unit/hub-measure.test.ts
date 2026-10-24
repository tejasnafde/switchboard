import { describe, expect, it } from 'vitest'
import { HubResourceSampler, parsePs, treeUsage } from '../../src/main/hub/hub-measure'
import { parseHubTasks } from '../../src/shared/hub'

const PS = `
    1     0   1000   0.0
  100     1  20000  10.5
  101   100  30000   5.0
  102   101   4000   1.0
  200     1   8000   2.0
garbage line
`

describe('hub resource measures', () => {
  it('sums a process tree and ignores other trees', () => {
    const rows = parsePs(PS)
    expect(rows).toHaveLength(5)
    expect(treeUsage(rows, 100)).toEqual({ rssBytes: 54000 * 1024, cpuPct: 16.5, processes: 3 })
    expect(treeUsage(rows, 999)).toBeNull()
  })

  it('samples each open child, and totals its parent', async () => {
    const sampler = new HubResourceSampler({
      targets: () => [{ childId: 'c1', parentId: 'p1' }],
      agentPid: (id) => (id === 'c1' ? 100 : id === 'p1' ? 200 : null),
      ps: async () => PS,
      now: () => 5,
    })
    await sampler.tick()
    expect(sampler.resourcesOf('c1')).toMatchObject({ processes: 3, at: 5 })
    expect(sampler.resourcesOf('p1')).toMatchObject({ rssBytes: 8000 * 1024 })
  })
})

describe('parseHubTasks', () => {
  it('takes valid tasks and refuses bad ones with a reason', () => {
    expect(parseHubTasks([{ title: 'A', brief: 'b', agent: 'claude' }])).toEqual({
      ok: true,
      tasks: [{ title: 'A', brief: 'b', location: 'worktree', agent: 'claude-code' }],
    })
    expect(parseHubTasks([])).toMatchObject({ ok: false })
    expect(parseHubTasks(Array(9).fill({ title: 'A', brief: 'b' }))).toMatchObject({ ok: false })
    expect(parseHubTasks([{ title: 'A', brief: 'b', agent: 'nope' }])).toMatchObject({ ok: false })
    expect(parseHubTasks([{ title: 'A', brief: 'b', branch: 'a b' }])).toMatchObject({ ok: false })
    expect(parseHubTasks([{ title: 'A', brief: 'b', mode: 'root' }])).toMatchObject({ ok: false })
  })
})
