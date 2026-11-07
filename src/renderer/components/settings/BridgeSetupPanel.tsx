/**
 * Settings > Labs, shown only while the Instinct bridge flag is on: the four
 * setup steps and where this Mac stands on each. Both counts come from panels
 * below: the project count is read again when the projects panel saves
 * (`BRIDGE_PROJECTS_CHANGED`), and the enrollment comes from the device
 * panel's own poll (`BRIDGE_DEVICE_STATUS`), so this panel polls nothing.
 */
import { useEffect, useState } from 'react'
import type { BridgeDeviceStatus, BridgeProjectSetup } from '@shared/bridge'
import {
  BRIDGE_DEVICE_STATUS,
  BRIDGE_PROJECTS_CHANGED,
  bridgeSetupSteps,
  type BridgeDeviceStatusEvent,
  type BridgeStepState,
} from './bridge-setup-model'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:bridge-setup')

export function BridgeSetupPanel() {
  const [projects, setProjects] = useState<BridgeProjectSetup | null>(null)
  // Null until the device panel's first poll answers; the step says so.
  const [device, setDevice] = useState<BridgeDeviceStatus | null>(null)

  useEffect(() => {
    let live = true
    const readProjects = () =>
      window.api.bridge
        .listProjects()
        .then((next) => {
          if (live) setProjects(next)
        })
        .catch((err: unknown) => log.warn('reading the bridge projects failed; the step shows no count', err))
    const takeDevice = (event: Event) => setDevice((event as BridgeDeviceStatusEvent).detail)
    void readProjects()
    window.addEventListener(BRIDGE_PROJECTS_CHANGED, readProjects)
    window.addEventListener(BRIDGE_DEVICE_STATUS, takeDevice)
    return () => {
      live = false
      window.removeEventListener(BRIDGE_PROJECTS_CHANGED, readProjects)
      window.removeEventListener(BRIDGE_DEVICE_STATUS, takeDevice)
    }
  }, [])

  const rows = projects?.projects ?? []
  const steps = bridgeSetupSteps({
    total: rows.length,
    allowed: rows.filter((row) => row.allowed).length,
    device,
  })
  return (
    <section className="mb-[18px]" data-testid="bridge-setup">
      <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">Instinct bridge setup</h3>
      <ol className="m-0 list-none overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] p-0">
        {steps.map((step, index) => (
          <li
            key={step.title}
            data-step-state={step.state}
            className="flex items-center gap-3 border-t border-[var(--border)] px-[14px] py-2.5 first:border-t-0"
          >
            <StepMark number={index + 1} state={step.state} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-[500] leading-[18px]">{step.title}</div>
              <div className="text-[11.5px] leading-[1.45] text-[var(--text-muted)]">{step.detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

const MARK_LABEL: Record<BridgeStepState, string> = { done: 'Done', todo: 'Not done', unknown: 'Not checked here' }

function StepMark({ number, state }: { number: number; state: BridgeStepState }) {
  return (
    <span
      className={`flex size-[18px] flex-none items-center justify-center rounded-full text-[10px] font-[600] leading-none ${
        state === 'done'
          ? 'bg-primary-fill text-primary-foreground'
          : 'border border-[var(--text-muted)] text-[var(--text-muted)]'
      }`}
    >
      <span className="sr-only">{`Step ${number}: ${MARK_LABEL[state]}`}</span>
      {state === 'done' ? (
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="size-[10px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
        >
          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span aria-hidden="true">{number}</span>
      )}
    </span>
  )
}
