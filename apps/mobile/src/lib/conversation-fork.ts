import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import {
  buildForkConversationRequest,
  canonicalizeForkMessage,
  type ForkConversationRequest,
} from '@shared/conversation-fork'
import type { ChatMessage } from '@shared/types'

const PREFIX = 'sb.conversation-fork.v1:'

function intentKey(input: {
  connectionId: string
  sourceConversationId: string
  messageId: string
  withWorktree: boolean
}): string {
  const kind = input.withWorktree ? 'new-worktree' : 'shared-checkout'
  return `${PREFIX}${input.connectionId}:${input.sourceConversationId}:${input.messageId}:${kind}`
}

export async function mobileForkRequest(input: {
  connectionId: string
  sourceConversationId: string
  message: ChatMessage
  withWorktree: boolean
  requestedAt?: number
}): Promise<ForkConversationRequest> {
  const key = intentKey({ ...input, messageId: input.message.id })
  let requestId = await AsyncStorage.getItem(key)
  if (!requestId) {
    requestId = Crypto.randomUUID()
    await AsyncStorage.setItem(key, requestId)
  }
  const contentDigest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonicalizeForkMessage(input.message),
  )
  return buildForkConversationRequest({
    requestId,
    sourceConversationId: input.sourceConversationId,
    message: input.message,
    contentDigest,
    withWorktree: input.withWorktree,
    surface: 'react-native',
    requestedAt: input.requestedAt ?? Date.now(),
  })
}

export async function forgetMobileForkRequest(input: {
  connectionId: string
  sourceConversationId: string
  messageId: string
  withWorktree: boolean
}): Promise<void> {
  await AsyncStorage.removeItem(intentKey(input))
}
