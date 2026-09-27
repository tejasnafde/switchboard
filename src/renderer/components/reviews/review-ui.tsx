/**
 * Small pieces the Reviews screens share: the stroke icons from the mock,
 * initials avatars (no remote images: nothing leaves the machine to draw a
 * face), the one-line notice with its fix, and external links.
 */
import type { ReactNode } from 'react'
import type { CheckState, PrPerson } from '@shared/pull-requests'
import type { PrRowIcon } from '@shared/pull-request-groups'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import type { ReviewNotice } from './review-states'

const PATHS = {
  pr: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3l-2 3 2 3" /></>,
  merge: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 8.5v7M8 7.5c4 1 7 2 7.5 4.5" /></>,
  ok: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" /></>,
  x: <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  msg: <path d="M4 5h16v11H9l-5 4z" />,
  ext: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  rerun: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />,
  skip: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>,
  draft: <><circle cx="12" cy="12" r="9" strokeDasharray="3 3" /></>,
} as const

export type IconName = keyof typeof PATHS
export type IconTone = 'ok' | 'bad' | 'warn' | 'dim' | 'plain'

const TONE: Record<IconTone, string> = {
  ok: 'text-[var(--success)]',
  bad: 'text-[var(--error)]',
  warn: 'text-[var(--warning)]',
  dim: 'text-[var(--text-muted)]',
  plain: '',
}

export function Icon({ name, tone = 'plain', size = 14, className }: { name: IconName; tone?: IconTone; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0', TONE[tone], className)}
    >
      {PATHS[name]}
    </svg>
  )
}

export const ROW_ICON: Record<PrRowIcon, { name: IconName; tone: IconTone; label: string }> = {
  failed: { name: 'x', tone: 'bad', label: 'Checks failed' },
  review: { name: 'msg', tone: 'warn', label: 'Your review' },
  conversation: { name: 'msg', tone: 'warn', label: 'Open conversations' },
  running: { name: 'clock', tone: 'dim', label: 'Checks running' },
  waiting: { name: 'pr', tone: 'dim', label: 'Waiting' },
  ready: { name: 'ok', tone: 'ok', label: 'Ready to merge' },
  merged: { name: 'merge', tone: 'dim', label: 'Merged' },
  draft: { name: 'draft', tone: 'dim', label: 'Draft' },
}

export const CHECK_ICON: Record<CheckState, { name: IconName; tone: IconTone }> = {
  success: { name: 'ok', tone: 'ok' },
  failure: { name: 'x', tone: 'bad' },
  pending: { name: 'clock', tone: 'dim' },
  skipped: { name: 'skip', tone: 'dim' },
  neutral: { name: 'skip', tone: 'dim' },
}

const AVATAR_COLORS = ['#8a5a2b', '#b0833a', '#4f7a5a', '#3f6fd8', '#7a4f8a', '#2f7f86', '#8a4a4a', '#5a6a2b']

function initials(person: PrPerson): string {
  const words = person.displayName.split(/[\s._-]+/).filter(Boolean)
  const letters = words.length >= 2 ? `${words[0][0]}${words[1][0]}` : person.login.slice(0, 2)
  return letters.toUpperCase()
}

export function Avatar({ person, size = 20 }: { person: PrPerson; size?: number }) {
  let hash = 0
  for (const ch of person.login) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return (
    <span
      aria-hidden="true"
      title={person.displayName}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-[600] text-white"
      style={{ width: size, height: size, fontSize: Math.round(size / 2), background: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] }}
    >
      {initials(person)}
    </span>
  )
}

export function openExternal(url: string): void {
  // The window-open handler in main sends http(s) links to the system browser.
  window.open(url, '_blank', 'noopener')
}

export function NoticeView({ notice, onAction, compact = false }: { notice: ReviewNotice; onAction: (action: ReviewNotice['action']) => void; compact?: boolean }) {
  return (
    <div
      role="status"
      data-review-notice={notice.id}
      className={cn('flex items-start gap-[10px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)] text-[12.5px]', compact ? 'px-[10px] py-2' : 'px-3 py-[10px]')}
    >
      <div className="min-w-0 flex-1">
        <div className="font-[500] text-[var(--text-primary)]">{notice.line}</div>
        <div className="text-[var(--text-secondary)]">{notice.fix}</div>
      </div>
      {notice.action && (
        <Button variant="outline" size="sm" onClick={() => onAction(notice.action)}>{notice.actionLabel}</Button>
      )}
    </div>
  )
}

export function SideCard({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-[14px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)]">
      <h3 className="m-0 flex items-center border-b border-[var(--border)] px-3 py-[10px] text-[12.5px] font-[600] text-[var(--text-primary)]">
        {title}
        {right !== undefined && <span className="ml-auto text-[12px] font-[400] text-[var(--text-secondary)] tabular-nums">{right}</span>}
      </h3>
      {children}
    </section>
  )
}

export function CardRow({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 px-3 py-[7px] text-[12.5px] [&+&]:border-t [&+&]:border-[var(--border)]">{children}</div>
}
