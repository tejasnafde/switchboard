import { describe, it, expect } from 'vitest'
import {
  parseWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceTerminal,
} from '../../src/shared/workspace-config'

describe('workspace config parser', () => {
  // ── Valid configs ─────────────────────────────────────────────

  it('parses minimal config with terminals array', () => {
    const yaml = `
terminals:
  - label: server
    cwd: "."
    on_start: "npm run dev"
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.terminals).toHaveLength(1)
    expect(config.terminals[0].label).toBe('server')
    expect(config.terminals[0].cwd).toBe('.')
    expect(config.terminals[0].on_start).toBe('npm run dev')
  })

  it('parses multiple terminals', () => {
    const yaml = `
terminals:
  - label: frontend
    cwd: "./frontend"
    on_start: "npm start"
  - label: backend
    cwd: "./backend"
    on_start: "go run ."
  - label: logs
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.terminals).toHaveLength(3)
    expect(config.terminals[0].label).toBe('frontend')
    expect(config.terminals[1].cwd).toBe('./backend')
    expect(config.terminals[2].label).toBe('logs')
    expect(config.terminals[2].cwd).toBeUndefined()
    expect(config.terminals[2].on_start).toBeUndefined()
  })

  it('parses config with rows layout', () => {
    const yaml = `
rows:
  - panes:
      - label: server
        cwd: "."
        on_start: "npm run dev"
      - label: test
        on_start: "npm test --watch"
  - panes:
      - label: logs
        on_start: "tail -f logs/app.log"
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.rows).toBeDefined()
    expect(config.rows).toHaveLength(2)
    expect(config.rows![0].panes).toHaveLength(2)
    expect(config.rows![0].panes[0].label).toBe('server')
    expect(config.rows![1].panes).toHaveLength(1)
    expect(config.rows![1].panes[0].label).toBe('logs')
    // When rows is present, terminals should be derived from rows
    expect(config.terminals).toHaveLength(3)
  })

  it('terminal with only label is valid (defaults)', () => {
    const yaml = `
terminals:
  - label: shell
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.terminals).toHaveLength(1)
    expect(config.terminals[0].label).toBe('shell')
    expect(config.terminals[0].cwd).toBeUndefined()
    expect(config.terminals[0].on_start).toBeUndefined()
  })

  // ── Edge cases ────────────────────────────────────────────────

  it('returns empty config for empty yaml', () => {
    const config = parseWorkspaceConfig('')
    expect(config.terminals).toEqual([])
    expect(config.rows).toBeUndefined()
  })

  it('returns empty config for yaml with no recognized keys', () => {
    const yaml = `
something_else: true
random: 42
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.terminals).toEqual([])
  })

  it('skips invalid terminal entries (non-objects)', () => {
    const yaml = `
terminals:
  - label: valid
  - "just a string"
  - 42
  - label: also valid
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.terminals).toHaveLength(2)
    expect(config.terminals[0].label).toBe('valid')
    expect(config.terminals[1].label).toBe('also valid')
  })

  it('assigns default label when missing', () => {
    const yaml = `
terminals:
  - cwd: "/some/path"
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.terminals).toHaveLength(1)
    expect(config.terminals[0].label).toBe('Terminal 1')
  })

  // ── Invalid input ─────────────────────────────────────────────

  it('throws on invalid YAML syntax', () => {
    const yaml = `
terminals:
  - label: "unclosed
    [invalid yaml
`
    expect(() => parseWorkspaceConfig(yaml)).toThrow()
  })

  it('returns empty config when terminals is not an array', () => {
    const yaml = `
terminals: "not an array"
`
    const config = parseWorkspaceConfig(yaml)
    expect(config.terminals).toEqual([])
  })

  // ── Serialization ─────────────────────────────────────────────

  it('serializeWorkspaceConfig produces valid yaml', async () => {
    const { serializeWorkspaceConfig } = await import('../../src/shared/workspace-config')
    const config: WorkspaceConfig = {
      terminals: [
        { label: 'server', cwd: '.', on_start: 'npm run dev' },
        { label: 'test' },
      ],
    }
    const yaml = serializeWorkspaceConfig(config)
    // Round-trip
    const parsed = parseWorkspaceConfig(yaml)
    expect(parsed.terminals).toHaveLength(2)
    expect(parsed.terminals[0].label).toBe('server')
    expect(parsed.terminals[0].on_start).toBe('npm run dev')
    expect(parsed.terminals[1].label).toBe('test')
  })
})
