import { useState, useEffect, useRef } from 'react'
import type { QuestionAttachment } from '@shared/types'

interface QuestionCardProps {
  question: QuestionAttachment
  onAnswer?: (answers: string[][]) => void
}

/**
 * Interactive question UI (T3 Code style).
 * - One question shown at a time with "i/N" pagination
 * - Number keys 1-9 select options
 * - Single-select auto-advances 200ms after pick; multi-select waits for Next
 * - Submits all answers once the last question is advanced past
 */
export function QuestionCard({ question, onAnswer }: QuestionCardProps) {
  const answered = question.status === 'answered'
  const [qIdx, setQIdx] = useState(0)
  const [selections, setSelections] = useState<string[][]>(
    () => question.answers ?? question.questions.map(() => [])
  )
  // Free-text "None of the above" fallback, per question. When a question
  // has a non-empty otherText, that overrides any picked option(s) on
  // submit — the agent sees the typed string as the user's answer.
  const [otherTexts, setOtherTexts] = useState<string[]>(
    () => question.questions.map(() => '')
  )
  const [otherOpen, setOtherOpen] = useState<boolean[]>(
    () => question.questions.map(() => false)
  )
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeQ = question.questions[qIdx]
  const isLast = qIdx === question.questions.length - 1
  const activeSelections = selections[qIdx] ?? []
  const activeOther = otherTexts[qIdx] ?? ''
  const activeOtherOpen = otherOpen[qIdx] ?? false
  const isResponding = false // reserved for future async state

  const submitAll = (all: string[][]) => {
    if (answered) return
    // If a question has a non-empty free-text answer, use that as the
    // sole "selection" — agent sees the typed string instead of the
    // picked option(s). Lets users escape out of fixed-choice questions.
    const resolved = all.map((picks, i) => {
      const text = (otherTexts[i] ?? '').trim()
      if (text) return [text]
      return picks
    })
    onAnswer?.(resolved)
  }

  const advance = (all: string[][]) => {
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current)
      autoAdvanceRef.current = null
    }
    if (isLast) {
      submitAll(all)
    } else {
      setQIdx(qIdx + 1)
    }
  }

  const toggleOption = (label: string) => {
    if (answered || isResponding) return
    const q = activeQ
    const currentForQ = selections[qIdx] ?? []
    let nextForQ: string[]
    if (q.multiSelect) {
      nextForQ = currentForQ.includes(label)
        ? currentForQ.filter((l) => l !== label)
        : [...currentForQ, label]
    } else {
      nextForQ = [label]
    }
    const nextAll = selections.map((s, i) => (i === qIdx ? nextForQ : s))
    setSelections(nextAll)
    // Clicking a preset option clears any in-progress free-text for that
    // question — user can't "half-type" an Other answer AND pick an option.
    setOtherTexts((prev) => prev.map((t, i) => (i === qIdx ? '' : t)))
    setOtherOpen((prev) => prev.map((v, i) => (i === qIdx ? false : v)))

    // Single-select auto-advances after a short delay (T3 UX)
    if (!q.multiSelect && nextForQ.length > 0) {
      if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current)
      autoAdvanceRef.current = setTimeout(() => {
        autoAdvanceRef.current = null
        advance(nextAll)
      }, 200)
    }
  }

  // Keyboard shortcut handler — number keys 1-9
  useEffect(() => {
    if (answered || isResponding || !activeQ) return
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (target instanceof HTMLElement && target.closest('[contenteditable]:not([contenteditable="false"])')) return
      const digit = parseInt(e.key, 10)
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return
      const idx = digit - 1
      if (idx >= activeQ.options.length) return
      e.preventDefault()
      toggleOption(activeQ.options[idx].label)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qIdx, selections, answered, isResponding, activeQ?.id])

  // Cleanup auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current)
    }
  }, [])

  if (!activeQ) return null

  const totalQuestions = question.questions.length
  // User can advance if they picked ≥1 option OR typed a free-text answer.
  const canAdvance = activeSelections.length > 0 || activeOther.trim().length > 0

  return (
    <div
      style={{
        marginTop: '8px',
        border: '1px solid var(--warning)',
        borderRadius: 'var(--radius)',
        background: 'rgba(210, 153, 34, 0.04)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        {totalQuestions > 1 && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            padding: '1px 6px',
            borderRadius: '3px',
            background: 'var(--bg-tertiary)',
            color: 'var(--text-muted)',
          }}>
            {qIdx + 1}/{totalQuestions}
          </span>
        )}
        <span style={{
          fontSize: '10.5px',
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.7px',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {answered ? 'Answered' : activeQ.header}
        </span>
      </div>

      {/* Question text */}
      <div style={{ padding: '10px 12px 4px' }}>
        {activeQ.question && (
          <div style={{
            fontSize: '13px',
            color: 'var(--text-primary)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            marginBottom: '4px',
          }}>
            {activeQ.question}
          </div>
        )}
        {activeQ.multiSelect && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Select one or more, then click Next.
          </div>
        )}
      </div>

      {/* Options */}
      <div style={{
        padding: '4px 8px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
      }}>
        {activeQ.options.map((opt, i) => {
          const selected = activeSelections.includes(opt.label)
          const shortcut = i < 9 ? i + 1 : null

          return (
            <button
              key={`${activeQ.id}:${opt.label}`}
              type="button"
              disabled={answered || isResponding}
              onClick={() => toggleOption(opt.label)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '7px 10px',
                borderRadius: '6px',
                border: selected
                  ? '1px solid rgba(88, 166, 255, 0.4)'
                  : '1px solid transparent',
                background: selected
                  ? 'rgba(88, 166, 255, 0.08)'
                  : 'rgba(255, 255, 255, 0.02)',
                color: 'var(--text-primary)',
                cursor: answered ? 'default' : 'pointer',
                textAlign: 'left',
                transition: 'all 0.12s',
                opacity: answered && !selected ? 0.4 : 1,
              }}
              onMouseEnter={(e) => {
                if (!selected && !answered) {
                  ;(e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'
                  ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
                }
              }}
              onMouseLeave={(e) => {
                if (!selected && !answered) {
                  ;(e.currentTarget as HTMLElement).style.background = 'rgba(255, 255, 255, 0.02)'
                  ;(e.currentTarget as HTMLElement).style.borderColor = 'transparent'
                }
              }}
            >
              {/* kbd shortcut badge */}
              {shortcut !== null && (
                <kbd style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '20px',
                  height: '20px',
                  borderRadius: '4px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  fontWeight: 500,
                  flexShrink: 0,
                  background: selected ? 'rgba(88, 166, 255, 0.2)' : 'var(--bg-tertiary)',
                  color: selected ? 'var(--accent)' : 'var(--text-muted)',
                }}>
                  {shortcut}
                </kbd>
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '12.5px',
                  fontWeight: 500,
                  color: selected ? 'var(--text-primary)' : 'var(--text-primary)',
                }}>
                  {opt.label}
                  {opt.description && opt.description !== opt.label && (
                    <span style={{
                      marginLeft: '8px',
                      fontSize: '11.5px',
                      color: 'var(--text-muted)',
                      fontWeight: 400,
                    }}>
                      {opt.description}
                    </span>
                  )}
                </div>
              </div>

              {/* Check icon when selected */}
              {selected && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          )
        })}

        {/* "None of the above" free-text escape. Always present so the
            user is never forced into one of the agent's picked options. */}
        {!answered && (
          <OtherOption
            isOpen={activeOtherOpen}
            text={activeOther}
            hasOther={activeOther.trim().length > 0}
            onOpen={() => {
              setOtherOpen((prev) => prev.map((v, i) => (i === qIdx ? true : v)))
              // Clear any picked options when switching to free-text
              setSelections((prev) => prev.map((s, i) => (i === qIdx ? [] : s)))
              // Cancel pending auto-advance if any
              if (autoAdvanceRef.current) {
                clearTimeout(autoAdvanceRef.current)
                autoAdvanceRef.current = null
              }
            }}
            onChange={(text) => {
              setOtherTexts((prev) => prev.map((t, i) => (i === qIdx ? text : t)))
            }}
            onCancel={() => {
              setOtherOpen((prev) => prev.map((v, i) => (i === qIdx ? false : v)))
              setOtherTexts((prev) => prev.map((t, i) => (i === qIdx ? '' : t)))
            }}
          />
        )}
      </div>

      {/* Footer — multi-select or manual advance */}
      {!answered && (activeQ.multiSelect || totalQuestions > 1) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          borderTop: '1px solid var(--border)',
          background: 'rgba(0, 0, 0, 0.04)',
        }}>
          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
            Press <kbd style={kbdStyle}>1-{Math.min(activeQ.options.length, 9)}</kbd> to pick
            {activeQ.multiSelect ? ' · toggle to multi-select' : ''}
          </span>
          <span style={{ flex: 1 }} />
          {qIdx > 0 && (
            <button
              onClick={() => setQIdx(qIdx - 1)}
              style={btnGhost}
            >
              Back
            </button>
          )}
          <button
            onClick={() => advance(selections)}
            disabled={!canAdvance}
            style={canAdvance ? btnPrimary : btnDisabled}
          >
            {isLast ? 'Submit' : 'Next'}
          </button>
        </div>
      )}
    </div>
  )
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  padding: '0 4px',
  borderRadius: '3px',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
}

const btnPrimary: React.CSSProperties = {
  padding: '4px 12px',
  borderRadius: '4px',
  border: 'none',
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '11.5px',
  fontWeight: 600,
}

const btnDisabled: React.CSSProperties = {
  ...btnPrimary,
  background: 'var(--bg-tertiary)',
  color: 'var(--text-muted)',
  cursor: 'default',
}

const btnGhost: React.CSSProperties = {
  padding: '4px 12px',
  borderRadius: '4px',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: '11.5px',
}

/**
 * "None of the above" escape hatch.
 *
 * Collapsed state: a dashed-border row labeled "None of the above — let
 * me explain…". Click it to expand.
 *
 * Expanded state: a single-line textarea + a small Cancel (×) button.
 * Typing in the textarea overrides any picked option when the user
 * advances — their typed string becomes the answer the agent sees.
 */
function OtherOption({
  isOpen,
  text,
  hasOther,
  onOpen,
  onChange,
  onCancel,
}: {
  isOpen: boolean
  text: string
  hasOther: boolean
  onOpen: () => void
  onChange: (text: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 20)
  }, [isOpen])

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          width: '100%',
          padding: '7px 10px',
          borderRadius: '6px',
          border: '1px dashed var(--border)',
          background: 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '12px',
          fontStyle: 'italic',
          transition: 'all 0.12s',
        }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'
          ;(e.currentTarget as HTMLElement).style.borderStyle = 'solid'
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = 'transparent'
          ;(e.currentTarget as HTMLElement).style.borderStyle = 'dashed'
        }}
      >
        <span style={{ flexShrink: 0, opacity: 0.7 }}>+</span>
        <span>None of the above — let me explain…</span>
      </button>
    )
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '6px',
      padding: '4px',
      borderRadius: '6px',
      border: '1px solid rgba(88, 166, 255, 0.4)',
      background: 'rgba(88, 166, 255, 0.06)',
    }}>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Tell the agent what you'd rather do…"
        rows={2}
        style={{
          flex: 1,
          resize: 'none',
          padding: '6px 8px',
          borderRadius: '4px',
          border: '1px solid transparent',
          background: 'transparent',
          color: 'var(--text-primary)',
          fontSize: '12.5px',
          fontFamily: 'var(--font-sans)',
          lineHeight: 1.4,
          outline: 'none',
          minHeight: '36px',
          maxHeight: '140px',
        }}
      />
      <button
        type="button"
        onClick={onCancel}
        title="Cancel — back to preset options"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          padding: '2px 6px',
          fontSize: '14px',
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ×
      </button>
      {hasOther && (
        <span style={{
          position: 'absolute',
          fontSize: '10px',
          color: 'var(--accent)',
          padding: '2px 6px',
          pointerEvents: 'none',
          right: 0,
          bottom: 0,
          visibility: 'hidden', // reserved hook for future "will override" hint
        }}>
          Overrides picks
        </span>
      )}
    </div>
  )
}
