import { buildHandoffPreamble, type HandoffSourceMessage } from '@shared/handoff'

interface HandoffClient {
  getPendingHandoff(threadId: string): Promise<{ from: string | null }>
  loadSessionById(threadId: string): Promise<{ messages: HandoffSourceMessage[] }>
}

export async function prepareMobileHandoffTurn(
  client: HandoffClient,
  threadId: string,
  message: string,
): Promise<{ pending: boolean; wireMessage: string }> {
  const { from } = await client.getPendingHandoff(threadId)
  if (!from) return { pending: false, wireMessage: message }

  const { messages } = await client.loadSessionById(threadId)
  const preamble = buildHandoffPreamble(messages)
  return {
    pending: true,
    wireMessage: preamble ? `${preamble}\n\n${message}` : message,
  }
}
