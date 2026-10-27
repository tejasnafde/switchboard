/**
 * Which inline live frames run (at most HTML_LIVE_MAX_RUNNING per window; the
 * rule is `pickRunningFrames`), which ones take a hidden still capture in the
 * slots left free (`html-live-still-scheduler.ts`), plus this window's still
 * images and Save as file paths by page key, so a paused frame and the pane
 * read the same copy.
 */
import { useSyncExternalStore } from 'react'
import { pickRunningFrames, type HtmlLiveFrameClaim } from '@shared/html-live'
import { createStillScheduler } from './html-live-still-scheduler'

const claims = new Map<string, HtmlLiveFrameClaim>()
let running = new Set<string>()
const stills = createStillScheduler()
let hidden = new Set<string>()
const listeners = new Set<() => void>()
const images = new Map<string, string>()
const savedPaths = new Map<string, string>()
const IMAGE_LIMIT = 24
let version = 0

function changed(): void {
  running = pickRunningFrames([...claims.values()])
  hidden = stills.pick(running)
  version++
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function claimFrame(id: string): void {
  if (!claims.has(id)) claims.set(id, { id, wants: false, since: 0 })
}

export function releaseFrame(id: string): void {
  stills.cancel(id)
  if (claims.delete(id)) changed()
}

/** In view (and nothing stops it): it wants to run, newest first. */
export function setFrameWants(id: string, wants: boolean): void {
  const claim = claims.get(id)
  if (!claim || claim.wants === wants) return
  claims.set(id, { ...claim, wants, since: wants ? Date.now() : claim.since })
  changed()
}

/** Run pressed on a paused frame: it displaces the one that has run longest. */
export function runFrame(id: string): void {
  const claim = claims.get(id)
  if (!claim) return
  claims.set(id, { ...claim, wants: true, since: Date.now() })
  changed()
}

export function useFrameRunning(id: string): boolean {
  return useSyncExternalStore(subscribe, () => running.has(id))
}

/**
 * The frame has no still image anywhere and may run but is not in view: it
 * may take a hidden capture of `key` once a slot is free. `null` drops the request.
 */
export function setFrameStillRequest(id: string, key: string | null): void {
  if (key && !claims.has(id)) return
  if (key ? stills.request(id, key) : stills.cancel(id)) changed()
}

/** The hidden capture of `key` ended: no frame in this window captures it hidden again. */
export function finishHiddenStill(id: string, key: string): void {
  stills.finish(id, key)
  changed()
}

export function useFrameHiddenStill(id: string): boolean {
  return useSyncExternalStore(subscribe, () => hidden.has(id))
}

export function rememberImage(key: string, url: string): void {
  stills.markDone(key)
  images.delete(key)
  images.set(key, url)
  if (images.size > IMAGE_LIMIT) images.delete(images.keys().next().value as string)
  changed()
}

export function rememberSavedPath(key: string, path: string): void {
  savedPaths.set(key, path)
  changed()
}

export function useLivePageMemory(key: string | null): { image: string | null; savedPath: string | null } {
  useSyncExternalStore(subscribe, () => version)
  return { image: key ? (images.get(key) ?? null) : null, savedPath: key ? (savedPaths.get(key) ?? null) : null }
}
