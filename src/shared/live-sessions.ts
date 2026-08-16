/** What `provider:list-sessions` returns. Declared here, not imported from
 *  `main/provider/types`, because this crosses the transport. */
export interface LiveSessionSummary {
  threadId: string
  provider: string
  status: string
  runtimeMode: string
  cwd: string
  createdAt: number
  sessionId?: string
  model?: string
  instanceId?: string
  title?: string
}
