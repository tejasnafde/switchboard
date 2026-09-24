/**
 * Turning a notification payload into a Thread route.
 *
 * Pure and free of react-native imports so it can be tested in node. The
 * backend fills this payload in src/main/push/registry.ts.
 */

export interface ThreadRoute {
  connectionId: string
  threadId: string
  title: string
  projectPath: string
  isNew: false
}

/**
 * The route a tap should open, or null when the payload cannot address one.
 *
 * `clientRef` is the id this device used when registering, echoed back by the
 * backend - without it there is no way to know WHICH paired backend sent the
 * notification, so there is nothing safe to open. Devices registered before
 * clientRef existed fall into that case and are ignored rather than guessed at.
 */
export function threadRouteFromPush(data: unknown): ThreadRoute | null {
  if (data === null || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const threadId = typeof d.threadId === 'string' ? d.threadId : ''
  const connectionId = typeof d.clientRef === 'string' ? d.clientRef : ''
  if (!threadId || !connectionId) return null
  return {
    connectionId,
    threadId,
    // The thread screen requires a title; it reloads the real one on open.
    title: typeof d.title === 'string' && d.title.length > 0 ? d.title : 'Conversation',
    // An empty path still opens: ThreadScreen resolves the real cwd from meta.
    projectPath: typeof d.projectPath === 'string' ? d.projectPath : '',
    isNew: false,
  }
}
