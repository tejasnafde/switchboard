/**
 * Open a project on another machine (`services/project-clone.ts`): pick a
 * connected machine, optionally pick ignored files to copy (none by
 * default) and the folder (default `~/projects/<name>`), then watch the
 * clone. Closing the dialog leaves the clone running; the sidebar row shows
 * its progress. A failed clone offers Try again.
 */
import { useEffect, useMemo, useState } from 'react'
import { ProjectCloneChannels } from '@shared/ipc-channels'
import {
  PROJECT_CLONE_CAPABILITY,
  PROJECT_CLONE_FOLDER_CAPABILITY,
  cloneFolderName,
  cloneSourceProblem,
  cloneTargetPathProblem,
  defaultCloneTarget,
  type CloneSourceResult,
} from '@shared/project-clone'
import { formatBytes } from '@shared/worktree-manager'
import { useMachineStore } from '../../stores/machine-store'
import {
  cloneKey,
  cloneTargetBlock,
  openProjectOnMachine,
  useProjectCloneStore,
  type CloneProgress,
} from '../../services/project-clone'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Combobox } from '../ui/combobox'
import { Input } from '../ui/input'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('sidebar:open-on-machine')

export interface OpenOnMachineTarget {
  machineId: string
  projectPath: string
  projectName: string
}

export function cloneProgressText(progress: CloneProgress): string {
  switch (progress.phase) {
    case 'cloning':
      return `Cloning: ${progress.line}`
    case 'copying':
      return `Copying files: ${progress.done + 1} of ${progress.total}`
    case 'done':
      return progress.failedFiles.length > 0
        ? `Cloned. These files were not copied: ${progress.failedFiles.join(', ')}`
        : `Cloned${progress.branch ? ` on ${progress.branch}` : ''}.`
    case 'failed':
      return `The clone failed: ${progress.error}`
  }
}

export function OpenOnMachineDialog({
  project,
  onClose,
  onOpened,
}: {
  project: OpenOnMachineTarget
  onClose: () => void
  /** The clone was accepted: the new project is listed under the machine. */
  onOpened?: (machineId: string, projectPath: string) => void
}) {
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const targets = useMemo(
    () => remotes.filter((m) => m.id !== project.machineId && connections[m.id] === 'connected'),
    [remotes, connections, project.machineId],
  )
  const [machineId, setMachineId] = useState('')
  const [source, setSource] = useState<CloneSourceResult | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<string | null>(null)
  const defaultFolder = defaultCloneTarget(cloneFolderName(project.projectPath))
  const [folder, setFolder] = useState(defaultFolder)
  const progress = useProjectCloneStore((s) => (started ? s.clones[started] : undefined))

  useEffect(() => {
    if (!machineId && targets.length > 0) setMachineId(targets[0].id)
  }, [machineId, targets])

  useEffect(() => {
    let current = true
    window.api.routing
      .invokeOn<CloneSourceResult>(project.machineId, ProjectCloneChannels.SOURCE, project.projectPath)
      .then((result) => current && setSource(result))
      .catch((err: unknown) => {
        log.warn('reading the clone source failed', err)
        if (current) setSource({ ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      current = false
    }
  }, [project.machineId, project.projectPath])

  const sourceError = source && cloneSourceProblem(source)
  const machineName = remotes.find((m) => m.id === machineId)?.name ?? ''
  const targetFolder = folder.trim()
  const customFolder = targetFolder !== defaultFolder
  const folderProblem = cloneTargetPathProblem(targetFolder)
  const block = machineId
    ? cloneTargetBlock(window.api.routing.supportsCapability(machineId, PROJECT_CLONE_CAPABILITY), {
        custom: customFolder,
        supported: window.api.routing.supportsCapability(machineId, PROJECT_CLONE_FOLDER_CAPABILITY),
      })
    : null

  const start = async () => {
    if (!source?.ok || !machineId || starting || folderProblem) return
    setStarting(true)
    setError(null)
    try {
      const result = await openProjectOnMachine(
        {
          sourceMachineId: project.machineId,
          projectPath: project.projectPath,
          targetMachineId: machineId,
          source,
          files: [...checked],
          targetFolder: customFolder ? targetFolder : undefined,
        },
        {
          invokeOn: (id, channel, ...args) => window.api.routing.invokeOn(id, channel, ...args),
          syncMachine: (id) => useMachineStore.getState().syncMachine(id),
        },
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      setStarted(cloneKey(machineId, result.path))
      onOpened?.(machineId, result.path)
    } catch (err) {
      log.warn('starting the clone failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const toggle = (path: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })

  const ended = progress?.phase === 'done' || progress?.phase === 'failed'

  return (
    <Dialog open onOpenChange={(open) => !open && !starting && onClose()}>
      <DialogContent
        data-testid="open-on-machine-dialog"
        overlayClassName="z-[1300]"
        className="sb-floating-surface inset-x-0 top-[12vh] z-[1300] mx-auto flex max-h-[76vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
      >
        <DialogTitle className="border-b border-[var(--border)] px-[14px] py-[10px] text-[12px] font-[600] text-[var(--text-secondary)]">
          Open "{project.projectName}" on another machine
        </DialogTitle>
        <div className="flex min-h-0 flex-1 flex-col gap-[8px] overflow-y-auto px-[14px] py-[10px] text-[12px]">
          {started ? (
            <div role="status" className="text-[var(--text-secondary)]">
              {progress ? cloneProgressText(progress) : 'Starting the clone'}
            </div>
          ) : targets.length === 0 ? (
            <DialogDescription className="text-[var(--text-muted)]">
              No other machine is connected. Connect one in the sidebar, then try again.
            </DialogDescription>
          ) : (
            <>
              <div className="flex items-center gap-[8px]">
                <span className="text-[var(--text-secondary)]">Machine</span>
                <Combobox
                  aria-label="Machine to open the project on"
                  searchable={false}
                  value={machineId}
                  options={targets.map((m) => ({ value: m.id, label: m.name }))}
                  onValueChange={setMachineId}
                />
              </div>
              {block && (
                <div role="alert" className="text-[var(--text-secondary)]">
                  {block}
                </div>
              )}
              {!source && <div className="text-[var(--text-muted)]">Reading the project's git remote…</div>}
              {sourceError && (
                <div role="alert" className="text-[var(--text-secondary)]">
                  {sourceError}
                </div>
              )}
              {source?.ok && !sourceError && (
                <>
                  <DialogDescription className="text-[var(--text-muted)]">
                    Clones {source.url} (remote "{source.remoteName}")
                    {source.remoteBranch ? ` and checks out ${source.remoteBranch}` : ''} into the folder below on{' '}
                    {machineName}. Uncommitted and unpushed work stays here.
                  </DialogDescription>
                  <label className="flex items-center gap-[8px]">
                    <span className="text-[var(--text-secondary)]">Folder</span>
                    <Input
                      aria-label="Folder on the other machine"
                      aria-invalid={folderProblem !== null}
                      spellCheck={false}
                      className="[font-family:var(--font-mono)]"
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                    />
                  </label>
                  {folderProblem && (
                    <div role="alert" className="text-[var(--text-secondary)]">
                      {folderProblem}
                    </div>
                  )}
                  {source.ignored.length > 0 && (
                    <fieldset className="m-0 flex flex-col gap-[6px] border-0 p-0">
                      <legend className="mb-[4px] p-0 text-[var(--text-secondary)]">
                        Copy files that git ignores (optional)
                      </legend>
                      <div className="text-[var(--warning)]">
                        These files are not in git. They may hold secrets such as API keys or passwords. Copy only what
                        the other machine needs.
                      </div>
                      {source.ignored.map((file) => (
                        <label key={file.path} className="flex cursor-pointer items-center gap-[8px]">
                          <Checkbox
                            checked={checked.has(file.path)}
                            onCheckedChange={(state) => toggle(file.path, state === true)}
                          />
                          <span className="[font-family:var(--font-mono)] text-[var(--text-primary)]">{file.path}</span>
                          <span className="text-[var(--text-muted)]">{formatBytes(file.size)}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {source.skippedIgnored > 0 && (
                    <div className="text-[var(--text-muted)]">
                      {source.skippedIgnored} other ignored {source.skippedIgnored === 1 ? 'entry is' : 'entries are'}{' '}
                      not offered: folders, links, binary files and files over 1 MB.
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {error && (
            <div role="alert" className="text-[var(--error)]">
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-[6px] border-t border-[var(--border)] px-[14px] py-[10px]">
          <Button variant="outline" size="sm" disabled={starting} onClick={onClose}>
            {started ? (ended ? 'Close' : 'Close, keep cloning') : 'Cancel'}
          </Button>
          {started && progress?.phase === 'failed' && (
            <Button
              size="sm"
              onClick={() => {
                setStarted(null)
                setError(null)
              }}
            >
              Try again
            </Button>
          )}
          {!started && targets.length > 0 && (
            <Button
              size="sm"
              disabled={
                starting || !source?.ok || !!sourceError || !machineId || block !== null || folderProblem !== null
              }
              onClick={() => void start()}
            >
              {starting ? 'Starting…' : `Open on ${machineName}`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
