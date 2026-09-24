import { useSyncExternalStore } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from './alert-dialog'
import { Button } from './button'

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void
}

// One dialog at a time: later requests wait in line behind the open one.
const queue: PendingConfirm[] = []
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const current = (): PendingConfirm | undefined => queue[0]

function settle(request: PendingConfirm, confirmed: boolean): void {
  // Action fires onClick and then onOpenChange(false); the second call must
  // not answer the request that has just moved to the front.
  if (queue[0] !== request) return
  queue.shift()
  request.resolve(confirmed)
  for (const listener of listeners) listener()
}

// While a confirm is open it owns the keyboard, as window.confirm did. Escape
// answers it: the host modals close on any Escape, some from a window capture
// listener that would run before Radix's document one. App shortcuts wait: a
// chat switch or a ⌘L append under the dialog changes what the answer acts on.
// Registered at module load so it runs ahead of every component's listener.
function holdKeysWhileOpen(event: KeyboardEvent): void {
  const pending = current()
  if (!pending) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    // A held Escape must not also cancel the confirm queued behind this one.
    if (!event.repeat) settle(pending, false)
    return
  }
  if (event.metaKey || event.ctrlKey) event.stopImmediatePropagation()
}
if (typeof window !== 'undefined') window.addEventListener('keydown', holdKeysWhileOpen, true)

/** In-app replacement for window.confirm. Resolves true on confirm, false on cancel or Escape. Needs <ConfirmHost /> mounted. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ ...options, resolve })
    for (const listener of listeners) listener()
  })
}

/** True while a confirm dialog is on screen, for host modals that trap keys on the document. */
export function isConfirmOpen(): boolean {
  return queue.length > 0
}

export function ConfirmHost() {
  const request = useSyncExternalStore(subscribe, current)
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => { if (!open && request) settle(request, false) }}>
      {request && (
        // Radix wires aria-describedby to the description; with no body there is none to point at.
        <AlertDialogContent {...(request.body ? {} : { 'aria-describedby': undefined })}>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          {request.body && <AlertDialogDescription>{request.body}</AlertDialogDescription>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogCancel asChild>
              <Button variant="outline">{request.cancelLabel ?? 'Cancel'}</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button variant={request.destructive ? 'destructive' : 'default'} onClick={() => settle(request, true)}>
                {request.confirmLabel ?? 'OK'}
              </Button>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      )}
    </AlertDialog>
  )
}
