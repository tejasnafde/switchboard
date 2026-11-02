/**
 * The phones' chat Details sheet (the desktop's Details popover): machine,
 * branch, linked pull request, working-tree changes and the usage bars.
 *
 * A phone shows the sheet's button only when the backend advertises this
 * capability, because an older backend has no `git:diff-stat`. The sheet's
 * reads (`git:current-branch`, `git:diff-stat`, `pull-requests:links`,
 * `pull-requests:list`, `provider-instances:usage`) are open to the `chat`
 * scope (`device-auth.ts`).
 */
export const DETAILS_SHEET_CAPABILITY = 'details_sheet_v1'

/** `git:current-branch`: a null branch is a detached HEAD; a failed read (not a repository) shows None. */
export type BranchRead = { ok: true; branch: string | null } | { ok: false; error: string }

/** `git:diff-stat`: lines added and removed against HEAD. */
export type DiffRead = { ok: true; added: number; removed: number } | { ok: false; error: string }
