import { useEffect, useState } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import type { DraftChatOptions } from '@shared/new-chat-draft'
import { createRendererLogger } from '../../logger'
import { ChipSelect, type ChipOption } from '../ui/chip'
import { BranchIcon } from './FooterIcons'

const log = createRendererLogger('chat:draft-workspace')

/** One list of the draft's checkout: the checkout itself, then its base or worktree. */
export interface DraftWorkspaceSection {
  key: 'checkout' | 'base' | 'existing'
  /** The list's accessible name. */
  label: string
  testId: string
  options: ChipOption[]
  value: string
  /** The selected row's label, as the "..." menu shows it. */
  valueText: string
  short?: string
  pick: (value: string) => void
}

const CHECKOUT_SHORT: Record<DraftChatOptions['checkout'], string> = {
  project: 'Project',
  worktree: 'Worktree',
  existing: 'Existing',
}

/**
 * Where a draft chat will run, chosen before the first send. Replaces the
 * branch picker while the chat is a draft: a running chat switches its
 * branch, a draft picks the checkout: the project, a new worktree and its
 * base, or a worktree that already exists.
 */
export function useDraftWorkspace(
  sessionId: string | null,
  cwd: string | null,
  draft: DraftChatOptions | undefined,
): DraftWorkspaceSection[] {
  const setDraftOptions = useAgentStore((s) => s.setDraftOptions)
  const [refs, setRefs] = useState<Array<{ name: string; isRemote: boolean; worktreePath: string | null }>>([])
  const isDraft = !!sessionId && !!draft

  // One read serves both lists: local branches to base a new worktree on, and
  // the worktrees already on disk a chat can join.
  useEffect(() => {
    setRefs([])
    if (!cwd || !isDraft) return
    let cancelled = false
    window.api.git
      .listRefs(cwd)
      .then((result) => {
        if (!cancelled && result.ok) setRefs(result.refs)
      })
      .catch((err: unknown) => log.warn('listRefs failed', err))
    return () => {
      cancelled = true
    }
  }, [cwd, isDraft])

  if (!sessionId || !draft) return []

  const branches = refs.filter((r) => !r.isRemote).map((r) => r.name)
  const worktrees = refs.flatMap((r) =>
    !r.isRemote && r.worktreePath && r.worktreePath !== cwd ? [{ path: r.worktreePath, branch: r.name }] : [],
  )

  const pickCheckout = (checkout: DraftChatOptions['checkout']) =>
    setDraftOptions(sessionId, {
      checkout,
      ...(checkout === 'existing' && !draft.existing && worktrees[0] ? { existing: worktrees[0] } : {}),
    })

  const checkoutOptions: ChipOption[] = [
    { value: 'project', label: 'Project checkout' },
    { value: 'worktree', label: 'New worktree' },
    ...(worktrees.length > 0 || draft.checkout === 'existing'
      ? [{ value: 'existing', label: 'Existing worktree' }]
      : []),
  ]
  const sections: DraftWorkspaceSection[] = [
    {
      key: 'checkout',
      label: 'Workspace',
      testId: 'draft-workspace',
      options: checkoutOptions,
      value: draft.checkout,
      valueText: checkoutOptions.find((o) => o.value === draft.checkout)?.label ?? draft.checkout,
      short: CHECKOUT_SHORT[draft.checkout],
      pick: (value) => pickCheckout(value as DraftChatOptions['checkout']),
    },
  ]

  if (draft.checkout === 'worktree') {
    const options: ChipOption[] = [
      { value: 'HEAD', label: 'from current HEAD' },
      ...branches.map((name) => ({ value: name, label: `from ${name}` })),
    ]
    sections.push({
      key: 'base',
      label: 'Base branch',
      testId: 'draft-base-ref',
      options,
      value: draft.baseRef,
      valueText: options.find((o) => o.value === draft.baseRef)?.label ?? `from ${draft.baseRef}`,
      short: draft.baseRef,
      pick: (value) => setDraftOptions(sessionId, { baseRef: value }),
    })
  }

  if (draft.checkout === 'existing') {
    sections.push({
      key: 'existing',
      label: 'Worktree',
      testId: 'draft-existing-worktree',
      options: worktrees.map((w) => ({ value: w.path, label: w.branch, title: w.path })),
      value: draft.existing?.path ?? '',
      valueText: draft.existing?.branch ?? '',
      pick: (value) => {
        const picked = worktrees.find((w) => w.path === value)
        if (picked) setDraftOptions(sessionId, { existing: picked })
      },
    })
  }

  return sections
}

export function DraftWorkspaceChips({ sections }: { sections: DraftWorkspaceSection[] }) {
  return (
    <>
      {sections.map((section, index) => (
        <ChipSelect
          key={section.key}
          label={section.label}
          triggerLabel={`${section.label}: ${section.valueText}`}
          testId={section.testId}
          icon={index === 0 ? <BranchIcon /> : undefined}
          full={section.valueText}
          short={section.short}
          valueClassName="max-w-[160px] truncate"
          options={section.options}
          value={section.value}
          onPick={section.pick}
          menuClassName="w-[240px]"
        />
      ))}
    </>
  )
}
