import { useMemo, type ReactNode } from 'react'
import type { ChatMessage, ToolCall } from '@shared/types'
import {
  subagentStatusParts,
  subagentView,
  type SubagentDisplayItem,
  type SubagentStep,
  type SubagentView,
} from '@shared/subagent-steps'
import {
  backgroundTaskLabel,
  backgroundTaskSubject,
  syntheticPartDetail,
  syntheticPartTone,
  type SyntheticTone,
} from '@shared/synthetic-message'
import { cn } from '../../lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsibleOpen } from '../ui/collapsible'
import { HistoryToolCall } from './HistoryToolCall'
import { MessageMarkdown } from './visuals/MessageMarkdown'
import { chatSubagentCompletions, chatSubagentSteps } from './subagent-messages'

interface SubagentRowProps {
  call: ToolCall
  /** When the Agent call started, for a background agent's duration. */
  startedAt: number
  /** The subagent's own rows, from `groupChatSubagents`. */
  steps: readonly ChatMessage[]
  /** A background subagent's own notices. */
  completions: readonly ChatMessage[]
  sessionId?: string
}

const TONE_DOT: Record<SyntheticTone, string> = {
  ok: 'bg-[var(--success)]',
  error: 'bg-[var(--error)]',
  warn: 'bg-[var(--warning)]',
  muted: 'bg-[var(--text-muted)]',
}

const monoClass = '[font-family:var(--font-mono)]'
const focusClass =
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--border-focus)]'
const foldClass = cn(
  'my-[1px] flex w-full cursor-pointer items-center gap-[6px] rounded-[var(--radius)] border-0 bg-transparent py-[3px] pr-[2px] pl-[4px] text-left text-[11px] text-[var(--text-secondary)] [font-family:var(--font-sans)] hover:bg-[var(--bg-hover)]',
  focusClass,
)

function Glyph({ children, size }: { children: ReactNode; size: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  )
}

function parsedInput(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function SubagentStatus({ view }: { view: SubagentView }) {
  const parts = subagentStatusParts(view)
  const sep = <span className="text-[var(--text-secondary)]"> · </span>
  const icon =
    view.status === 'running' ? (
      <span
        aria-hidden
        className="h-[10px] w-[10px] shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--border)] border-t-[var(--accent)]"
      />
    ) : view.status === 'done' ? (
      <span className="text-[var(--success)]">
        <Glyph size={11}>
          <polyline points="20 6 9 17 4 12" />
        </Glyph>
      </span>
    ) : (
      <span className="text-[var(--error)]">
        <Glyph size={11}>
          <path d="M18 6 6 18M6 6l12 12" />
        </Glyph>
      </span>
    )
  return (
    <span
      data-subagent-status={view.status}
      className="flex min-w-0 shrink-0 items-center gap-[5px] text-[11px] whitespace-nowrap text-[var(--text-secondary)] tabular-nums @max-[480px]/agent:order-last @max-[480px]/agent:basis-full @max-[480px]/agent:overflow-hidden @max-[480px]/agent:pl-[22px]"
    >
      {icon}
      <span className="min-w-0 overflow-hidden text-ellipsis">
        {view.status === 'failed' ? <b className="font-[500] text-[var(--error)]">{parts.lead}</b> : parts.lead}
        {parts.detail && (
          <>
            {sep}
            <span
              className={cn(
                'inline-block max-w-[200px] overflow-hidden align-bottom text-ellipsis whitespace-nowrap @max-[480px]/agent:max-w-none',
                monoClass,
              )}
            >
              {parts.detail}
            </span>
          </>
        )}
        {parts.meta.map((part) => (
          <span key={part}>
            {sep}
            {part}
          </span>
        ))}
      </span>
    </span>
  )
}

function NoticeRow({ step }: { step: Extract<SubagentStep, { kind: 'notice' }> }) {
  const label = backgroundTaskLabel(step.part.summary)
  const detail = syntheticPartDetail(step.part)
  const dot = (
    <span aria-hidden className={cn('h-[6px] w-[6px] shrink-0 rounded-full', TONE_DOT[syntheticPartTone(step.part)])} />
  )
  // Only a shortened label opens: a short description is already the whole notice.
  if (!detail || label === backgroundTaskSubject(step.part.summary)) {
    return (
      <div className="my-[2px] mr-[2px] ml-[6px] flex items-center gap-[6px] text-[11px] text-[var(--text-muted)]">
        {dot}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      </div>
    )
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className={cn(foldClass, 'ml-[2px] text-[var(--text-muted)]')}>
        {dot}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
        <ChevronState />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'mt-[2px] mr-0 mb-[6px] ml-[18px] rounded-[3px] border-l-2 border-l-[var(--border)] bg-[var(--bg-primary)] px-[10px] py-[4px] text-[11px] leading-[1.5] whitespace-pre-wrap text-[var(--text-secondary)] [word-break:break-word]',
          monoClass,
        )}
      >
        {detail}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A trigger's chevron, from the nearest Collapsible. */
function ChevronState({ className }: { className?: string }) {
  const open = useCollapsibleOpen()
  return (
    <span
      aria-hidden
      className={cn('w-[10px] shrink-0 text-center text-[10px] leading-none text-[var(--text-muted)]', className)}
    >
      {open ? '\u25BE' : '\u25B8'}
    </span>
  )
}

function Fold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className={foldClass}>
        <ChevronState />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mb-[2px] ml-[10px]">{children}</CollapsibleContent>
    </Collapsible>
  )
}

const exitLabel = (output: string | undefined) => {
  const code = output && /Exit code (\d+)/.exec(output)?.[1]
  return code ? `Exit ${code}` : 'Failed'
}

export function SubagentRow({ call, startedAt, steps, completions, sessionId }: SubagentRowProps) {
  const { view, calls } = useMemo(() => {
    const built = chatSubagentSteps(steps)
    return {
      calls: built.calls,
      view: subagentView(
        { input: parsedInput(call.input), output: call.output, isError: call.isError, startedAt },
        built.steps,
        chatSubagentCompletions(completions),
      ),
    }
  }, [call, startedAt, steps, completions])
  const lastItem = view.items.at(-1)

  const renderStep = (step: SubagentStep, failed = false, current = false): ReactNode => {
    if (step.kind === 'notice') return <NoticeRow key={step.key} step={step} />
    if (step.kind === 'text') {
      return (
        <div
          key={step.key}
          className="mx-[2px] my-[3px] text-[11.5px] leading-[1.5] whitespace-pre-wrap text-[var(--text-secondary)]"
        >
          {step.text}
        </div>
      )
    }
    const source = calls.get(step.key)
    if (!source) return null
    return (
      <div key={step.key}>
        <HistoryToolCall
          toolCall={source.call}
          sessionId={sessionId}
          messageId={source.messageId}
          step
          emphasis={failed ? 'failed' : current ? 'current' : undefined}
          statusLabel={failed ? exitLabel(step.output) : undefined}
        />
        {failed && step.output && (
          <div
            className={cn(
              'mt-[2px] mr-0 mb-[6px] ml-[18px] max-h-[240px] overflow-auto rounded-[3px] border-l-2 border-l-[var(--error)] bg-[var(--bg-primary)] px-[10px] py-[4px] text-[11px] leading-[1.5] whitespace-pre-wrap text-[var(--text-secondary)] [word-break:break-word]',
              monoClass,
            )}
          >
            {step.output}
          </div>
        )}
      </div>
    )
  }

  const renderItem = (item: SubagentDisplayItem): ReactNode => {
    if (item.kind === 'step') {
      const current =
        view.status === 'running' && item === lastItem && item.step.kind === 'tool' && item.step.output === undefined
      return renderStep(item.step, item.failed, current)
    }
    return (
      <Fold key={item.key} label={item.label}>
        {item.steps.map((step) => renderStep(step))}
      </Fold>
    )
  }

  return (
    <Collapsible
      data-subagent-row
      className="@container/agent mx-[16px] my-[4px] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-secondary)] text-[12px] in-[.theme-translucent]:bg-[rgba(0,0,0,0.18)]"
    >
      <CollapsibleTrigger
        className={cn(
          'flex w-full min-w-0 cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[8px] py-[6px] text-left text-[12px] text-[var(--text-secondary)] [font-family:var(--font-sans)] hover:bg-[var(--bg-hover)] @max-[480px]/agent:flex-wrap @max-[480px]/agent:gap-y-[2px]',
          focusClass,
        )}
      >
        <span className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center text-[var(--text-muted)]">
          <svg
            aria-hidden
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 8V4H8" />
            <rect x="4" y="8" width="16" height="12" rx="2" />
            <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
          </svg>
        </span>
        <span className="shrink-0 font-[500] text-[var(--text-primary)]">Agent</span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-primary)]">
          {view.description}
        </span>
        {view.model && (
          <span className={cn('shrink-0 text-[11px] text-[var(--text-secondary)]', monoClass)}>{view.model}</span>
        )}
        <SubagentStatus view={view} />
        <ChevronState className="text-[12px] text-[var(--text-secondary)]" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-[var(--border)] px-[8px] pt-[4px] pb-[6px]">
        <div className="ml-[7px] border-l border-[var(--border)] pl-[9px]">
          {view.items.map(renderItem)}
          {view.status === 'done' && view.result && (
            <div className="mx-0 mt-[6px] mb-[2px] rounded-[var(--radius)] bg-[var(--bg-primary)] px-[10px] py-[8px] text-[12px] leading-[1.55] text-[var(--text-secondary)] in-[.theme-translucent]:bg-[rgba(0,0,0,0.2)]">
              <div className="mb-[3px] text-[11px] text-[var(--text-muted)]">Result</div>
              <MessageMarkdown markdown={view.result} mutable={false} className="markdown-content" />
            </div>
          )}
          {view.items.length === 0 && !view.result && (
            <div className="mx-[2px] my-[3px] text-[11px] text-[var(--text-muted)]">
              {view.status === 'running' ? 'Waiting for the first step' : 'No steps recorded'}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
