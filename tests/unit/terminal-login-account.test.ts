/**
 * Pure helpers backing the Terminal-tab "Account" list in
 * UnifiedProviderPicker.tsx: which instance to visibly highlight, and
 * when a previously-picked instance id must be dropped.
 *
 * Two confirmed bugs this pins:
 *  - The Account list highlighted `loginInstances[0]` (raw array/insertion
 *    order) whenever no explicit pick had been made, instead of mirroring
 *    main's `resolveProviderInstance` fallback order (canonical
 *    `${kind}-default` id first, then the oldest enabled instance). A
 *    non-default instance could show as active while main would actually
 *    spawn against the canonical default (or vice versa) - the visible
 *    account and the real credential home could disagree.
 *  - `termInstanceId` was never reset when the CLI binary (and therefore
 *    the login agent kind) changed, so a Codex instance id could get sent
 *    as the identity for a Claude login (or attached to a custom command),
 *    silently naming the wrong kind of instance.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveVisibleLoginInstanceId,
  nextTermInstanceId,
} from '../../src/renderer/shared/terminalLoginAccount'

function inst(id: string, createdAt: number) {
  return { id, createdAt }
}

describe('resolveVisibleLoginInstanceId', () => {
  it('highlights the explicitly requested id when it is present', () => {
    const instances = [inst('codex-default', 1), inst('codex-work', 2)]
    expect(resolveVisibleLoginInstanceId(instances, 'codex', 'codex-work')).toBe('codex-work')
  })

  it('falls back to the canonical default id when nothing was explicitly requested', () => {
    const instances = [inst('codex-work', 1), inst('codex-default', 2)]
    expect(resolveVisibleLoginInstanceId(instances, 'codex', undefined)).toBe('codex-default')
  })

  it('falls back to the oldest enabled instance when the canonical default is not in the list', () => {
    const instances = [inst('codex-newer', 5), inst('codex-older', 2)]
    expect(resolveVisibleLoginInstanceId(instances, 'codex', undefined)).toBe('codex-older')
  })

  it('ignores a requested id that is not in the (enabled, right-kind) instance list', () => {
    // e.g. a stale id left over from switching CLI binaries, or an instance
    // that was disabled out from under the open picker - never highlight a
    // row that doesn't actually exist in the list being rendered.
    const instances = [inst('codex-default', 1), inst('codex-work', 2)]
    expect(resolveVisibleLoginInstanceId(instances, 'codex', 'codex-ghost')).toBe('codex-default')
  })

  it('returns undefined when there are no candidate instances', () => {
    expect(resolveVisibleLoginInstanceId([], 'codex', undefined)).toBeUndefined()
  })
})

describe('nextTermInstanceId', () => {
  it('keeps the current id when the login agent kind is unchanged', () => {
    expect(nextTermInstanceId('codex', 'codex', 'codex-work')).toBe('codex-work')
  })

  it('resets to undefined when switching from one login kind to another', () => {
    expect(nextTermInstanceId('codex', 'claude-code', 'codex-work')).toBeUndefined()
  })

  it('resets to undefined when switching from a login kind to a custom command', () => {
    expect(nextTermInstanceId('codex', null, 'codex-work')).toBeUndefined()
  })

  it('resets to undefined when switching from a custom command to a login kind', () => {
    expect(nextTermInstanceId(null, 'claude-code', undefined)).toBeUndefined()
  })

  it('keeps undefined stable while the command stays custom (no login kind either side)', () => {
    expect(nextTermInstanceId(null, null, undefined)).toBeUndefined()
  })
})
