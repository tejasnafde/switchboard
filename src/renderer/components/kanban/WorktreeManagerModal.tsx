/**
 * The kanban board's worktree dialog: the Settings worktree manager scoped
 * to one project, so the board and Settings share one list, one set of
 * safety rules and one removal path.
 *
 * We deliberately don't auto-clean on launch: deleting a worktree can drop
 * uncommitted work, so the user always pulls the trigger themselves.
 */

import { useMemo } from 'react'
import { WorktreesPanel, useWorktreeInventory } from '../settings/WorktreesPanel'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { closeButtonClass, headerClass, modalClass } from './kanban-modal-classes'

interface Props {
  projectPath: string
  onClose: () => void
}

export function WorktreeManagerModal({ projectPath, onClose }: Props): React.ReactElement {
  const projectPaths = useMemo(() => [projectPath], [projectPath])
  const worktrees = useWorktreeInventory(projectPaths)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        overlayClassName="z-[1000] bg-[rgba(0,0,0,0.4)]"
        className={modalClass('w-[760px] max-w-[94vw]')}
      >
        <div className={headerClass}>
          <DialogTitle className="text-[13px] font-[600]">Worktrees - {projectPath.split('/').pop()}</DialogTitle>
          <button onClick={onClose} className={closeButtonClass} aria-label="Close">&times;</button>
        </div>
        <div className="overflow-auto p-[12px]">
          <WorktreesPanel state={worktrees} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
