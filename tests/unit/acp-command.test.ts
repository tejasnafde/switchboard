import { describe, expect, it } from 'vitest'
import { accountStartMode, acpCommandConfig, splitCommandArgs } from '../../src/shared/acp-command'

describe('acpCommandConfig', () => {
  it('reads a launch config and treats a blank folder as the chat folder', () => {
    expect(acpCommandConfig({ launch: { command: ' kestrel-acp ', args: ['acp'], cwd: '  ' } })).toEqual({
      command: 'kestrel-acp',
      args: ['acp'],
      cwd: null,
    })
    expect(acpCommandConfig({ launch: { command: '/bin/agent', args: [], cwd: '~/work' } })?.cwd).toBe('~/work')
  })

  it('refuses anything it could not run as given', () => {
    for (const bad of [
      null,
      {},
      { launch: null },
      { launch: { command: '', args: [] } },
      { launch: { command: 'a\nb', args: [] } },
      { launch: { command: 'agent' } },
      { launch: { command: 'agent', args: [1] } },
      { launch: { command: 'agent', args: [], cwd: 3 } },
    ]) {
      expect(acpCommandConfig(bad)).toBeNull()
    }
  })
})

describe('splitCommandArgs', () => {
  it('splits on whitespace and keeps quoted groups and escapes', () => {
    expect(splitCommandArgs('acp --log-level warn')).toEqual(['acp', '--log-level', 'warn'])
    expect(splitCommandArgs(`--name "two words" 'it''s' a\\ b ""`)).toEqual(['--name', 'two words', 'its', 'a b', ''])
    expect(splitCommandArgs('  ')).toEqual([])
  })

  it('expands nothing', () => {
    expect(splitCommandArgs('$HOME ~/x *.ts')).toEqual(['$HOME', '~/x', '*.ts'])
  })

  it('refuses an open quote', () => {
    expect(splitCommandArgs('--name "open')).toBeNull()
  })
})

describe('accountStartMode', () => {
  it('reads a valid stored mode only', () => {
    expect(accountStartMode({ startMode: 'plan' })).toBe('plan')
    expect(accountStartMode({ startMode: 'yolo' })).toBeNull()
    expect(accountStartMode(null)).toBeNull()
  })
})
