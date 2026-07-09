/// <reference types="vite/client" />

import type { SwitchboardAPI } from '../preload'
import 'react'

declare global {
  interface Window {
    api: SwitchboardAPI
  }
}

// Electron-only CSS properties for custom title bar drag regions.
// Without this augmentation, React's CSSProperties rejects them.
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
    appRegion?: 'drag' | 'no-drag'
  }

  // Electron <webview> tag (webviewTag: true) - hosts the embedded IDE.
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
        },
        HTMLElement
      >
    }
  }
}
