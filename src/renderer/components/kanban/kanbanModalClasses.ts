import { cn } from '../../lib/utils'

// The card and worktree dialogs share one look. The surface is the opaque
// per-theme one: these used var(--bg), which no theme defines, so the board
// showed through them.
export const modalClass = (size: string): string => cn(
  'sb-floating-surface inset-0 z-[1000] m-auto flex h-fit max-h-[88vh] flex-col overflow-hidden rounded-[8px] border border-[var(--border)] shadow-[0_12px_48px_rgba(0,0,0,0.4)]!',
  size,
)
export const headerClass = 'flex items-center justify-between border-b border-[var(--border)] px-[14px] py-[10px] font-[600]'
export const closeButtonClass = 'cursor-pointer border-0 bg-transparent text-[14px] text-inherit'
export const footerClass = 'flex gap-[6px] border-t border-[var(--border)] p-[10px]'
const buttonClass = 'cursor-pointer rounded-[4px] px-[14px] py-[6px] text-[12px]'
export const primaryButtonClass = cn(buttonClass, 'border-0 bg-[var(--accent,#2563eb)] text-[#fff]')
export const secondaryButtonClass = cn(buttonClass, 'border border-[var(--border)] bg-transparent text-inherit')
export const dangerButtonClass = cn(buttonClass, 'border border-[var(--red,#d73a49)] bg-transparent text-[var(--red,#d73a49)]')
