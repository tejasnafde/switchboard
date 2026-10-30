/**
 * The one live page this phone runs (`phoneLiveRunning` in
 * @shared/html-live-phone). Cards register while mounted; the thread screen
 * reports list scrolls, focus and background. After the list has been still
 * for `PHONE_LIVE_STILL_MS` every card measures how much of it is on screen
 * and the rule picks at most one. Crash counts live for this app run only.
 */
import { PHONE_LIVE_MAX_CRASHES, PHONE_LIVE_STILL_MS, phoneLiveRunning } from '@shared/html-live-phone'
import { createLogger } from '@shared/logger'

const log = createLogger('html-live')

/**
 * Whether this phone must wait for Run. expo-device is not a dependency, so
 * the app cannot read the phone's memory, and unknown memory counts as low.
 */
export const LIVE_PAGES_LOW_RAM = true

interface Entry {
  pageKey: string
  /** Part of the card on screen, 0 to 1. */
  measure: () => Promise<number>
  runPressed: boolean
  fullScreen: boolean
}

const entries = new Map<string, Entry>()
const crashes = new Map<string, number>()
const listeners = new Set<() => void>()
let running: string | null = null
let active = false
let lastScrollAt = 0
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0

function setRunning(id: string | null): void {
  if (id === running) return
  running = id
  for (const listener of listeners) listener()
}

async function decide(): Promise<void> {
  const mine = ++generation
  if (!active) return setRunning(null)
  const ids = [...entries.keys()]
  const visible = await Promise.all(
    ids.map(
      (id) =>
        entries
          .get(id)
          ?.measure()
          .catch((error: unknown) => {
            log.warn('live page measure failed', error)
            return 0
          }) ?? 0,
    ),
  )
  if (mine !== generation) return
  const pageCrashes = new Map<string, number>()
  const candidates = ids.flatMap((id, i) => {
    const entry = entries.get(id)
    if (!entry) return []
    pageCrashes.set(id, crashes.get(entry.pageKey) ?? 0)
    return [{ key: id, visible: visible[i], runPressed: entry.runPressed, fullScreen: entry.fullScreen }]
  })
  setRunning(
    phoneLiveRunning(candidates, {
      listStillMs: Date.now() - lastScrollAt,
      lowRam: LIVE_PAGES_LOW_RAM,
      crashes: pageCrashes,
    }),
  )
}

/** Decide once the list has been still long enough. A scroll keeps the current page until then. */
function schedule(): void {
  if (timer) clearTimeout(timer)
  const wait = Math.max(0, lastScrollAt + PHONE_LIVE_STILL_MS - Date.now())
  timer = setTimeout(() => {
    timer = null
    void decide()
  }, wait)
}

function update(id: string, change: Partial<Entry>): void {
  const entry = entries.get(id)
  if (!entry) return
  Object.assign(entry, change)
  schedule()
}

export function registerLivePage(id: string, pageKey: string, measure: () => Promise<number>): () => void {
  entries.set(id, { pageKey, measure, runPressed: false, fullScreen: false })
  schedule()
  return () => {
    entries.delete(id)
    if (running === id) setRunning(null)
    schedule()
  }
}

export function setLivePageRun(id: string, runPressed: boolean): void {
  update(id, { runPressed })
}

export function setLivePageFullScreen(id: string, fullScreen: boolean): void {
  update(id, { fullScreen })
}

/** The page stopped on its own (watchdog, reload loop): it waits for Run again. */
export function stopLivePage(id: string): void {
  if (running === id) setRunning(null)
  update(id, { runPressed: false, fullScreen: false })
}

/** The WebContent process died. No auto-retry; two crashes block the page key for this app run. */
export function noteLivePageCrash(id: string): void {
  const entry = entries.get(id)
  if (entry) crashes.set(entry.pageKey, (crashes.get(entry.pageKey) ?? 0) + 1)
  stopLivePage(id)
}

export function livePageCrashes(pageKey: string): number {
  return crashes.get(pageKey) ?? 0
}

export function livePageBlocked(pageKey: string): boolean {
  return livePageCrashes(pageKey) >= PHONE_LIVE_MAX_CRASHES
}

export function noteLivePageScroll(): void {
  lastScrollAt = Date.now()
  schedule()
}

/** The thread screen is focused and the app is in the foreground. Off stops the page at once. */
export function setLivePagesActive(on: boolean): void {
  active = on
  if (!on) {
    generation++
    setRunning(null)
  }
  schedule()
}

export function runningLivePage(): string | null {
  return running
}

export function subscribeLivePages(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: module state outlives a component. */
export function resetLivePages(): void {
  if (timer) clearTimeout(timer)
  timer = null
  entries.clear()
  crashes.clear()
  running = null
  active = false
  lastScrollAt = 0
  generation++
}
