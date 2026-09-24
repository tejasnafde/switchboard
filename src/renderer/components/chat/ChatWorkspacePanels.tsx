import { useCallback, useEffect, useRef, useState } from 'react'
import { useLayoutStore } from '../../stores/layout-store'
import { useAgentStore } from '../../stores/agent-store'
import { showDragOverlay, hideDragOverlay } from '../../services/dragOverlay'
import { nextChatPresentation, shouldShowChatFocusIndicator, type ChatPresentation } from '../../services/chatWorkspace'
import { ChatPanel } from './ChatPanel'

export function ChatWorkspacePanels({
  dataScienceMode,
  onOpenBeside,
}: {
  dataScienceMode: boolean
  onOpenBeside: () => void
}) {
  const chatSplitRatio = useLayoutStore((s) => s.chatSplitRatio)
  const setChatSplitRatio = useLayoutStore((s) => s.setChatSplitRatio)
  const primarySessionId = useLayoutStore((s) => s.primarySessionId)
  const secondarySessionId = useLayoutStore((s) => s.secondarySessionId)
  const focusedSlot = useLayoutStore((s) => s.focusedChatSlot)
  const focusChatSlot = useLayoutStore((s) => s.focusChatSlot)
  const closeChatSlot = useLayoutStore((s) => s.closeChatSlot)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(1000)
  const [splitDragging, setSplitDragging] = useState(false)
  const [chatPresentation, setChatPresentation] = useState<ChatPresentation>(
    dataScienceMode ? 'tabs' : 'split',
  )
  const primaryLabel = useAgentStore((state) =>
    state.sessions.find((session) => session.id === primarySessionId)?.title ?? 'Primary chat',
  )
  const secondaryLabel = useAgentStore((state) =>
    state.sessions.find((session) => session.id === secondarySessionId)?.title ?? 'Secondary chat',
  )

  useEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') setWorkspaceWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setChatPresentation((current) =>
      nextChatPresentation(current, workspaceWidth, dataScienceMode, splitDragging),
    )
  }, [workspaceWidth, dataScienceMode, splitDragging])

  const dual = secondarySessionId !== null
  const tabbed = dual && chatPresentation === 'tabs'
  const showFocusIndicator = shouldShowChatFocusIndicator(dual, chatPresentation)

  return (
    <div
      ref={workspaceRef}
      data-chat-workspace
      data-chat-presentation={chatPresentation}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      {tabbed && (
        <div className="chat-workspace-tabs" role="tablist" aria-label="Chats side by side">
          <button
            type="button"
            role="tab"
            aria-selected={focusedSlot === 'primary'}
            onClick={() => focusChatSlot('primary')}
          >
            {primaryLabel}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={focusedSlot === 'secondary'}
            onClick={() => focusChatSlot('secondary')}
          >
            {secondaryLabel}
          </button>
        </div>
      )}
      <div style={{ flex: '1 1 0%', minHeight: 0, minWidth: 0, display: 'flex' }}>
      <div
        ref={leftRef}
        data-chat-slot-wrapper="primary"
        style={{
          flex: dual && !tabbed ? `${chatSplitRatio} 1 0%` : '1 1 0%',
          display: tabbed && focusedSlot !== 'primary' ? 'none' : 'flex',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <ChatPanel
          chatSlot="primary"
          visible={!tabbed || focusedSlot === 'primary'}
          showFocusIndicator={showFocusIndicator}
          onClose={dual ? () => closeChatSlot('primary') : undefined}
          onOpenBeside={onOpenBeside}
        />
      </div>
      {dual && !tabbed && (
        <ChatSplitHandle
          leftRef={leftRef}
          rightRef={rightRef}
          initialRatio={chatSplitRatio}
          onCommit={setChatSplitRatio}
          onDraggingChange={setSplitDragging}
        />
      )}
      <div
        ref={rightRef}
        data-chat-slot-wrapper="secondary"
        style={{
          flex: !tabbed ? `${1 - chatSplitRatio} 1 0%` : '1 1 0%',
          display: !dual || (tabbed && focusedSlot !== 'secondary') ? 'none' : 'flex',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <ChatPanel
          chatSlot="secondary"
          visible={dual && (!tabbed || focusedSlot === 'secondary')}
          showFocusIndicator={showFocusIndicator}
          onClose={() => closeChatSlot('secondary')}
          onOpenBeside={onOpenBeside}
        />
      </div>
      </div>
    </div>
  )
}

/**
 * Drag handle between two ChatPanels. Writes flex-grow directly to the
 * two panel DOM nodes during drag (no React re-renders). Commits the
 * final ratio to the store on pointerup.
 */
function ChatSplitHandle({
  leftRef,
  rightRef,
  initialRatio,
  onCommit,
  onDraggingChange,
}: {
  leftRef: React.RefObject<HTMLDivElement | null>
  rightRef: React.RefObject<HTMLDivElement | null>
  initialRatio: number
  onCommit: (ratio: number) => void
  onDraggingChange?: (dragging: boolean) => void
}) {
  const activePointerRef = useRef<number | null>(null)
  const currentRatioRef = useRef(initialRatio)
  const handleElRef = useRef<HTMLDivElement | null>(null)

  // Single idempotent teardown so the divider can never get stuck in resize
  // mode. Called from pointerup, pointercancel, lostpointercapture (pointer
  // crossed into a ChatPanel webview and capture was yanked), and window blur.
  const endDrag = useCallback(() => {
    if (activePointerRef.current === null) return
    const el = handleElRef.current
    // releasePointerCapture throws routinely (capture already lost/yanked by a
    // webview) - this is the expected, high-frequency case, not a bug.
    // eslint-disable-next-line no-restricted-syntax -- see comment above
    if (el) { try { el.releasePointerCapture(activePointerRef.current) } catch { /* ignore */ } }
    activePointerRef.current = null
    onDraggingChange?.(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    hideDragOverlay()
    onCommit(currentRatioRef.current)
  }, [onCommit, onDraggingChange])

  useEffect(() => {
    const onBlur = () => endDrag()
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      // Unmounted mid-drag: clear the stuck cursor / overlay.
      if (activePointerRef.current !== null) {
        activePointerRef.current = null
        onDraggingChange?.(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        hideDragOverlay()
      }
    }
  }, [endDrag, onDraggingChange])

  return (
    <div
      ref={handleElRef}
      style={{
        width: '4px',
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'var(--border)',
        position: 'relative',
        touchAction: 'none',
      }}
      onPointerDown={(e) => {
        // setPointerCapture can throw for an already-released pointer id;
        // routine, not worth logging.
        // eslint-disable-next-line no-restricted-syntax -- see comment above
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
        activePointerRef.current = e.pointerId
        onDraggingChange?.(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        showDragOverlay('col-resize')
      }}
      onPointerMove={(e) => {
        if (activePointerRef.current !== e.pointerId) return
        const row = (e.currentTarget as HTMLElement).parentElement
        if (!row) return
        const rect = row.getBoundingClientRect()
        const local = e.clientX - rect.left
        const ratio = Math.max(0.2, Math.min(0.8, local / rect.width))
        currentRatioRef.current = ratio
        // Direct DOM writes - no React re-render during drag.
        if (leftRef.current) leftRef.current.style.flex = `${ratio} 1 0%`
        if (rightRef.current) rightRef.current.style.flex = `${1 - ratio} 1 0%`
      }}
      onPointerUp={() => endDrag()}
      onPointerCancel={() => endDrag()}
      onLostPointerCapture={() => endDrag()}
    />
  )
}
