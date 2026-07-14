import { describe, it, expect } from 'vitest'
import {
  parseLaunchConfigFile,
  type LaunchConfigFile,
  type LaunchConfigTerminal,
} from '../../src/shared/launch-config'

describe('workspace config parser', () => {
  // ── Valid configs ─────────────────────────────────────────────

  it('parses minimal config with terminals array', () => {
    const yaml = `
terminals:
  - label: server
    cwd: "."
    on_start: "npm run dev"
`
    const config = parseLaunchConfigFile(yaml)
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
    const config = parseLaunchConfigFile(yaml)
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
    const config = parseLaunchConfigFile(yaml)
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
    const config = parseLaunchConfigFile(yaml)
    expect(config.terminals).toHaveLength(1)
    expect(config.terminals[0].label).toBe('shell')
    expect(config.terminals[0].cwd).toBeUndefined()
    expect(config.terminals[0].on_start).toBeUndefined()
  })

  // ── Edge cases ────────────────────────────────────────────────

  it('returns empty config for empty yaml', () => {
    const config = parseLaunchConfigFile('')
    expect(config.terminals).toEqual([])
    expect(config.rows).toBeUndefined()
  })

  it('returns empty config for yaml with no recognized keys', () => {
    const yaml = `
something_else: true
random: 42
`
    const config = parseLaunchConfigFile(yaml)
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
    const config = parseLaunchConfigFile(yaml)
    expect(config.terminals).toHaveLength(2)
    expect(config.terminals[0].label).toBe('valid')
    expect(config.terminals[1].label).toBe('also valid')
  })

  it('assigns default label when missing', () => {
    const yaml = `
terminals:
  - cwd: "/some/path"
`
    const config = parseLaunchConfigFile(yaml)
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
    expect(() => parseLaunchConfigFile(yaml)).toThrow()
  })

  it('returns empty config when terminals is not an array', () => {
    const yaml = `
terminals: "not an array"
`
    const config = parseLaunchConfigFile(yaml)
    expect(config.terminals).toEqual([])
  })

  // ── Serialization ─────────────────────────────────────────────

  it('serializeLaunchConfigFile produces valid yaml', async () => {
    const { serializeLaunchConfigFile } = await import('../../src/shared/launch-config')
    const config: LaunchConfigFile = {
      terminals: [
        { label: 'server', cwd: '.', on_start: 'npm run dev' },
        { label: 'test' },
      ],
    }
    const yaml = serializeLaunchConfigFile(config)
    // Round-trip
    const parsed = parseLaunchConfigFile(yaml)
    expect(parsed.terminals).toHaveLength(2)
    expect(parsed.terminals[0].label).toBe('server')
    expect(parsed.terminals[0].on_start).toBe('npm run dev')
    expect(parsed.terminals[1].label).toBe('test')
  })

  // ── Named configs (multi-template support) ─────────────────

  it('top-level terminals materialize as configs.default (back-compat)', () => {
    const yaml = `
terminals:
  - label: dev
    on_start: "npm run dev"
`
    const config = parseLaunchConfigFile(yaml)
    expect(config.configs).toBeDefined()
    expect(config.configs!.default).toBeDefined()
    expect(config.configs!.default.terminals).toHaveLength(1)
    expect(config.configs!.default.terminals[0].label).toBe('dev')
  })

  it('top-level rows materialize as configs.default (back-compat)', () => {
    const yaml = `
rows:
  - panes:
      - label: a
      - label: b
`
    const config = parseLaunchConfigFile(yaml)
    expect(config.configs!.default.rows).toBeDefined()
    expect(config.configs!.default.rows).toHaveLength(1)
    expect(config.configs!.default.rows![0].panes).toHaveLength(2)
  })

  it('parses configs: { name: { terminals } } block into named configs', () => {
    const yaml = `
configs:
  backend:
    terminals:
      - label: api
        cwd: services/api
      - label: db
        on_start: psql
  monitoring:
    terminals:
      - label: logs
        on_start: tail -f logs/app.log
`
    const config = parseLaunchConfigFile(yaml)
    expect(config.configs).toBeDefined()
    expect(Object.keys(config.configs!).sort()).toEqual(['backend', 'monitoring'])
    expect(config.configs!.backend.terminals).toHaveLength(2)
    expect(config.configs!.backend.terminals[0].label).toBe('api')
    expect(config.configs!.backend.terminals[0].cwd).toBe('services/api')
    expect(config.configs!.monitoring.terminals[0].on_start).toBe('tail -f logs/app.log')
  })

  it('parses configs with rows layout', () => {
    const yaml = `
configs:
  split:
    rows:
      - panes:
          - label: top
      - panes:
          - label: bottom-left
          - label: bottom-right
`
    const config = parseLaunchConfigFile(yaml)
    expect(config.configs!.split.rows).toHaveLength(2)
    expect(config.configs!.split.rows![1].panes).toHaveLength(2)
  })

  it('mixes top-level (default) with named configs', () => {
    const yaml = `
terminals:
  - label: shell
configs:
  backend:
    terminals:
      - label: api
`
    const config = parseLaunchConfigFile(yaml)
    expect(config.configs!.default.terminals[0].label).toBe('shell')
    expect(config.configs!.backend.terminals[0].label).toBe('api')
  })

  it('serializes a multi-template config and round-trips', async () => {
    const { serializeLaunchConfigFile } = await import('../../src/shared/launch-config')
    const config: LaunchConfigFile = {
      terminals: [{ label: 'shell' }],
      configs: {
        default: { terminals: [{ label: 'shell' }] },
        backend: { terminals: [{ label: 'api', cwd: 'services/api' }] },
        monitoring: { terminals: [{ label: 'logs', on_start: 'tail -f logs/app.log' }] },
      },
    }
    const yaml = serializeLaunchConfigFile(config)
    const parsed = parseLaunchConfigFile(yaml)
    expect(Object.keys(parsed.configs!).sort()).toEqual(['backend', 'default', 'monitoring'])
    expect(parsed.configs!.backend.terminals[0].cwd).toBe('services/api')
    expect(parsed.configs!.monitoring.terminals[0].on_start).toBe('tail -f logs/app.log')
  })

  it('skips invalid template entries (non-object) gracefully', () => {
    const yaml = `
configs:
  good:
    terminals:
      - label: a
  bad: "not an object"
  alsobad: 42
`
    const config = parseLaunchConfigFile(yaml)
    expect(Object.keys(config.configs!)).toEqual(['good'])
  })

  // ── Back-compat: pre-rename `templates:` key still parses ─────
  it('accepts the legacy `templates:` key as an alias for `configs:`', () => {
    const yaml = `
templates:
  default:
    terminals:
      - label: shell
  backend:
    terminals:
      - label: api
        cwd: services/api
`
    const config = parseLaunchConfigFile(yaml)
    expect(Object.keys(config.configs!).sort()).toEqual(['backend', 'default'])
    expect(config.configs!.default.terminals[0].label).toBe('shell')
    expect(config.configs!.backend.terminals[0].cwd).toBe('services/api')
  })
})
