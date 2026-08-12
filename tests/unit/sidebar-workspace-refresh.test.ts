import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/components/sidebar/Sidebar.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('workspace mutation refresh', () => {
  it('reloads projects through the ordering-aware loader', () => {
    const manager = source.slice(
      source.indexOf('{managerOpen && ('),
      source.indexOf('{(addMachineOpen || editMachine)'),
    )

    expect(manager).toContain('void loadProjects()')
    expect(manager).not.toContain('window.api.app.getProjects()')
  })
})
