import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Project } from '@shared/types'
import { draftSessionId } from '@shared/new-chat-draft'
import { shortcutLabel } from '@shared/shortcuts'
import { useMachineStore } from '../../stores/machine-store'
import { useAgentStore } from '../../stores/agent-store'
import { useDraftStore } from '../../stores/draft-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { focusComposer, registerComposer } from '../../services/composer-registry'
import {
  LANDING_COMPOSER_ID,
  buildProjectTargets,
  defaultLandingTarget,
  landingChipLabel,
  landingRecentKey,
  landingSendBlock,
  landingShortcutHints,
  mergeMovedDraft,
  readRememberedPick,
  recentLandingChats,
  registerLandingProjectPicker,
  sameTarget,
  showMachineNames,
  writeRememberedPick,
  type LandingPick,
  type ProjectTarget,
  type RecentChat,
} from '../../services/chat-landing'
import { Combobox, type ComboboxOption } from '../ui/combobox'
import { ProjectFavicon } from '../sidebar/ProjectFavicon'
import { formatRelativeTime } from '../sidebar/sidebar-helpers'
import { ChatPanel } from './ChatPanel'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:landing')

const ADD_PROJECT = '\u0000add'
const optionValue = (t: LandingPick) => `${t.machineId}\u0000${t.projectPath}`

function draftHasContent(id: string): boolean {
  const state = useDraftStore.getState()
  return Boolean(state.drafts[id] || state.pillsBySession[id]?.length || state.imagesBySession[id]?.length)
}

/**
 * What the primary chat slot shows when no chat is open, or when cmd+shift+O
 * asked for a new one: a heading, the composer bound to the selected
 * project's draft with the project chip first in its bar, and the latest
 * chats. The first send goes through the draft materializer like any other
 * new chat.
 */
export function ChatLanding({
  ensureDraftSession,
  onOpenChat,
}: {
  ensureDraftSession: (projectPath: string, machineId: string) => Promise<string>
  onOpenChat: (chat: RecentChat) => void
}) {
  const [local, setLocal] = useState<Project[] | null>(null)
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const remoteProjects = useMachineStore((s) => s.projects)
  const [picked, setPicked] = useState<LandingPick | null>(null)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [highlight, setHighlight] = useState<number | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  // A draft in the primary slot (cmd+shift+O from a chat) names the project;
  // with an empty slot the landing screen picks one itself.
  const primarySessionId = useLayoutStore((s) => s.primarySessionId)
  const primaryDraftKey = useAgentStore((s) => {
    const session = primarySessionId ? s.sessions.find((x) => x.id === primarySessionId) : undefined
    return session?.draft && session.projectPath
      ? optionValue({ projectPath: session.projectPath, machineId: session.machineId ?? 'local' })
      : null
  })
  const primaryDraft = useMemo<LandingPick | null>(() => {
    if (!primaryDraftKey) return null
    const [machineId, projectPath] = primaryDraftKey.split('\u0000')
    return { machineId, projectPath }
  }, [primaryDraftKey])

  const loadProjects = useCallback(() => {
    window.api.app.getProjects()
      .then((projects: Project[]) => setLocal(projects))
      .catch((err: unknown) => log.warn('getProjects failed', err))
  }, [])

  useEffect(() => {
    loadProjects()
    window.addEventListener('sidebar-refresh', loadProjects)
    return () => window.removeEventListener('sidebar-refresh', loadProjects)
  }, [loadProjects])

  const remote = useMemo(() => ({ remotes, connections, projects: remoteProjects }), [remotes, connections, remoteProjects])
  const targets = useMemo(() => buildProjectTargets(local ?? [], remote), [local, remote])
  const recents = useMemo(() => recentLandingChats(local ?? [], remote), [local, remote])
  const pick = primaryDraft ?? picked
  const selected = useMemo(() => targets.find((t) => sameTarget(t, pick)) ?? null, [targets, pick])

  // The default is chosen once, so the chip does not move under the user
  // when the remembered draft is emptied or another project gets newer.
  useEffect(() => {
    if (local === null || primaryDraft || selected) return
    const fallback = defaultLandingTarget(
      targets,
      readRememberedPick(localStorage),
      (p) => draftHasContent(draftSessionId(p.machineId, p.projectPath)),
    )
    if (fallback) setPicked({ projectPath: fallback.projectPath, machineId: fallback.machineId })
  }, [local, targets, selected, primaryDraft])

  useEffect(() => {
    if (!selected) { setDraftId(null); return }
    try {
      writeRememberedPick(localStorage, selected)
    } catch (err) {
      log.warn('remembering the landing project failed', err)
    }
    let current = true
    ensureDraftSession(selected.projectPath, selected.machineId)
      .then((id) => { if (current) setDraftId(id) })
      .catch((err: unknown) => log.warn('opening the landing draft failed', err))
    return () => { current = false }
  }, [selected, ensureDraftSession])

  // Only the selected project's own draft may take input: a target that a
  // refresh or a disconnect removed must not be sent to on the next render.
  const liveDraftId = selected && draftId === draftSessionId(selected.machineId, selected.projectPath) ? draftId : null

  // While this shows, terminals, the IDE, cmd+L and cmd+K act on its draft.
  useEffect(() => {
    useLayoutStore.getState().setLandingDraftSession(liveDraftId)
  }, [liveDraftId])
  useEffect(() => () => useLayoutStore.getState().setLandingDraftSession(null), [])

  useEffect(() => registerComposer(LANDING_COMPOSER_ID, {
    focus: () => { if (!draftId || !focusComposer(draftId)) addButtonRef.current?.focus() },
  }), [draftId])

  // Focus the composer whenever the landing screen appears or its draft changes.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusComposer(LANDING_COMPOSER_ID))
    return () => cancelAnimationFrame(frame)
  }, [draftId])

  const noProjects = local !== null && targets.length === 0
  useEffect(() => registerLandingProjectPicker(() => {
    if (noProjects) addButtonRef.current?.focus()
    else setPickerOpen(true)
  }), [noProjects])

  const addProject = useCallback(async () => {
    try {
      const project = await window.api.app.openFolder()
      if (!project) return
      // Listed now, so the default pick does not run before the reload lands.
      setLocal((prev) => prev?.some((p) => p.path === project.path) ? prev : [...(prev ?? []), project])
      setPicked({ projectPath: project.path, machineId: 'local' })
      window.dispatchEvent(new CustomEvent('sidebar-refresh'))
      if (primaryDraft) useLayoutStore.getState().showLanding(await ensureDraftSession(project.path, 'local'))
    } catch (err) {
      log.warn('adding a project from the landing screen failed', err)
    }
  }, [ensureDraftSession, primaryDraft])

  // A later pick supersedes an earlier one still waiting on its draft, so
  // the typed text cannot land on a project the chip no longer shows.
  const chooseRequestRef = useRef(0)
  const choose = useCallback(async (target: ProjectTarget) => {
    if (sameTarget(target, selected)) return
    const request = ++chooseRequestRef.current
    const from = draftId
    let to: string
    try {
      to = await ensureDraftSession(target.projectPath, target.machineId)
    } catch (err) {
      log.warn('opening the picked project draft failed', err)
      return
    }
    if (request !== chooseRequestRef.current) return
    // What was typed follows the project chip instead of staying behind in
    // a draft the landing screen no longer shows.
    if (from && from !== to) {
      const drafts = useDraftStore.getState()
      const moved = drafts.detachDraftPayload(from)
      if (moved) {
        const existing = draftHasContent(to)
          ? { text: drafts.getDraft(to), pills: drafts.pillsBySession[to] ?? [], images: drafts.imagesBySession[to] ?? [] }
          : undefined
        drafts.replaceDraftPayload(to, mergeMovedDraft(existing, moved))
      }
    }
    setPicked({ projectPath: target.projectPath, machineId: target.machineId })
    if (primaryDraft) useLayoutStore.getState().showLanding(to)
    if (from && from !== to) {
      const agent = useAgentStore.getState()
      const left = agent.sessions.find((s) => s.id === from)
      // Terminals opened from the landing screen live on its draft, so a
      // draft that has some stays for when its project is picked again.
      if (
        left?.status === 'idle'
        && !useLayoutStore.getState().displayedChatSessionIds().includes(from)
        && useTerminalStore.getState().getAllPaneIds(from).length === 0
      ) {
        agent.removeSession(from)
      }
    }
  }, [draftId, ensureDraftSession, selected, primaryDraft])

  const withMachine = showMachineNames(targets)
  const options = useMemo<ComboboxOption[]>(() => [
    ...targets.map((t) => ({
      value: optionValue(t),
      label: landingChipLabel(t, withMachine),
      keywords: [t.projectPath],
    })),
    { value: ADD_PROJECT, label: 'Add a project…' },
  ], [targets, withMachine])

  const block = local === null ? null : landingSendBlock(selected, targets.length)

  // Arrow keys reach the recent chats only from an empty composer; the
  // picker's own search box is portalled but still bubbles through here.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (!target?.closest?.('.chat-landing .chat-composer [contenteditable="true"]')) return
    const result = landingRecentKey(
      event.nativeEvent,
      highlight,
      recents.length,
      !liveDraftId || !draftHasContent(liveDraftId),
    )
    if (result.consume) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (result.highlight !== highlight) setHighlight(result.highlight)
    if (result.open !== undefined) onOpenChat(recents[result.open])
  }

  const projectChip = noProjects ? (
    <button
      ref={addButtonRef}
      type="button"
      className="chat-landing-add"
      onClick={() => { void addProject() }}
    >
      {landingChipLabel(null, false)}
    </button>
  ) : (
    <Combobox
      aria-label="Project for the new chat"
      value={selected ? optionValue(selected) : ''}
      options={options}
      placeholder="Pick a project"
      searchPlaceholder="Find a project…"
      emptyText="No matching project."
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      leading={selected ? <ProjectFavicon projectPath={selected.projectPath} size={14} /> : undefined}
      className="max-w-[220px] justify-start gap-1.5 px-2 py-[3px] text-[11px]"
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        focusComposer(LANDING_COMPOSER_ID)
      }}
      onValueChange={(value) => {
        if (value === ADD_PROJECT) { void addProject(); return }
        const target = targets.find((t) => optionValue(t) === value)
        if (target) void choose(target)
      }}
    />
  )

  const hints = landingShortcutHints((id) => shortcutLabel(id))

  return (
    <div className="contents" onKeyDownCapture={onKeyDownCapture}>
      <ChatPanel
        chatSlot="primary"
        sessionIdOverride={liveDraftId}
        emptyPlaceholder={block ?? 'Message the agent...'}
        landing={{
          intro: (
            <div className="chat-landing-intro" data-testid="chat-landing">
              <h1 className="chat-landing-heading">What should we work on?</h1>
            </div>
          ),
          composerLead: projectChip,
          after: recents.length > 0 ? (
            <section className="chat-landing-recents" aria-label="Pick up where you left off">
              <div className="chat-landing-recents-label">Pick up where you left off</div>
              {recents.map((chat, index) => (
                <button
                  key={`${chat.machineId}:${chat.session.id}`}
                  type="button"
                  className="chat-landing-recent"
                  data-highlighted={highlight === index || undefined}
                  onClick={() => onOpenChat(chat)}
                >
                  <ProjectFavicon projectPath={chat.projectPath} size={14} />
                  <span className="chat-landing-recent-title">{chat.session.title}</span>
                  <span className="chat-landing-recent-meta">
                    {chat.projectName} · {formatRelativeTime(chat.session.startedAt)}
                  </span>
                </button>
              ))}
            </section>
          ) : undefined,
          footer: (
            <div className="chat-landing-hints">
              {hints.map((hint, index) => (
                <span key={hint.label}>
                  {index > 0 && <span className="chat-landing-hint-sep"> · </span>}
                  <kbd>{hint.keys}</kbd> {hint.label}
                </span>
              ))}
            </div>
          ),
        }}
      />
    </div>
  )
}
