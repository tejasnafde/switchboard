import { describe, it, expect } from 'vitest'
import { applyProjectOrder } from '../../src/renderer/components/sidebar/sidebar-helpers'

const p = (path: string) => ({ path })

describe('applyProjectOrder', () => {
  it('sorts by the saved order, unknown paths keep relative order at the end', () => {
    const projects = [p('/a'), p('/b'), p('/c'), p('/new1'), p('/new2')]
    const out = applyProjectOrder(projects, ['/c', '/a'])
    expect(out.map((x) => x.path)).toEqual(['/c', '/a', '/b', '/new1', '/new2'])
  })

  it('null or empty order returns the input untouched', () => {
    const projects = [p('/b'), p('/a')]
    expect(applyProjectOrder(projects, null)).toBe(projects)
    expect(applyProjectOrder(projects, [])).toBe(projects)
  })

  it('non-array order (corrupt persisted setting) returns the input untouched', () => {
    const projects = [p('/b'), p('/a')]
    expect(applyProjectOrder(projects, 5 as unknown as string[])).toBe(projects)
    expect(applyProjectOrder(projects, {} as unknown as string[])).toBe(projects)
    expect(applyProjectOrder(projects, 'x' as unknown as string[])).toBe(projects)
  })

  it('order entries for removed projects are ignored', () => {
    const projects = [p('/b'), p('/a')]
    const out = applyProjectOrder(projects, ['/gone', '/a', '/b'])
    expect(out.map((x) => x.path)).toEqual(['/a', '/b'])
  })
})
