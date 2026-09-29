/**
 * The Overview's Reviewers card: who reviews and where they are, plus, where
 * the host lets you (the author, or write / admin access), Add reviewer (a
 * combobox of recent reviewers of the repository, then members the token can
 * see) and Remove in each row's hover menu. The person being added or
 * removed shows as a pending row until the re-read PR has them (or not).
 */
import { useEffect, useMemo, useState } from 'react'
import { canRemoveReviewer, offeredReviewers } from '@shared/pull-request-writes'
import { repoKey, type PrDetail, type PrReviewer, type PrReviewerCandidate } from '@shared/pull-requests'
import { useReviewStore } from '../../stores/review-store'
import { Button } from '../ui/button'
import { Combobox, type ComboboxOption } from '../ui/combobox'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { writeErrorText } from './review-states'
import { Avatar, CardRow, Icon, SideCard } from './review-ui'
import { useWriteAction, WriteError } from './review-writes'

const REVIEW_LABEL: Record<PrReviewer['state'], { text: string; color?: string }> = {
  approved: { text: 'Approved', color: 'var(--success)' },
  changes_requested: { text: 'Changes requested', color: 'var(--warning)' },
  commented: { text: 'Commented' },
  dismissed: { text: 'Dismissed' },
  pending: { text: 'Review requested' },
}

function candidateHint(c: PrReviewerCandidate, owner: string): string {
  if (c.reviewed > 0) return `reviewed ${c.reviewed} ${c.reviewed === 1 ? 'PR' : 'PRs'} here`
  return c.kind === 'team' ? 'team' : `in ${owner}`
}

export function ReviewersCard({ pr }: { pr: PrDetail }) {
  const manage = pr.state === 'open' && pr.viewerCanManage
  const write = useWriteAction(pr.ref)
  const approvals = pr.approvals.required !== null && pr.approvals.required > 0
    ? `${pr.approvals.given} of ${pr.approvals.required}`
    : `${pr.approvals.given} approved`
  // Who the write in flight is for: the card shows them as pending until it and the re-read are done.
  const [adding, setAdding] = useState<PrReviewerCandidate | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const remove = async (r: PrReviewer) => {
    if (!r.id) return
    const reviewer = r.id
    setRemoving(reviewer)
    await write.run('remove reviewer', () => window.api.pullRequests.removeReviewer(pr.ref, { reviewer }))
    setRemoving(null)
  }
  const add = async (c: PrReviewerCandidate) => {
    setAdding(c)
    await write.run('add reviewer', () => window.api.pullRequests.addReviewer(pr.ref, { reviewer: c.id }))
    setAdding(null)
  }

  return (
    <SideCard title="Reviewers" right={pr.reviewers.length > 0 ? approvals : undefined}>
      {pr.reviewers.length === 0 && <CardRow><span className="text-[var(--text-muted)]">No reviewers yet.</span></CardRow>}
      {pr.reviewers.map((r) => (
        <div key={r.id ?? r.person.login} data-pr-reviewer={r.person.login} className="group">
          <CardRow>
            <Avatar person={r.person} />{r.person.displayName}
            {removing !== null && r.id === removing
              ? <PendingLabel text="Removing…" />
              : <span className="ml-auto text-[12px]" style={{ color: REVIEW_LABEL[r.state].color ?? 'var(--text-secondary)' }}>{REVIEW_LABEL[r.state].text}</span>}
            {manage && canRemoveReviewer(pr.ref.host, r) && <ReviewerMenu name={r.person.displayName} disabled={write.pending} onRemove={() => void remove(r)} />}
          </CardRow>
        </div>
      ))}
      {adding && !pr.reviewers.some((r) => r.id === adding.id) && (
        <div data-pr-reviewer-pending={adding.person.login}>
          <CardRow><Avatar person={adding.person} />{adding.person.displayName}<PendingLabel text="Adding…" /></CardRow>
        </div>
      )}
      {manage && <AddReviewer pr={pr} disabled={write.pending} onAdd={(c) => void add(c)} />}
      {write.error && <div className="px-3 pb-2"><WriteError error={write.error} /></div>}
    </SideCard>
  )
}

function PendingLabel({ text }: { text: string }) {
  return (
    <span role="status" className="ml-auto inline-flex items-center gap-[6px] text-[12px] text-[var(--text-muted)]">
      <span aria-hidden="true" className="size-[10px] rounded-full border-[1.5px] border-solid border-[var(--border)] border-t-[var(--accent)] animate-[sb-spin_720ms_linear_infinite]" />
      {text}
    </span>
  )
}

function ReviewerMenu({ name, disabled, onRemove }: { name: string; disabled: boolean; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Actions for ${name}`}
          aria-haspopup="menu"
          disabled={disabled}
          className="-my-1 h-6 px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <Icon name="more" size={12} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="sb-floating-surface z-[1200] min-w-[180px] rounded-[10px] border border-[var(--border-strong,var(--border))] p-1 shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
        <div role="menu" aria-label={`Actions for ${name}`}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onRemove()
            }}
            className="block w-full cursor-pointer rounded-[6px] border-none bg-transparent px-2 py-[6px] text-left text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none"
          >
            Remove reviewer
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AddReviewer({ pr, disabled, onAdd }: { pr: PrDetail; disabled: boolean; onAdd: (c: PrReviewerCandidate) => void }) {
  const loaded = useReviewStore((s) => s.candidates[repoKey(pr.ref)])
  useEffect(() => {
    void useReviewStore.getState().loadCandidates(pr.ref)
  }, [pr.ref.host, pr.ref.owner, pr.ref.name])
  const listed = useReviewStore((s) => s.list?.prs)
  const offered = useMemo(() => offeredReviewers(loaded?.status === 'ok' ? loaded.data : null, listed ?? [], pr), [loaded, listed, pr])
  const options = useMemo<ComboboxOption[]>(
    () => offered.map((c) => ({ value: c.id, label: c.person.displayName, hint: candidateHint(c, pr.ref.owner), keywords: [c.person.login] })),
    [offered, pr.ref.owner],
  )
  const emptyText = !loaded || loaded.status === 'loading' ? 'Loading…' : loaded.status === 'error' ? writeErrorText(loaded.error) : 'Nobody else to add.'
  return (
    <CardRow>
      <Combobox
        value=""
        onValueChange={(id) => {
          const picked = offered.find((c) => c.id === id)
          if (picked) onAdd(picked)
        }}
        options={options}
        placeholder="Add reviewer"
        searchPlaceholder="Find a person"
        emptyText={emptyText}
        aria-label="Add reviewer"
        disabled={disabled}
        className="w-full border-dashed bg-transparent"
      />
    </CardRow>
  )
}
