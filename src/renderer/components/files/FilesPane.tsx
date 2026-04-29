/**
 * Container for the right-pane "Files" mode (toggled via ⌘⇧E).
 *
 * Layout: left half = directory tree, right half = viewer. The split is
 * a simple flex 1:2 — narrow tree, wider viewer. We don't expose a resize
 * handle yet to keep this pass tight; the surrounding terminal-pane width
 * is already user-adjustable.
 */
import { FileTreePane } from './FileTreePane'
import { FileViewerPane } from './FileViewerPane'

export function FilesPane(): React.ReactElement {
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div
        style={{
          flex: '0 0 240px',
          minWidth: 180,
          borderRight: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        <FileTreePane />
      </div>
      <div style={{ flex: '1 1 0%', minWidth: 0, overflow: 'hidden' }}>
        <FileViewerPane />
      </div>
    </div>
  )
}
