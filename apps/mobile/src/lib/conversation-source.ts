import { agentShortLabel, isAgentType } from '@shared/types'

export function conversationSourceLabel(row: {
  agent_type: string
  origin_source?: string | null
}): string {
  if (row.origin_source === 'cursor') return 'Cursor'
  return isAgentType(row.agent_type) ? agentShortLabel(row.agent_type) : row.agent_type
}
