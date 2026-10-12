import {
  createContext,
  useContext,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
} from 'react'

/**
 * A disclosure: a real button that shows and hides a region, with
 * `aria-expanded` and `aria-controls`, so Tab reaches it and Enter or Space
 * toggles it. The API follows Radix Collapsible (`Collapsible`,
 * `CollapsibleTrigger`, `CollapsibleContent`, `data-state`). The closed
 * region is not rendered, so a long hidden list costs nothing.
 */
interface CollapsibleState {
  open: boolean
  toggle: () => void
  contentId: string
}

const CollapsibleContext = createContext<CollapsibleState | null>(null)

function useCollapsible(part: string): CollapsibleState {
  const state = useContext(CollapsibleContext)
  if (!state) throw new Error(`${part} must be inside a Collapsible`)
  return state
}

/** Whether the nearest Collapsible is open, for a trigger's own chevron. */
export function useCollapsibleOpen(): boolean {
  return useCollapsible('useCollapsibleOpen').open
}

export function Collapsible({
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = controlled ?? uncontrolled
  const contentId = useId()
  const toggle = () => {
    if (controlled === undefined) setUncontrolled(!open)
    onOpenChange?.(!open)
  }
  return (
    <CollapsibleContext.Provider value={{ open, toggle, contentId }}>
      <div data-state={open ? 'open' : 'closed'} {...props} />
    </CollapsibleContext.Provider>
  )
}

export function CollapsibleTrigger({ onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, toggle, contentId } = useCollapsible('CollapsibleTrigger')
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      data-state={open ? 'open' : 'closed'}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (!event.defaultPrevented) toggle()
      }}
      {...props}
    />
  )
}

export function CollapsibleContent(props: HTMLAttributes<HTMLDivElement>) {
  const { open, contentId } = useCollapsible('CollapsibleContent')
  if (!open) return null
  return <div id={contentId} data-state="open" {...props} />
}
