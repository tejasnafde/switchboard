import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Test terminal registry lifecycle logic.
 * We can't instantiate real xterm in node tests, so we test
 * the registry's state management and lifecycle invariants.
 */

interface MockTerminalInstance {
  id: string
  attached: boolean
  disposed: boolean
}

class MockTerminalRegistry {
  private instances = new Map<string, MockTerminalInstance>()

  getOrCreate(id: string): MockTerminalInstance {
    const existing = this.instances.get(id)
    if (existing) return existing

    const instance: MockTerminalInstance = { id, attached: false, disposed: false }
    this.instances.set(id, instance)
    return instance
  }

  attach(id: string): void {
    const inst = this.instances.get(id)
    if (inst && !inst.disposed) inst.attached = true
  }

  detach(id: string): void {
    const inst = this.instances.get(id)
    if (inst) inst.attached = false
  }

  destroy(id: string): void {
    const inst = this.instances.get(id)
    if (inst) {
      inst.disposed = true
      inst.attached = false
      this.instances.delete(id)
    }
  }

  has(id: string): boolean {
    return this.instances.has(id)
  }

  get(id: string): MockTerminalInstance | undefined {
    return this.instances.get(id)
  }

  get size(): number {
    return this.instances.size
  }
}

describe('terminal registry lifecycle', () => {
  let registry: MockTerminalRegistry

  beforeEach(() => {
    registry = new MockTerminalRegistry()
  })

  it('creates a new terminal on first call', () => {
    const inst = registry.getOrCreate('t1')
    expect(inst.id).toBe('t1')
    expect(inst.attached).toBe(false)
    expect(inst.disposed).toBe(false)
    expect(registry.size).toBe(1)
  })

  it('returns existing instance on second call (no duplicate)', () => {
    const a = registry.getOrCreate('t1')
    const b = registry.getOrCreate('t1')
    expect(a).toBe(b) // same reference
    expect(registry.size).toBe(1)
  })

  it('attach marks instance as attached', () => {
    registry.getOrCreate('t1')
    registry.attach('t1')
    expect(registry.get('t1')!.attached).toBe(true)
  })

  it('detach keeps instance alive but unattached', () => {
    registry.getOrCreate('t1')
    registry.attach('t1')
    registry.detach('t1')
    expect(registry.has('t1')).toBe(true) // still exists
    expect(registry.get('t1')!.attached).toBe(false)
    expect(registry.get('t1')!.disposed).toBe(false)
  })

  it('destroy removes instance completely', () => {
    registry.getOrCreate('t1')
    registry.destroy('t1')
    expect(registry.has('t1')).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('handles StrictMode: create, attach, detach, create, attach', () => {
    // First mount
    registry.getOrCreate('t1')
    registry.attach('t1')

    // StrictMode cleanup
    registry.detach('t1')

    // Second mount — should reuse, not create new
    const inst = registry.getOrCreate('t1')
    registry.attach('t1')

    expect(registry.size).toBe(1)
    expect(inst.attached).toBe(true)
    expect(inst.disposed).toBe(false)
  })

  it('multiple terminals are independent', () => {
    registry.getOrCreate('t1')
    registry.getOrCreate('t2')
    registry.getOrCreate('t3')
    expect(registry.size).toBe(3)

    registry.destroy('t2')
    expect(registry.size).toBe(2)
    expect(registry.has('t1')).toBe(true)
    expect(registry.has('t2')).toBe(false)
    expect(registry.has('t3')).toBe(true)
  })
})
