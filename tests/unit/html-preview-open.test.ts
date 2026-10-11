/**
 * HTML preview, renderer side: which chat paths open the preview, how the
 * target and its display name are built, the right-pane mode round trip, and
 * the console text.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  htmlFileFromToolCall,
  htmlPreviewAbsolutePath,
  htmlPreviewDisplay,
  htmlPreviewTargetFor,
} from '../../src/renderer/services/html-preview-open'
import { previewConsoleLine, previewErrorsForAgent } from '../../src/renderer/services/html-preview-console'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'
import {
  blockedRequestLabel,
  isHtmlPreviewPath,
  previewAssetRelativePath,
  previewNavigationAllowed,
  previewRequestVerdict,
  resolvePreviewColorScheme,
} from '../../src/shared/html-preview'

const sessions = [
  { id: 'local', projectPath: '/repo', worktreePath: '/repo/.switchboard/worktrees/a' },
  { id: 'remote', projectPath: '/srv/app', machineId: 'vm-1' },
  { id: 'here', projectPath: '/x', machineId: 'local' },
]

describe('html preview targets', () => {
  it('opens only .html files of a known chat, rooted at its worktree', () => {
    expect(htmlPreviewTargetFor(sessions, 'local', 'design/page.html')).toEqual({
      path: 'design/page.html',
      root: '/repo/.switchboard/worktrees/a',
      machineId: null,
      sessionId: 'local',
    })
    expect(htmlPreviewTargetFor(sessions, 'local', 'src/main.ts')).toBeNull()
    expect(htmlPreviewTargetFor(sessions, 'missing', 'a/b.html')).toBeNull()
    expect(htmlPreviewTargetFor(sessions, 'remote', 'out/r.HTM')?.machineId).toBe('vm-1')
    expect(htmlPreviewTargetFor(sessions, 'here', 'a/b.html')?.machineId).toBeNull()
  })

  it('joins relative paths onto the root and keeps absolute ones', () => {
    const t = (path: string, root = '/repo') => ({ path, root, machineId: null, sessionId: 's' })
    expect(htmlPreviewAbsolutePath(t('design/page.html'))).toBe('/repo/design/page.html')
    expect(htmlPreviewAbsolutePath(t('./page.html', '/repo/'))).toBe('/repo/page.html')
    expect(htmlPreviewAbsolutePath(t('/tmp/x.html'))).toBe('/tmp/x.html')
    expect(htmlPreviewAbsolutePath(t('out/r.html', 'C:\\work\\app'))).toBe('C:\\work\\app\\out\\r.html')
  })

  it('shows the file name and its folder below the root', () => {
    const t = (path: string) => ({ path, root: '/repo', machineId: null, sessionId: 's' })
    expect(htmlPreviewDisplay(t('design/page.html'))).toEqual({ name: 'page.html', dir: 'design/' })
    expect(htmlPreviewDisplay(t('/repo/design/page.html'))).toEqual({ name: 'page.html', dir: 'design/' })
    expect(htmlPreviewDisplay(t('page.html'))).toEqual({ name: 'page.html', dir: '' })
  })

  it('finds the .html file of a Write or Edit call, even in a shortened preview', () => {
    expect(htmlFileFromToolCall('Write', JSON.stringify({ file_path: '/r/a.html', content: 'x' }))).toBe('/r/a.html')
    expect(htmlFileFromToolCall('Edit', '{"file_path":"/r/b.html","old_string":"<div cut off')).toBe('/r/b.html')
    expect(htmlFileFromToolCall('Write', JSON.stringify({ file_path: '/r/a.ts' }))).toBeNull()
    expect(htmlFileFromToolCall('Read', JSON.stringify({ file_path: '/r/a.html' }))).toBeNull()
  })
})

describe('html preview right-pane mode', () => {
  beforeEach(() => {
    useLayoutStore.setState({ rightPaneMode: 'files', htmlPreview: null, paneVisual: null })
  })

  it('opens as the preview mode and closes back to the mode before it', () => {
    const target = { path: 'a.html', root: '/r', machineId: null, sessionId: 's' }
    useLayoutStore.getState().openHtmlPreview(target)
    expect(useLayoutStore.getState().rightPaneMode).toBe('preview')
    useLayoutStore.getState().openHtmlPreview({ ...target, path: 'b.html' })
    expect(useLayoutStore.getState().htmlPreview?.path).toBe('b.html')
    useLayoutStore.getState().closeHtmlPreview()
    expect(useLayoutStore.getState().rightPaneMode).toBe('files')
    expect(useLayoutStore.getState().htmlPreview).toBeNull()
  })

  it('toggles from the preview to the terminal and keeps the document', () => {
    useLayoutStore.getState().openHtmlPreview({ path: 'a.html', root: '/r', machineId: null, sessionId: 's' })
    useLayoutStore.getState().toggleRightPaneMode()
    expect(useLayoutStore.getState().rightPaneMode).toBe('terminal')
    expect(useLayoutStore.getState().htmlPreview?.path).toBe('a.html')
  })
})

describe('html preview rules', () => {
  it('recognises html paths', () => {
    expect(isHtmlPreviewPath('a/b.html')).toBe(true)
    expect(isHtmlPreviewPath('a/b.HTM')).toBe(true)
    expect(isHtmlPreviewPath('a/b.html.md')).toBe(false)
  })

  it('treats a request with no current document as blocked', () => {
    expect(previewRequestVerdict('sb-preview://abc/page.html', null)).toBe('block')
    expect(previewRequestVerdict('not a url', 'abc')).toBe('block')
    expect(previewRequestVerdict('about:blank', null)).toBe('allow')
  })

  it('keeps asset paths below the folder', () => {
    expect(previewAssetRelativePath('/assets/./app.css')).toBe('assets/app.css')
    expect(previewAssetRelativePath('/a/../../x')).toBeNull()
    expect(previewAssetRelativePath('/a%00b')).toBeNull()
    expect(previewAssetRelativePath('/')).toBeNull()
  })

  it('allows only the document itself as a navigation', () => {
    expect(previewNavigationAllowed('sb-preview://t/a.html#x', 'sb-preview://t/a.html')).toBe(true)
    expect(previewNavigationAllowed('sb-preview://t/b.html', 'sb-preview://t/a.html')).toBe(false)
    expect(previewNavigationAllowed('sb-preview://t/a.html', null)).toBe(false)
  })

  it('labels blocked requests without the scheme', () => {
    expect(blockedRequestLabel('https://fonts.example.com/css2?family=Inter')).toBe(
      'fonts.example.com/css2?family=Inter',
    )
  })

  it('follows the app theme unless the page theme is pinned', () => {
    expect(resolvePreviewColorScheme('app', 'light')).toBe('light')
    expect(resolvePreviewColorScheme('app', 'translucent')).toBe('dark')
    expect(resolvePreviewColorScheme('light', 'dark')).toBe('light')
  })

  it('formats console errors and the agent draft', () => {
    expect(previewConsoleLine('Uncaught ReferenceError: steps is not defined\n    at x', 88)).toBe(
      'ReferenceError: steps is not defined · :88',
    )
    expect(previewErrorsForAgent('design/a.html', ['E1'])).toBe(
      'The preview of design/a.html logged these errors:\n- E1',
    )
  })
})

describe('html preview CSP reports', () => {
  it('turns a CSP report into a blocked URL and drops the duplicate', async () => {
    const { cspBlockedUrl } = await import('../../src/renderer/services/html-preview-console')
    expect(
      cspBlockedUrl(
        `Connecting to 'https://example.com/x' violates the following Content Security Policy directive: "connect-src sb-preview: data: blob:". The action has been blocked.`,
      ),
    ).toEqual({ url: 'https://example.com/x', duplicate: false })
    expect(
      cspBlockedUrl(
        `Refused to load the stylesheet 'https://fonts.example.com/css2?family=Inter' because it violates the following Content Security Policy directive: "default-src sb-preview:".`,
      ),
    ).toEqual({ url: 'https://fonts.example.com/css2?family=Inter', duplicate: false })
    expect(
      cspBlockedUrl(
        `Fetch API cannot load https://example.com/x. Refused to connect because it violates the document's Content Security Policy.`,
      ),
    ).toEqual({ url: 'https://example.com/x', duplicate: true })
    expect(cspBlockedUrl('ReferenceError: steps is not defined')).toBeNull()
  })
})
