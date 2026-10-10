import { describe, expect, it } from 'vitest'
import { agentWrittenPaths, pathKey } from '../../src/main/provider/agent-written-paths'

/** What the function returns for these POSIX-style names on this platform (a drive letter on Windows). */
const keys = (...paths: string[]) => paths.map((p) => pathKey(p))

describe('agentWrittenPaths', () => {
  it('reads the path of each agent edit tool, against the session folder', () => {
    expect(agentWrittenPaths('Edit', { file_path: '/repo/a.ts' }, '/repo')).toEqual(keys('/repo/a.ts'))
    expect(agentWrittenPaths('Write', { file_path: 'src/b.ts' }, '/repo')).toEqual(keys('/repo/src/b.ts'))
    expect(agentWrittenPaths('NotebookEdit', { notebook_path: 'n.ipynb' }, '/repo')).toEqual(keys('/repo/n.ipynb'))
    expect(agentWrittenPaths('edit', { filePath: '/repo/c.ts' }, '/repo')).toEqual(keys('/repo/c.ts'))
    expect(agentWrittenPaths('Edit', { file_path: '/repo/old.ts', move_path: '/repo/new.ts' }, '/repo')).toEqual(
      keys('/repo/old.ts', '/repo/new.ts'),
    )
  })

  it('reads every file an apply_patch body names', () => {
    const patchText =
      '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** Delete File: c.ts\n*** End Patch'
    expect(agentWrittenPaths('patch', { patchText }, '/repo')).toEqual(keys('/repo/a.ts', '/repo/b.ts', '/repo/c.ts'))
  })

  it('names nothing for a tool that does not write', () => {
    expect(agentWrittenPaths('Read', { file_path: '/repo/a.ts' }, '/repo')).toEqual([])
    expect(agentWrittenPaths('Bash', { command: 'sed -i s/a/b/ a.ts' }, '/repo')).toEqual([])
    expect(agentWrittenPaths('Edit', null, '/repo')).toEqual([])
  })
})
