/**
 * An assistant message's markdown with its closed ```mermaid and ```chart
 * blocks drawn by ChatVisual. A message with none renders exactly as before.
 */
import { forwardRef, useMemo, type CSSProperties } from 'react'
import { splitVisualBlocks } from '@shared/chat-visuals'
import { MarkdownWithCopyControls } from '../MarkdownWithCopyControls'
import { ChatVisual } from './ChatVisual'

interface MessageMarkdownProps {
  markdown: string
  mutable: boolean
  className: string
  style?: CSSProperties
}

export const MessageMarkdown = forwardRef<HTMLDivElement, MessageMarkdownProps>(
  function MessageMarkdown({ markdown, mutable, className, style }, ref) {
    const segments = useMemo(() => splitVisualBlocks(markdown), [markdown])
    if (segments.length === 1 && segments[0].kind === 'markdown') {
      return <MarkdownWithCopyControls ref={ref} markdown={markdown} mutable={mutable} className={className} style={style} />
    }
    return (
      <div ref={ref} className={className} style={style}>
        {segments.map((segment, i) => segment.kind === 'markdown'
          // Only the last piece can still be streaming.
          ? <MarkdownWithCopyControls key={`markdown-${i}`} markdown={segment.text} mutable={mutable && i === segments.length - 1} className="" />
          : <ChatVisual key={`${i}:${segment.source}`} kind={segment.kind} source={segment.source} />)}
      </div>
    )
  },
)
