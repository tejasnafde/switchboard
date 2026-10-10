/**
 * Files tab: the changed files as a one-level tree (with each file's open
 * conversations and line counts, or "conflict" where the host says it
 * conflicts with the target), and the selected file's diff with its inline
 * threads.
 */
import { useState } from 'react'
import type { PrChangedFile, PrConversation, PrSummary } from '@shared/pull-requests'
import { useReviewStore } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { Loaded, usePrResource } from './PrDetailPane'
import { PrDiff } from './PrDiff'
import { PendingReviewBar } from './PrReviewForm'
import { fileName, groupFilesByDir } from './review-states'
import { Icon } from './review-ui'

export function PrFiles({ summary, now }: { summary: PrSummary; now: number }) {
  const files = usePrResource(summary, 'files')
  const conversations = usePrResource(summary, 'conversations')
  return (
    <Loaded value={files.value} retry={files.retry}>
      {(data) => (
        <FilesBody
          pr={summary}
          files={data}
          conversations={conversations.value?.status === 'ok' ? conversations.value.data : []}
          now={now}
        />
      )}
    </Loaded>
  )
}

function FilesBody({
  pr,
  files,
  conversations,
  now,
}: {
  pr: PrSummary
  files: PrChangedFile[]
  conversations: PrConversation[]
  now: number
}) {
  const focusPath = useReviewStore((s) => s.focusPath)
  const [picked, setPicked] = useState<string | null>(null)
  const selectedPath =
    picked ?? (focusPath && files.some((f) => f.path === focusPath) ? focusPath : (files[0]?.path ?? null))
  const selected = files.find((f) => f.path === selectedPath) ?? null
  const openCount = (path: string) => conversations.filter((c) => c.path === path && !c.resolved).length

  if (files.length === 0)
    return <div className="p-[22px] text-[12.5px] text-[var(--text-muted)]">No changed files.</div>

  return (
    <div className="flex h-full flex-col">
      <PendingReviewBar pr={pr} />
      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)]">
        <nav
          aria-label="Changed files"
          className="overflow-auto border-r border-[var(--border)] px-2 py-[10px] text-[12.5px]"
        >
          {groupFilesByDir(files).map((group) => (
            <div key={group.dir}>
              <div className="truncate px-2 pt-[6px] pb-[2px] text-[11.5px] text-[var(--text-muted)]" title={group.dir}>
                {group.dir}
              </div>
              {group.files.map((f) => {
                const open = openCount(f.path)
                const active = f.path === selectedPath
                return (
                  <button
                    key={f.path}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setPicked(f.path)}
                    title={f.path}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-[6px] rounded-[6px] border-none px-2 py-1 text-left text-inherit',
                      active ? 'bg-[var(--bg-active)]' : 'bg-transparent hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    {f.status === 'conflicted' ? <Icon name="conflict" tone="warn" /> : <Icon name="file" tone="dim" />}
                    <span className={cn('min-w-0 truncate', f.status === 'deleted' && 'line-through')}>
                      {fileName(f.path)}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-[6px] text-[11.5px] text-[var(--text-muted)] tabular-nums">
                      {open > 0 && (
                        <>
                          <Icon name="msg" tone="warn" size={12} />
                          {open}
                        </>
                      )}
                      {f.status === 'conflicted' ? (
                        <span data-file-conflict className="text-[var(--warning)]">
                          conflict
                        </span>
                      ) : (
                        <>
                          {f.additions > 0 && <span className="text-[var(--success)]">+{f.additions}</span>}
                          {f.deletions > 0 && <span className="text-[var(--error)]">−{f.deletions}</span>}
                        </>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="min-w-0 overflow-auto">
          {selected && (
            <>
              <div className="sticky top-0 z-[2] flex items-center gap-[10px] border-b border-[var(--border)] bg-[var(--bg-surface)] px-[14px] py-2">
                <span className="min-w-0 truncate font-[family-name:var(--font-mono)] text-[12px]">
                  {selected.oldPath ? `${selected.oldPath} → ${selected.path}` : selected.path}
                </span>
                <span className="text-[12px] tabular-nums">
                  <span className="text-[var(--success)]">+{selected.additions}</span>{' '}
                  <span className="text-[var(--error)]">−{selected.deletions}</span>
                </span>
              </div>
              <PrDiff
                key={selected.path}
                pr={pr}
                file={selected}
                conversations={conversations.filter((c) => c.path === selected.path)}
                now={now}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
