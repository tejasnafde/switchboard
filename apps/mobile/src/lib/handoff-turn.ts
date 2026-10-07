import { buildHandoffPreamble, type HandoffSourceMessage } from '@shared/handoff'

interface HandoffClient {
  getPendingHandoff(threadId: string): Promise<{ from: string | null; backendBuilds?: boolean }>
  loadSessionById(threadId: string): Promise<{ messages: HandoffSourceMessage[] }>
}

/**
 * An older backend leaves a pending handoff to the client: prefix the turn
 * with it, and the outbox clears the flag after acceptance. A backend that
 * builds it (`backendBuilds`) gets the turn as typed.
 */
export async function prepareMobileHandoffTurn(
  client: HandoffClient,
  threadId: string,
  message: string,
): Promise<{ pending: boolean; wireMessage: string }> {
  const { from, backendBuilds } = await client.getPendingHandoff(threadId)
  if (!from || backendBuilds) return { pending: false, wireMessage: message }

  const { messages } = await client.loadSessionById(threadId)
  const preamble = buildHandoffPreamble(messages)
  return {
    pending: true,
    wireMessage: preamble ? `${preamble}\n\n${message}` : message,
  }
}
