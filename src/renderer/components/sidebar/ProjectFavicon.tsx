/**
 * Sidebar leading icon for a project. Tries to load the project's
 * auto-detected favicon (`<img src="sb-favicon://favicon?path=...">`); on
 * any load error — including no favicon found (404) or non-image content —
 * falls back to a generic folder glyph that visually matches the rest of
 * the sidebar.
 *
 * The protocol handler lives in main/protocol/sb-favicon.ts and is
 * registered in main/index.ts. The renderer doesn't know or care what's
 * on disk — it just hits the URL and lets `<img onError>` decide whether
 * to swap to the fallback.
 *
 * Cross-platform note: the project path is percent-encoded into a query
 * param so backslashes / colons / spaces from Windows paths survive the
 * URL roundtrip without ambiguity.
 */
import { useState } from 'react'

interface Props {
  projectPath: string
  size?: number
}

function FolderFallback({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export function ProjectFavicon({ projectPath, size = 14 }: Props) {
  const [errored, setErrored] = useState(false)
  const src = `sb-favicon://favicon?path=${encodeURIComponent(projectPath)}`
  if (errored) {
    return (
      <span className="sidebar-project-favicon" aria-hidden="true">
        <FolderFallback size={size} />
      </span>
    )
  }
  return (
    <span className="sidebar-project-favicon" aria-hidden="true">
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        onError={() => setErrored(true)}
        loading="eager"
        draggable={false}
      />
    </span>
  )
}
