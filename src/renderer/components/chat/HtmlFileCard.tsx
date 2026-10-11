/**
 * The card under a Write/Edit of an .html file: name, folder and size, and a
 * Preview button that opens it in the sandboxed preview pane ("In pane" while
 * it shows there). Files over the preview cap offer the browser instead.
 */
import { useEffect, useMemo, useState } from 'react'
import { FilesChannels } from '@shared/ipc-channels'
import { PREVIEW_MAX_BYTES, formatPreviewBytes } from '@shared/html-preview'
import { useAgentStore } from '../../stores/agent-store'
import { useLayoutStore } from '../../stores/layout-store'
import { htmlPreviewAbsolutePath, htmlPreviewDisplay, htmlPreviewTargetFor } from '../../services/html-preview-open'
import { Button } from '../ui/button'
import { PreviewIcon } from '../preview/preview-icons'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:html-file-card')

type ResolveResult = { ok: boolean; exists: boolean; size?: number }

export function HtmlFileCard({ path, sessionId }: { path: string; sessionId: string }) {
  // Primitive selections, so an unrelated session update does not re-render the card.
  const root = useAgentStore((s) => {
    const session = s.sessions.find((x) => x.id === sessionId)
    return session?.worktreePath ?? session?.projectPath ?? null
  })
  const machineId = useAgentStore((s) => s.sessions.find((x) => x.id === sessionId)?.machineId ?? null)
  const target = useMemo(
    () => (root ? htmlPreviewTargetFor([{ id: sessionId, projectPath: root, machineId }], sessionId, path) : null),
    [root, machineId, sessionId, path],
  )
  const inPane = useLayoutStore(
    (s) =>
      s.rightPaneMode === 'preview' &&
      s.htmlPreview !== null &&
      target !== null &&
      s.htmlPreview.root === target.root &&
      s.htmlPreview.path === target.path,
  )
  const [file, setFile] = useState<{ exists: boolean; size?: number } | null>(null)

  useEffect(() => {
    if (!target) return
    let cancelled = false
    const request: Promise<ResolveResult> = target.machineId
      ? window.api.routing.invokeOn<ResolveResult>(target.machineId, FilesChannels.RESOLVE, target.root, target.path)
      : window.api.files.resolve(target.root, target.path)
    request.then(
      (res) => {
        if (!cancelled) setFile({ exists: !!res?.exists, size: res?.size })
      },
      (err: unknown) => log.debug('html file card resolve failed', err),
    )
    return () => {
      cancelled = true
    }
  }, [target])

  if (!target || !file?.exists) return null
  const { name, dir } = htmlPreviewDisplay(target)
  const tooLarge = file.size !== undefined && file.size > PREVIEW_MAX_BYTES
  const meta = [
    dir,
    file.size !== undefined ? formatPreviewBytes(file.size) : null,
    tooLarge ? 'too large to preview' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      data-html-file-card
      className="my-[8px] flex max-w-[440px] items-center gap-[10px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)] px-[10px] py-[8px] text-[13px]"
    >
      <PreviewIcon name="file" className="size-[16px] text-[var(--text-secondary)]" />
      <div className="min-w-0">
        <div className="truncate font-[500] text-[var(--text-primary)]">{name}</div>
        <div className="truncate text-[11.5px] text-[var(--text-muted)]">{meta}</div>
      </div>
      <span className="ml-auto">
        {inPane ? (
          <span className="inline-flex items-center gap-[5px] text-[12px] text-[var(--text-muted)]">
            <PreviewIcon name="check" className="size-[12px] text-[var(--success)]" />
            In pane
          </span>
        ) : tooLarge ? (
          !target.machineId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-[26px] px-[9px] font-[500] text-[var(--text-secondary)]"
              onClick={() => {
                window.api.preview
                  .openExternal(htmlPreviewAbsolutePath(target))
                  .catch((err: unknown) => log.warn('open in browser failed', err))
              }}
            >
              Open in browser
            </Button>
          )
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-[26px] px-[9px] font-[500]"
            onClick={() => useLayoutStore.getState().openHtmlPreview(target)}
          >
            Preview
          </Button>
        )}
      </span>
    </div>
  )
}
