import { useState, type ComponentType, type ReactNode } from 'react'
import { ArchivedPanel } from './ArchivedPanel'
import { WorktreesPanel, useWorktreeInventory } from './WorktreesPanel'
import { inventorySummary } from './worktree-list'
import { SETTING_ROW, type SettingRowDef, type SettingsPage } from './settings-rows'
import { Button } from '../ui/button'

type Anchor = ComponentType<{ def: SettingRowDef; children: ReactNode }>

const sectionTitleClass = 'mb-2 text-[11px] font-[600] uppercase tracking-[0.07em] text-[var(--text-muted)]'

/**
 * Settings > Archive & data. "Review" swaps the page for the worktree
 * manager, with a link back, as its own screen rather than a dialog on top.
 */
export function ArchiveDataPage({ meta, Anchor, onOpenProjects }: {
  meta: SettingsPage
  Anchor: Anchor
  onOpenProjects?: () => void
}) {
  const [reviewing, setReviewing] = useState(false)
  const worktrees = useWorktreeInventory()

  if (reviewing) {
    return (
      <>
        <button
          type="button"
          onClick={() => setReviewing(false)}
          className="mb-1 cursor-pointer border-0 bg-transparent p-0 text-[12.5px] text-[var(--accent)] outline-none hover:underline focus-visible:underline"
        >
          ‹ {meta.title}
        </button>
        <h2 className="mb-1 text-[18px] font-[600]">Worktrees</h2>
        <p className="mb-[18px] text-[13px] text-[var(--text-secondary)]">
          Remove what you no longer need. A worktree with uncommitted changes or unpushed commits is never removed in a batch.
        </p>
        <WorktreesPanel state={worktrees} onManageProtection={onOpenProjects} />
      </>
    )
  }

  return (
    <>
      <h2 className="mb-1 text-[18px] font-[600]">{meta.title}</h2>
      <p className="mb-[18px] text-[13px] text-[var(--text-secondary)]">{meta.description}</p>
      <section className="mb-[18px]">
        <h3 className={sectionTitleClass}>{SETTING_ROW.archived.section}</h3>
        <Anchor def={SETTING_ROW.archived}><ArchivedPanel /></Anchor>
      </section>
      <section className="mb-[18px]">
        <h3 className={sectionTitleClass}>{SETTING_ROW.worktrees.section}</h3>
        <Anchor def={SETTING_ROW.worktrees}>
          <div className="flex items-center gap-4 rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] px-[14px] py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-[500]">{SETTING_ROW.worktrees.label}</div>
              <div className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                {worktrees.inventory
                  ? inventorySummary(worktrees.inventory.rows)
                  : worktrees.error ?? (worktrees.loading ? 'Reading worktrees…' : SETTING_ROW.worktrees.description)}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setReviewing(true)}>Review</Button>
          </div>
        </Anchor>
      </section>
    </>
  )
}
