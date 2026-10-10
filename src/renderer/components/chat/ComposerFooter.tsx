import { useEffect, useRef, type ReactNode } from 'react'
import type { RuntimeMode } from '@shared/provider-events'
import type { DraftChatOptions } from '@shared/new-chat-draft'
import { effortLabel, type EffortControl } from '@shared/effort'
import { useContainerTier } from '../../hooks/useContainerTier'
import { footerTier, overflowedPriorities, type FooterPriority } from './composer-footer-tiers'
import { BranchIcon, ChipSelect, GaugeIcon, OptionList, ShieldIcon } from './FooterChip'
import { ComposerOverflowMenu, type OverflowEntry } from './ComposerOverflowMenu'
import { EffortPicker, effortOptions } from './EffortPicker'
import { DraftWorkspaceChips, useDraftWorkspace, type DraftWorkspaceSection } from './DraftWorkspaceChips'
import { BranchPickerPopover, BranchPickerTrigger, useCurrentBranch, type CurrentBranch } from './BranchPicker'
import { RUNTIME_MODE_OPTIONS } from './runtime-mode-options'

interface BranchProps {
  onSwapWorktree: (newCwd: string, branch: string) => void
  onCwdMissing: () => void
  followSessionId?: string
  onTurnFollowBackOn: () => void
}

/**
 * The row under the chat input: P1 project (landing), P2 agent and model, P3
 * effort, P4 checkout, P5 runtime mode, then the context meter. It never
 * wraps: as the footer narrows the lower priorities shorten, then move into
 * the "..." menu (composer-footer-tiers.ts). The meter never moves.
 */
export function ComposerFooter({
  lead,
  provider,
  effort,
  notice,
  sessionId,
  cwd,
  draft,
  branch: branchProps,
  mode,
  meter,
}: {
  lead?: ReactNode
  provider?: ReactNode
  effort?: { control: EffortControl; onPick: (value: string) => void } | null
  /** The drift suggestion: it truncates but never moves. */
  notice?: ReactNode
  sessionId: string | null
  cwd: string | null
  /** A draft chat picks its checkout; a live chat switches its branch. */
  draft?: DraftChatOptions
  branch: BranchProps
  mode?: { value: RuntimeMode; onChange: (mode: RuntimeMode) => void } | null
  meter?: ReactNode
}) {
  const [footerRef, tier] = useContainerTier(footerTier)
  const isDraft = !!draft && !!sessionId
  const draftSections = useDraftWorkspace(isDraft ? sessionId : null, cwd, draft)
  const branch = useCurrentBranch(isDraft ? null : cwd, branchProps.onCwdMissing)

  const modeOption = mode ? RUNTIME_MODE_OPTIONS.find((m) => m.value === mode.value) : undefined
  const modeOptions = RUNTIME_MODE_OPTIONS.map((m) => ({ value: m.value, label: m.label, title: m.detail }))

  const entries: Record<3 | 4 | 5, OverflowEntry | null> = {
    3: effort
      ? {
          key: 'effort',
          icon: <GaugeIcon />,
          name: 'Effort',
          valueText: effortLabel(effort.control.value),
          body: (close) => (
            <OptionList
              label="Thinking effort"
              options={effortOptions(effort.control)}
              value={effort.control.value}
              onPick={(value) => {
                close()
                if (value !== effort.control.value) effort.onPick(value)
              }}
            />
          ),
        }
      : null,
    4: isDraft ? draftCheckoutEntry(draftSections) : branchEntry(cwd, branch, branchProps),
    5: mode
      ? {
          key: 'mode',
          icon: <ShieldIcon />,
          name: 'Mode',
          valueText: modeOption?.label ?? mode.value,
          body: (close) => (
            <OptionList
              label="Runtime mode"
              options={modeOptions}
              value={mode.value}
              onPick={(value) => {
                close()
                if (value !== mode.value) mode.onChange(value as RuntimeMode)
              }}
            />
          ),
        }
      : null,
  }
  const overflow = overflowedPriorities(tier).flatMap((p) => {
    const entry = entries[p as Exclude<FooterPriority, 1 | 2>]
    return entry ? [entry] : []
  })

  return (
    <div
      ref={footerRef}
      data-composer-footer
      className="@container/footer mt-[6px] flex items-center gap-[8px] text-[11px]"
    >
      <div data-composer-footer-track className="flex min-w-0 flex-1 flex-nowrap items-center gap-[6px]">
        {lead}
        {provider}
        {effort && (
          <span className="contents @max-[400px]/footer:hidden">
            <EffortPicker control={effort.control} onPick={effort.onPick} />
          </span>
        )}
        {notice}
        <span className="contents @max-[480px]/footer:hidden">
          {isDraft ? (
            <DraftWorkspaceChips sections={draftSections} />
          ) : (
            <BranchPickerTrigger
              cwd={cwd}
              branch={branch}
              followSessionId={branchProps.followSessionId}
              onTurnFollowBackOn={branchProps.onTurnFollowBackOn}
              onSwapWorktree={branchProps.onSwapWorktree}
            />
          )}
        </span>
        {mode && (
          <span className="contents @max-[600px]/footer:hidden">
            <ChipSelect
              label="Runtime mode"
              className="runtime-mode-select"
              triggerData={{ 'data-runtime-mode': mode.value }}
              title={modeOption?.detail}
              icon={<ShieldIcon />}
              full={modeOption?.label ?? mode.value}
              short={modeOption?.short}
              options={modeOptions}
              value={mode.value}
              onPick={(value) => mode.onChange(value as RuntimeMode)}
            />
          </span>
        )}
        <ComposerOverflowMenu entries={overflow} />
      </div>
      {meter}
    </div>
  )
}

function draftCheckoutEntry(sections: DraftWorkspaceSection[]): OverflowEntry | null {
  const [checkout, ...rest] = sections
  if (!checkout) return null
  return {
    key: 'checkout',
    icon: <BranchIcon />,
    name: 'Checkout',
    valueText: checkout.valueText,
    body: (close) => (
      <div className="flex max-h-[320px] flex-col gap-[4px] overflow-y-auto">
        {[checkout, ...rest].map((section, index) => (
          <div key={section.key} className="flex flex-col gap-[1px]">
            {index > 0 && (
              <div className="px-[8px] pt-[6px] pb-[2px] text-[10.5px] text-[var(--text-muted)]">{section.label}</div>
            )}
            <OptionList
              label={section.label}
              options={section.options}
              value={section.value}
              autoFocus={index === 0}
              onPick={(value) => {
                close()
                if (value !== section.value) section.pick(value)
              }}
            />
          </div>
        ))}
      </div>
    ),
  }
}

function branchEntry(cwd: string | null, branch: CurrentBranch, props: BranchProps): OverflowEntry | null {
  if (!cwd || !branch.isGitRepo) return null
  return {
    key: 'checkout',
    icon: <BranchIcon />,
    name: 'Branch',
    valueText: branch.current ?? '(detached)',
    wide: true,
    body: (close) => (
      <BranchMenuBody
        cwd={cwd}
        props={props}
        onClose={(changed) => {
          close()
          if (changed) branch.refresh()
        }}
      />
    ),
  }
}

function BranchMenuBody({
  cwd,
  props,
  onClose,
}: {
  cwd: string
  props: BranchProps
  onClose: (changed: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  return (
    <BranchPickerPopover
      cwd={cwd}
      inputRef={inputRef}
      onSwapWorktree={props.onSwapWorktree}
      onClose={onClose}
      followSessionId={props.followSessionId}
      onTurnFollowBackOn={props.onTurnFollowBackOn}
    />
  )
}
