/**
 * Opening an agent-written HTML file in the preview pane. The target and the
 * load request are pure; `loadHtmlPreview` does the one IPC round-trip.
 */
import { FilesChannels } from '@shared/ipc-channels'
import { isHtmlPreviewPath, splitPreviewPath, type PreviewOpenResult } from '@shared/html-preview'
import { useAgentStore } from '../stores/agent-store'
import { useLayoutStore, type HtmlPreviewTarget } from '../stores/layout-store'
import { htmlLiveTheme } from './html-live-theme'

interface SessionLike {
  id: string
  projectPath?: string | null
  worktreePath?: string | null
  machineId?: string | null
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
}

/** The preview target for `path` named in chat `sessionId`, or null. */
export function htmlPreviewTargetFor(
  sessions: readonly SessionLike[],
  sessionId: string | null | undefined,
  path: string,
): HtmlPreviewTarget | null {
  if (!sessionId || !isHtmlPreviewPath(path)) return null
  const session = sessions.find((s) => s.id === sessionId)
  const root = session?.worktreePath ?? session?.projectPath
  if (!root) return null
  const machineId = session?.machineId && session.machineId !== 'local' ? session.machineId : null
  return { path, root, machineId, sessionId }
}

/** Absolute path of a local target, joined with the root's own separator. */
export function htmlPreviewAbsolutePath(target: HtmlPreviewTarget): string {
  if (isAbsolutePath(target.path)) return target.path
  const sep = target.root.includes('\\') && !target.root.includes('/') ? '\\' : '/'
  const root = target.root.replace(/[\\/]+$/, '')
  const rel = target.path.replace(/^\.[\\/]/, '').replaceAll(/[\\/]/g, sep)
  return `${root}${sep}${rel}`
}

/** `design/` for a path below the root, the folder name for an absolute one. */
export function htmlPreviewDisplay(target: HtmlPreviewTarget): { name: string; dir: string } {
  const { name, dir } = splitPreviewPath(target.path)
  if (!isAbsolutePath(target.path)) return { name, dir }
  const root = target.root.replace(/[\\/]+$/, '').replaceAll('\\', '/')
  const abs = target.path.replaceAll('\\', '/')
  if (abs.startsWith(`${root}/`)) return splitPreviewPath(abs.slice(root.length + 1))
  return { name, dir: dir.split('/').filter(Boolean).slice(-1)[0] + '/' }
}

/**
 * Load a target into the preview session. A local file is served by path with
 * the files in its folder; a remote one is read through its backend (capped
 * there) and loaded as content, so no local path is ever involved.
 */
export async function loadHtmlPreview(target: HtmlPreviewTarget): Promise<PreviewOpenResult> {
  if (target.live) return window.api.preview.open({ kind: 'live', source: target.live.source, theme: htmlLiveTheme() })
  if (!target.machineId) {
    return window.api.preview.open({ kind: 'file', root: target.root, filePath: htmlPreviewAbsolutePath(target) })
  }
  const read = await window.api.routing.invokeOn<
    { ok: true; html: string; bytes: number } | { ok: false; error: string; bytes?: number }
  >(target.machineId, FilesChannels.READ_HTML, target.root, target.path)
  if (!read.ok) {
    const error = read.error === 'not-found' || read.error === 'too-large' ? read.error : 'failed'
    return { ok: false, error, bytes: read.bytes }
  }
  return window.api.preview.open({ kind: 'content', fileName: splitPreviewPath(target.path).name, html: read.html })
}

/** File chip click: open `path` from chat `sessionId` in the preview pane. */
export function openHtmlPreviewFromChat(path: string, sessionId: string | null | undefined): boolean {
  const target = htmlPreviewTargetFor(useAgentStore.getState().sessions, sessionId, path)
  if (!target) return false
  useLayoutStore.getState().openHtmlPreview(target)
  return true
}

const FILE_WRITING_TOOLS = new Set(['write', 'edit', 'multiedit'])

/**
 * The .html file a finished Write/Edit tool call produced, or null. History
 * previews shorten `input`, so a cut-off JSON body still yields the path.
 */
export function htmlFileFromToolCall(name: string, input: string): string | null {
  if (!FILE_WRITING_TOOLS.has(name.toLowerCase())) return null
  let path: unknown
  try {
    path = (JSON.parse(input) as { file_path?: unknown }).file_path
  } catch {
    path = input.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replaceAll('\\\\', '\\')
  }
  return typeof path === 'string' && isHtmlPreviewPath(path) ? path : null
}

/** The .html files a group of messages wrote with finished tool calls, first write first. */
export function htmlFilesWritten(
  messages: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ name: string; input: string; output?: string }> }>,
): string[] {
  const paths: string[] = []
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.output === undefined) continue
      const path = htmlFileFromToolCall(call.name, call.input)
      if (path && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}
