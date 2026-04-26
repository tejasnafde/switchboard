import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

// Suppress the benign "ResizeObserver loop completed" warning that fires
// when observer callbacks cause layout changes within a single frame.
// It's a documented browser quirk, not a real error — React + tanstack
// virtual + our resizable panes all emit it. Without this, it floods the
// devtools console and hides real errors.
// See: https://github.com/WICG/resize-observer/issues/38
const RESIZE_OBSERVER_MSG = 'ResizeObserver loop completed with undelivered notifications'
const RESIZE_OBSERVER_LEGACY = 'ResizeObserver loop limit exceeded'
window.addEventListener('error', (e) => {
  if (e.message === RESIZE_OBSERVER_MSG || e.message === RESIZE_OBSERVER_LEGACY) {
    e.stopImmediatePropagation()
    e.preventDefault()
  }
})

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
