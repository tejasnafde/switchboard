/**
 * Resolves which machine a renderer call targets, for the TransportRouter.
 *
 * Most calls carry their resource id as the first argument (a string threadId or
 * terminal id, or an options object with `threadId` / `id`); the renderer binds
 * that id to a machine when it creates the session or terminal, so subsequent
 * calls follow it. Create-style calls have no id yet, so they carry an explicit
 * `machineId` on the payload. Anything unbound or unknown stays local.
 */

/**
 * Priority when args[0] is an object: `threadId` and `conversationId` name a
 * chat session, `id` a generic resource (terminal, etc), and the path-shaped
 * keys (repoRoot / projectPath / workspaceRoot / cwd) let files/git/lsp/kanban
 * calls route by the project path a machine is bound to.
 */
const OBJECT_KEY_PRIORITY = ['threadId', 'conversationId', 'id', 'repoRoot', 'projectPath', 'workspaceRoot', 'cwd'] as const

/** Extract the routing key (resource id) from a call's args, or null. */
export function routingKey(args: unknown[]): string | null {
  const first = args[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object') {
    const o = first as Record<string, unknown>
    for (const key of OBJECT_KEY_PRIORITY) {
      if (typeof o[key] === 'string') return o[key] as string
    }
  }
  return null
}

export class RoutingTable {
  private readonly bindings = new Map<string, string>()

  bind(resourceId: string, machineId: string): void {
    if (machineId === 'local') this.bindings.delete(resourceId)
    else this.bindings.set(resourceId, machineId)
  }

  unbind(resourceId: string): void {
    this.bindings.delete(resourceId)
  }

  forgetMachine(machineId: string): void {
    for (const [id, m] of this.bindings) if (m === machineId) this.bindings.delete(id)
  }

  resolve(_channel: string, args: unknown[]): string {
    const first = args[0]
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).machineId === 'string') {
      return (first as Record<string, string>).machineId
    }
    const key = routingKey(args)
    return key ? (this.bindings.get(key) ?? 'local') : 'local'
  }
}
