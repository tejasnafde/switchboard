import {
  decodeTurnAcceptance,
  freezePreparedTurn,
  type AcceptanceDisposition,
  type QueuedMessage,
} from './outboxModel'

export interface QueuedTurnDeliveryPort {
  prepare(message: QueuedMessage): Promise<{ pending: boolean; wireMessage: string }>
  persist(message: QueuedMessage): Promise<void>
  send(message: QueuedMessage): Promise<unknown>
}

export interface QueuedTurnDeliveryResult {
  disposition: AcceptanceDisposition
  retryable: boolean
  reason?: string
  message: QueuedMessage
}

export async function submitQueuedTurn(
  message: QueuedMessage,
  port: QueuedTurnDeliveryPort,
): Promise<QueuedTurnDeliveryResult> {
  let prepared = message
  if (prepared.providerText === undefined) {
    prepared = freezePreparedTurn(prepared, await port.prepare(prepared))
    await port.persist(prepared)
  }
  const acceptance = await port.send(prepared)
  return { ...decodeTurnAcceptance(acceptance), message: prepared }
}
