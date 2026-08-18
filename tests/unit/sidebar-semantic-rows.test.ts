import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sidebarSource = readFileSync(
  resolve(__dirname, '../../src/renderer/components/sidebar/Sidebar.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')
const machineLayerSource = readFileSync(
  resolve(__dirname, '../../src/renderer/components/sidebar/MachineLayer.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('sidebar conversation row semantics', () => {
  it('uses a native button as the primary local conversation action', () => {
    expect(sidebarSource).toContain('className="sidebar-thread-main"')
    const wrapperStart = sidebarSource.indexOf('<div\n                    key={s.id}')
    const wrapperOpenEnd = sidebarSource.indexOf('>', wrapperStart)
    const mainButtonStart = sidebarSource.indexOf('className="sidebar-thread-main"', wrapperStart)
    expect(wrapperStart).toBeGreaterThan(-1)
    expect(wrapperOpenEnd).toBeGreaterThan(wrapperStart)
    expect(mainButtonStart).toBeGreaterThan(wrapperStart)
    expect(sidebarSource.slice(wrapperStart, wrapperOpenEnd)).not.toContain('onClick=')
  })

  it('uses native controls for local hierarchy disclosure', () => {
    expect(sidebarSource).toContain('className="sidebar-project-toggle"')
    expect(sidebarSource).toMatch(/<button\s+type="button"\s+className="sidebar-workspace-header"/)
  })

  it('uses native controls for remote hierarchy and conversations', () => {
    expect(machineLayerSource).toContain('className="sidebar-project-toggle"')
    expect(machineLayerSource).toContain('className="sidebar-thread-main"')
    expect(machineLayerSource).toContain('className="sidebar-machine-toggle"')
    expect(machineLayerSource).not.toContain('<div className="sidebar-project-header" onClick=')
  })

  it('does not use decorative status dots for normal navigation state', () => {
    expect(sidebarSource).not.toContain('sidebar-thread-dot')
    expect(machineLayerSource).not.toContain('sidebar-thread-dot')
    expect(machineLayerSource).not.toContain('PIP_COLOR')
  })

  it('opens Saved from the Threads header instead of an inline disclosure section', () => {
    expect(sidebarSource).toContain('aria-label="Open saved messages"')
    expect(sidebarSource).toContain('aria-label="Back to threads"')
    expect(sidebarSource).not.toContain('savedOpen')
  })
})
