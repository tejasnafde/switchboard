/**
 * Save as file for a live page in the preview pane: writes the page (with its
 * theme and import map, so it still draws) into the chat's folder under a
 * free name, records the path with the chat's backend and returns it. The
 * message's block then shows the normal HTML file card.
 */
import { FilesChannels } from '@shared/ipc-channels'
import { htmlLiveDocument, htmlLiveFileName } from '@shared/html-live'
import type { HtmlPreviewTarget } from '../stores/layout-store'
import { rememberSavedPath } from './html-live-frames'
import { htmlLiveTheme } from './html-live-theme'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:html-live-save')

type WriteResult = { ok: true; mtimeMs: number } | { ok: false; error: string; conflict?: boolean }

/** Names tried before giving up; a folder this full of one title is not normal. */
const MAX_ATTEMPTS = 20

export async function saveLivePage(
  target: HtmlPreviewTarget,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const live = target.live
  if (!live || !target.root) return { ok: false, error: 'This page has no chat folder to save into.' }
  const html = htmlLiveDocument(live.source, htmlLiveTheme())
  const taken = new Set<string>()
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const name = htmlLiveFileName(live.title, (n) => taken.has(n))
    // Absent only: an existing file of that name is never overwritten.
    const result: WriteResult = target.machineId
      ? await window.api.routing.invokeOn<WriteResult>(
          target.machineId,
          FilesChannels.WRITE_FILE,
          target.root,
          name,
          html,
          null,
          { content: null },
        )
      : await window.api.files.writeFile(target.root, name, html, undefined, { content: null })
    if (result.ok) {
      rememberSavedPath(live.key, name)
      const recorded = await window.api.htmlLive
        .update(target.machineId, live.key, { savedPath: name })
        .catch((err: unknown) => {
          log.warn('saved path was not recorded', err)
          return { ok: false }
        })
      if (!recorded.ok) log.warn('saved path was not recorded')
      return { ok: true, path: name }
    }
    if (!result.conflict) return { ok: false, error: result.error }
    taken.add(name)
  }
  return { ok: false, error: 'Every file name for this page is taken.' }
}
