import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { draftSessionId } from '@shared/new-chat-draft'
import { useMachineStore } from '../../stores/machine-store'
import { useAgentStore } from '../../stores/agent-store'
import { useDraftStore } from '../../stores/draft-store'
import { useLayoutStore } from '../../stores/layout-store'
import { focusComposer, registerComposer } from '../../services/composer-registry'
import {
  LANDING_COMPOSER_ID,
  buildProjectTargets,
  defaultLandingTarget,
  landingChipLabel,
  landingSendBlock,
  mergeMovedDraft,
  readRememberedPick,
  sameTarget,
  showMachineNames,
  writeRememberedPick,
  type LandingPick,
  type ProjectTarget,
} from '../../services/chat-landing'
import { Combobox, type ComboboxOption } from '../ui/combobox'
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
 * What the primary chat slot shows when no chat is open: a heading, the
 * project the next chat starts in, and the ordinary composer bound to that
 * project's draft. The first send goes through the draft materializer like
 * any other new chat.
 */
export function ChatLanding({
  ensureDraftSession,
}: {
  ensureDraftSession: (projectPath: string, machineId: string) => Promise<string>
}) {
  const [local, setLocal] = useState<Project[] | null>(null)
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const remoteProjects = useMachineStore((s) => s.projects)
  const [picked, setPicked] = useState<LandingPick | null>(null)
  const [draftId, setDraftId] = useState<string | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

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

  const targets = useMemo(
    () => buildProjectTargets(local ?? [], { remotes, connections, projects: remoteProjects }),
    [local, remotes, connections, remoteProjects],
  )
  const selected = useMemo(() => targets.find((t) => sameTarget(t, picked)) ?? null, [targets, picked])

  // The default is chosen once, so the chip does not move under the user
  // when the remembered draft is emptied or another project gets newer.
  useEffect(() => {
    if (local === null || selected) return
    const fallback = defaultLandingTarget(
      targets,
      readRememberedPick(localStorage),
      (pick) => draftHasContent(draftSessionId(pick.machineId, pick.projectPath)),
    )
    if (fallback) setPicked({ projectPath: fallback.projectPath, machineId: fallback.machineId })
  }, [local, targets, selected])

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

  useEffect(() => registerComposer(LANDING_COMPOSER_ID, {
    focus: () => { if (!draftId || !focusComposer(draftId)) addButtonRef.current?.focus() },
  }), [draftId])

  // Focus the composer whenever the landing screen appears or its draft changes.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusComposer(LANDING_COMPOSER_ID))
    return () => cancelAnimationFrame(frame)
  }, [draftId])

  const addProject = useCallback(async () => {
    try {
      const project = await window.api.app.openFolder()
      if (!project) return
      // Listed now, so the default pick does not run before the reload lands.
      setLocal((prev) => prev?.some((p) => p.path === project.path) ? prev : [...(prev ?? []), project])
      setPicked({ projectPath: project.path, machineId: 'local' })
      window.dispatchEvent(new CustomEvent('sidebar-refresh'))
    } catch (err) {
      log.warn('adding a project from the landing screen failed', err)
    }
  }, [])

  // A later pick supersedes an earlier one still waiting on its draft, so
  // the typed text cannot land on a project the chip no longer shows.
  const chooseRequestRef = useRef(0)
  const choose = useCallback(async (target: ProjectTarget) => {
    if (sameTarget(target, selected)) return
    const request = ++chooseRequestRef.current
    const from = draftId
    const to = await ensureDraftSession(target.projectPath, target.machineId)
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
      const agent = useAgentStore.getState()
      const left = agent.sessions.find((s) => s.id === from)
      if (left?.status === 'idle' && !useLayoutStore.getState().displayedChatSessionIds().includes(from)) {
        agent.removeSession(from)
      }
    }
    setPicked({ projectPath: target.projectPath, machineId: target.machineId })
  }, [draftId, ensureDraftSession, selected])

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
  // Only the selected project's own draft may take input: a target that a
  // refresh or a disconnect removed must not be sent to on the next render.
  const liveDraftId = selected && draftId === draftSessionId(selected.machineId, selected.projectPath) ? draftId : null

  const heading = (
    <div className="chat-landing-intro" data-testid="chat-landing">
      <h1 className="chat-landing-heading">What should we work on?</h1>
      <div className="chat-landing-project">
        <span>{targets.length === 0 ? 'No projects yet.' : 'New chat in'}</span>
        {targets.length === 0 ? (
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
            className="max-w-[320px] rounded-full px-3"
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
        )}
      </div>
    </div>
  )

  return (
    <ChatPanel
      chatSlot="primary"
      sessionIdOverride={liveDraftId}
      landing={heading}
      emptyPlaceholder={block ?? 'Message the agent...'}
    />
  )
}
