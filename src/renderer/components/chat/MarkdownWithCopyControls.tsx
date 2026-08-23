import {
  Component,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from 'react'
import { marked, Renderer, type Tokens } from 'marked'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:markdown-copy')

interface RenderMarkdownOptions {
  mutable?: boolean
}

interface MarkdownWithCopyControlsProps extends RenderMarkdownOptions {
  markdown: string
  className?: string
  style?: CSSProperties
}

interface ClosestTarget {
  closest: (selector: string) => unknown
}

interface CopyButtonTarget extends ClosestTarget {
  dataset?: { codeCopyIndex?: string }
}

interface CodeContainer {
  querySelector: (selector: string) => { textContent?: string | null } | null
}

interface FeedbackButtonTarget {
  textContent: string | null
  classList: { toggle: (name: string, force: boolean) => void }
  setAttribute: (name: string, value: string) => void
}

interface FocusRoot<T> {
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null
  contains: (target: T) => boolean
}

export const COPY_FEEDBACK_MS = 1500

function findCopyButton(target: unknown): CopyButtonTarget | null {
  if (!target || typeof (target as Partial<ClosestTarget>).closest !== 'function') return null
  return ((target as ClosestTarget).closest('.code-copy-btn') as CopyButtonTarget | null) ?? null
}

export async function copyCodeFromTarget(
  target: unknown,
  writeText: (text: string) => Promise<void>,
  onError?: (error: unknown) => void,
): Promise<number | null> {
  const button = findCopyButton(target)
  const index = Number(button?.dataset?.codeCopyIndex)
  const pre = button?.closest('pre') as CodeContainer | null | undefined
  const code = pre?.querySelector('code')
  if (!button || !Number.isInteger(index) || !code) return null

  try {
    await writeText(code.textContent ?? '')
    return index
  } catch (error) {
    onError?.(error)
    return null
  }
}

export function focusedCopyIndexBeforeReplacement<T>(
  root: Pick<FocusRoot<T>, 'contains'>,
  activeElement: T,
): number | null {
  if (!root.contains(activeElement)) return null
  const button = findCopyButton(activeElement)
  const index = Number(button?.dataset?.codeCopyIndex)
  return button && Number.isInteger(index) ? index : null
}

export function scheduleCopyFeedback<T>(
  index: number,
  setCopiedIndex: (index: number | null) => void,
  schedule: (callback: () => void, delayMs: number) => T,
  cancel: (timer: T) => void,
): () => void {
  setCopiedIndex(index)
  const timer = schedule(() => setCopiedIndex(null), COPY_FEEDBACK_MS)
  return () => cancel(timer)
}

export function applyCopyButtonFeedback(
  button: FeedbackButtonTarget,
  index: number,
  copied: boolean,
): void {
  button.textContent = copied ? 'Copied' : 'Copy'
  button.classList.toggle('copied', copied)
  button.setAttribute('aria-label', `${copied ? 'Copied' : 'Copy'} code block ${index + 1}`)
}

export function restoreCopyButtonFocus<T>(
  root: FocusRoot<T>,
  index: number | null,
  activeElement: T,
  bodyElement: T,
): boolean {
  if (index === null || (activeElement !== bodyElement && !root.contains(activeElement))) return false
  const button = root.querySelector(
    `[data-code-state="settled"] [data-code-copy-index="${index}"]`,
  )
  if (!button) return false
  button.focus({ preventScroll: true })
  return true
}

export function wrapRenderedCodeBlock(
  defaultCodeBlock: string,
  state: 'provisional' | 'settled',
  index: number,
): string {
  const code = /^<pre>([\s\S]*)<\/pre>\n?$/.exec(defaultCodeBlock)?.[1]
  if (code === undefined) return defaultCodeBlock
  const button = `<button class="code-copy-btn" type="button" aria-label="Copy code block ${index + 1}" aria-live="polite" data-code-copy-index="${index}">Copy</button>`
  return `<pre class="markdown-code-block" data-code-state="${state}">${code}${button}</pre>\n`
}

function hasClosingFence(raw: string): boolean {
  const lines = raw.replace(/\n$/, '').split('\n')
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])?.[1]
  if (!opening) return false
  return lines.slice(1).some((line) => {
    const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(line)?.[1]
    return !!closing &&
      closing.length >= opening.length &&
      [...closing].every((char) => char === opening[0])
  })
}

export function renderMarkdownWithCopyControls(
  markdown: string,
  { mutable = false }: RenderMarkdownOptions = {},
): string {
  const renderer = new Renderer()
  const renderCode = renderer.code.bind(renderer)
  let blockIndex = 0

  renderer.code = (token: Tokens.Code) => {
    const index = blockIndex++
    const state = !mutable || hasClosingFence(token.raw) ? 'settled' : 'provisional'
    return wrapRenderedCodeBlock(renderCode(token), state, index)
  }

  return marked.parse(markdown, { async: false, renderer }) as string
}

interface AtomicMarkdownRootProps {
  html: string
  className: string
  style?: CSSProperties
  rootRef: RefObject<HTMLDivElement | null>
  onClick: (event: MouseEvent<HTMLDivElement>) => void
}

class AtomicMarkdownRoot extends Component<AtomicMarkdownRootProps> {
  getSnapshotBeforeUpdate(previousProps: AtomicMarkdownRootProps): number | null {
    if (previousProps.html === this.props.html) return null
    const root = this.props.rootRef.current
    return root ? focusedCopyIndexBeforeReplacement(root, document.activeElement) : null
  }

  componentDidUpdate(
    _previousProps: AtomicMarkdownRootProps,
    _previousState: unknown,
    focusedIndex: number | null,
  ): void {
    const root = this.props.rootRef.current
    if (root && focusedIndex !== null) {
      restoreCopyButtonFocus(root, focusedIndex, document.activeElement, document.body)
    }
  }

  render() {
    return (
      <div
        ref={this.props.rootRef}
        className={this.props.className}
        style={this.props.style}
        onClick={this.props.onClick}
        dangerouslySetInnerHTML={{ __html: this.props.html }}
      />
    )
  }
}

export const MarkdownWithCopyControls = forwardRef<HTMLDivElement, MarkdownWithCopyControlsProps>(
  function MarkdownWithCopyControls(
    { markdown, mutable = false, className = 'markdown-content', style },
    ref,
  ) {
    const [copiedBlockIndex, setCopiedBlockIndex] = useState<number | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const cancelFeedbackRef = useRef<(() => void) | null>(null)
    const previousFeedbackIndexRef = useRef<number | null>(null)
    const mountedRef = useRef(false)
    const rendered = useMemo(
      () => renderMarkdownWithCopyControls(markdown, { mutable }),
      [markdown, mutable],
    )

    useImperativeHandle(ref, () => rootRef.current as HTMLDivElement)

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        cancelFeedbackRef.current?.()
      }
    }, [])

    useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      const indices = new Set([previousFeedbackIndexRef.current, copiedBlockIndex])
      for (const index of indices) {
        if (index === null) continue
        const button = root.querySelector<HTMLButtonElement>(`[data-code-copy-index="${index}"]`)
        if (button) applyCopyButtonFeedback(button, index, index === copiedBlockIndex)
      }
      previousFeedbackIndexRef.current = copiedBlockIndex
    }, [copiedBlockIndex, rendered])

    const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
      if (!findCopyButton(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      const writeText = (text: string): Promise<void> => {
        if (typeof navigator.clipboard?.writeText !== 'function') {
          return Promise.reject(new Error('Clipboard API unavailable'))
        }
        return navigator.clipboard.writeText(text)
      }
      void copyCodeFromTarget(event.target, writeText, (error) => {
        log.warn('clipboard write failed', error)
      }).then((index) => {
        if (index === null || !mountedRef.current) return
        cancelFeedbackRef.current?.()
        cancelFeedbackRef.current = scheduleCopyFeedback(
          index,
          setCopiedBlockIndex,
          (callback, delayMs) => window.setTimeout(callback, delayMs),
          (timer) => window.clearTimeout(timer),
        )
      })
    }, [])

    return <AtomicMarkdownRoot
      html={rendered}
      className={className}
      style={style}
      rootRef={rootRef}
      onClick={handleClick}
    />
  },
)
