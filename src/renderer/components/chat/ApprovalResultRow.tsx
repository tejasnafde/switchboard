/**
 * What happened to an agent's approval card once it closed: posted (and where),
 * failed, declined, dismissed, withdrawn, or closed with the chat, and whether
 * the agent was told. The backend stores it as a system row; this is it.
 */
import { approvalResultLabel, type ApprovalResultRow as Row } from '@shared/agent-approval-cards'
import { cn } from '../../lib/utils'

export function ApprovalResultRow({ row, messageId }: { row: Row; messageId: string }) {
  const failed = row.outcome === 'failed'
  return (
    <div
      data-message-id={messageId}
      data-testid="approval-result-row"
      data-outcome={row.outcome}
      className="mx-4 my-2 rounded-[8px] border border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
    >
      <div className={cn('font-[600]', failed ? 'text-[var(--error)]' : 'text-[var(--text-primary)]')}>
        {approvalResultLabel(row)}
      </div>
      <div className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{row.text}</div>
    </div>
  )
}
