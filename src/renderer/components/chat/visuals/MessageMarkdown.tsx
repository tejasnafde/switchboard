/**
 * An assistant message's markdown with its closed ```mermaid and ```chart
 * blocks drawn by ChatVisual and its ```html-live blocks run by HtmlLiveFrame.
 * A message with none renders exactly as before.
 */
import { forwardRef, useMemo, type CSSProperties } from 'react'
import { splitVisualBlocks } from '@shared/chat-visuals'
import { MarkdownWithCopyControls } from '../MarkdownWithCopyControls'
import { ChatVisual } from './ChatVisual'
import { HtmlLiveFrame } from './HtmlLiveFrame'

interface MessageMarkdownProps {
  markdown: string
  mutable: boolean
  className: string
  style?: CSSProperties
  /** The chat it is in: Save as file, Send to agent and the still image's backend. */
  sessionId?: string
}

export const MessageMarkdown = forwardRef<HTMLDivElement, MessageMarkdownProps>(function MessageMarkdown(
  { markdown, mutable, className, style, sessionId },
  ref,
) {
  const segments = useMemo(() => splitVisualBlocks(markdown), [markdown])
  if (segments.length === 1 && segments[0].kind === 'markdown') {
    return (
      <MarkdownWithCopyControls ref={ref} markdown={markdown} mutable={mutable} className={className} style={style} />
    )
  }
  return (
    <div ref={ref} className={className} style={style}>
      {segments.map((segment, i) =>
        segment.kind === 'markdown' ? (
          // Only the last piece can still be streaming.
          <MarkdownWithCopyControls
            key={`markdown-${i}`}
            markdown={segment.text}
            mutable={mutable && i === segments.length - 1}
            className=""
          />
        ) : segment.kind === 'html-live' ? (
          segment.closed || mutable ? (
            <HtmlLiveFrame
              key={`${i}:html-live:${segment.closed}`}
              source={segment.source}
              title={segment.title}
              closed={segment.closed}
              sessionId={sessionId}
            />
          ) : (
            // A finished message whose block never closed: plain code.
            <MarkdownWithCopyControls
              key={`markdown-${i}`}
              markdown={`\`\`\`html\n${segment.source}\n\`\`\``}
              mutable={false}
              className=""
            />
          )
        ) : (
          <ChatVisual key={`${i}:${segment.source}`} kind={segment.kind} source={segment.source} />
        ),
      )}
    </div>
  )
})
