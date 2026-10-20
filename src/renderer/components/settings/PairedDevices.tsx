/**
 * Settings > Devices & machines > Paired devices: search, sort, the "Online
 * now" and "Earlier" groups, the inactive fold, per-device Details with rename,
 * and Revoke (one device, or every inactive one). The rules live in
 * device-list.ts.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { deviceDisplayName, type DeviceSessionView } from '@shared/device-auth'
import { Button, buttonVariants } from '../ui/button'
import { ChipSelect } from '../ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsibleOpen } from '../ui/collapsible'
import { confirm } from '../ui/confirm'
import { onEscapeFirst } from '../ui/escape-first'
import { Input } from '../ui/input'
import { cn } from '../../lib/utils'
import { createRendererLogger } from '../../logger'
import {
  DEVICE_SORT_OPTIONS,
  absoluteDate,
  groupDevices,
  isInactive,
  makeAndModel,
  platformLabel,
  relativeTime,
  type DeviceSort,
} from './device-list'

const log = createRendererLogger('settings:paired-devices')

const quietRevokeClass =
  'text-[var(--text-secondary)] hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0', open && 'rotate-180')}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <>
      <span className="font-[family-name:var(--font-mono)] text-[11px]">{value}</span>
      {copied ? (
        <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-[var(--success)]">
          <svg
            aria-hidden
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 12 5 5 9-10" />
          </svg>
          Copied
        </span>
      ) : (
        <Button
          variant="ghost"
          size="icon-xs"
          title="Copy"
          aria-label={`Copy ${label}`}
          className="text-[var(--text-secondary)]"
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => setCopied(true))
              .catch((err: unknown) => log.warn('clipboard write failed', err))
          }}
        >
          <svg
            aria-hidden
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        </Button>
      )}
    </>
  )
}

function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[11px] text-[var(--text-secondary)]">{term}</dt>
      <dd className="flex min-h-6 min-w-0 items-center gap-1 text-[12px]">{children}</dd>
    </>
  )
}

function NameRow({
  device,
  onRename,
}: {
  device: DeviceSessionView
  onRename: (name: string | null) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const name = deviceDisplayName(device)
  const reported = device.name || device.label

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
    // Escape cancels the rename, not Settings around it.
    return onEscapeFirst(() => setEditing(false))
  }, [editing])

  const save = (): void => {
    void onRename(draft).then(() => setEditing(false))
  }

  if (editing) {
    return (
      <>
        <dt className="text-[11px] text-[var(--text-secondary)]">Name</dt>
        <dd className="flex min-h-6 items-center gap-1.5">
          <Input
            ref={inputRef}
            aria-label="Device name"
            value={draft}
            maxLength={128}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            className="h-7 w-[240px] px-2 text-[12.5px]"
          />
          <Button size="sm" onClick={save}>
            Save
          </Button>
          <Button size="sm" variant="ghost" className="text-[var(--text-secondary)]" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </dd>
        <div className="col-start-2 text-[11px] leading-4 text-[var(--text-secondary)]">
          Shown on this computer only. Clear it to use the phone&apos;s own name, &quot;{reported}&quot;.
        </div>
      </>
    )
  }
  return (
    <DetailRow term="Name">
      <span className="min-w-0 truncate">{name}</span>
      <Button
        variant="outline"
        size="sm"
        className="ml-1 h-5.5 px-2 text-[11px]"
        onClick={() => {
          setDraft(name)
          setEditing(true)
        }}
      >
        Rename
      </Button>
      {device.customName && (
        <>
          <span className="ml-2 shrink-0 text-[11px] text-[var(--text-secondary)]">
            Reported as &quot;{reported}&quot;
          </span>
          <button
            type="button"
            className="ml-1 shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[12px] font-[500] text-[var(--accent)] outline-none hover:text-[var(--accent-hover)] hover:underline focus-visible:underline"
            onClick={() => void onRename(null)}
          >
            Use reported name
          </button>
        </>
      )}
    </DetailRow>
  )
}

function DeviceDetails({
  device,
  onRename,
}: {
  device: DeviceSessionView
  onRename: (name: string | null) => Promise<void>
}) {
  const platform = platformLabel(device)
  const system = [platform, device.osVersion].filter(Boolean).join(' ')
  return (
    <CollapsibleContent
      role="region"
      aria-label={`Details for ${deviceDisplayName(device)}`}
      className="col-span-full mt-2 -mr-2 -mb-2 -ml-3 border-y border-border bg-[var(--bg-primary)] py-3 pr-3 pl-[30px]"
    >
      <dl className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
        <NameRow device={device} onRename={onRename} />
        <DetailRow term="Last seen">
          {device.online ? 'Connected now' : absoluteDate(device.lastSeenAt, true)}
        </DetailRow>
        {device.lastAddress && (
          <DetailRow term="Address">
            <CopyValue label="address" value={device.lastAddress} />
          </DetailRow>
        )}
        {system && <DetailRow term="System">{system}</DetailRow>}
        {device.appVersion && <DetailRow term="App">Switchboard {device.appVersion}</DetailRow>}
        {device.installId && (
          <DetailRow term="Install ID">
            <CopyValue label="install ID" value={device.installId} />
          </DetailRow>
        )}
        <DetailRow term="Paired">{absoluteDate(device.createdAt)}</DetailRow>
      </dl>
    </CollapsibleContent>
  )
}

function DetailsTrigger() {
  const open = useCollapsibleOpen()
  return (
    <CollapsibleTrigger
      className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-[var(--text-secondary)]')}
    >
      Details
      <Chevron open={open} />
    </CollapsibleTrigger>
  )
}

function DeviceRow({
  device,
  nowMs,
  onRevoke,
  onRename,
}: {
  device: DeviceSessionView
  nowMs: number
  onRevoke: (device: DeviceSessionView) => void
  onRename: (device: DeviceSessionView, name: string | null) => Promise<void>
}) {
  const meta = [
    makeAndModel(device),
    platformLabel(device),
    device.online ? 'Connected now' : `Last seen ${relativeTime(device.lastSeenAt, nowMs)}`,
  ].filter((part): part is string => !!part)
  return (
    <Collapsible
      data-device-row={device.id}
      className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b border-border py-2 pr-2 pl-3 last:border-b-0 data-[state=open]:border-b-0"
    >
      <span
        role="img"
        aria-label={device.online ? 'Online' : 'Offline'}
        className={cn(
          'size-2 rounded-full border',
          device.online ? 'border-[var(--success)] bg-[var(--success)]' : 'border-[var(--text-muted)]',
        )}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[12.5px] font-[500] leading-4">
          <span className="truncate">{deviceDisplayName(device)}</span>
          {isInactive(device, nowMs) && (
            <span className="rounded-[4px] border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] px-[5px] text-[10.5px] leading-[14px] text-[var(--warning)]">
              Inactive
            </span>
          )}
        </div>
        <div className="truncate text-[11px] leading-4 text-[var(--text-secondary)]">
          {meta.map((part, i) => (
            <span key={i}>
              {i > 0 && <span className="mx-[5px] text-[var(--text-muted)]">·</span>}
              {part}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <DetailsTrigger />
        <Button variant="ghost" size="sm" className={quietRevokeClass} onClick={() => onRevoke(device)}>
          Revoke
        </Button>
      </div>
      <DeviceDetails device={device} onRename={(name) => onRename(device, name)} />
    </Collapsible>
  )
}

function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline gap-1.5 border-b border-border bg-[var(--bg-secondary)] px-3 py-1 text-[10.5px] font-[600] uppercase leading-4 tracking-[0.04em] text-[var(--text-secondary)]">
      {title}
      <span className="font-[500] tracking-normal text-[var(--text-muted)]">{count}</span>
    </div>
  )
}

function FoldTrigger({ count }: { count: number }) {
  const open = useCollapsibleOpen()
  return (
    <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between border-x-0 border-t border-b-0 border-solid border-border bg-[var(--bg-secondary)] px-3 py-2 text-left text-[12px] leading-4 text-[var(--text-secondary)] outline-none hover:text-foreground focus-visible:text-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Chevron open={open} />
        {open
          ? `Hide ${count} inactive device${count === 1 ? '' : 's'}`
          : `Show ${count} more inactive device${count === 1 ? '' : 's'}`}
      </span>
      <span className="text-[11px] text-[var(--text-muted)]">Not seen in 30 days</span>
    </CollapsibleTrigger>
  )
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function PairedDevices({
  devices,
  playListingUrl,
  canPair,
  onShowPairing,
  onChanged,
}: {
  devices: readonly DeviceSessionView[]
  playListingUrl: string
  canPair: boolean
  onShowPairing: () => void
  onChanged: () => void
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<DeviceSort>('lastSeen')
  const searchRef = useRef<HTMLInputElement>(null)
  const nowMs = Date.now()
  const groups = groupDevices(devices, query, sort, nowMs)
  const total = devices.filter((d) => !d.revoked).length

  const revokeOne = async (device: DeviceSessionView): Promise<void> => {
    const ok = await confirm({
      title: `Revoke ${deviceDisplayName(device)}?`,
      body: 'It disconnects now and stops getting notifications. To use it again, scan a new pairing code from this computer with the phone. Other devices keep working.',
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    try {
      await window.api.app.mobileRevokeDevice(device.id)
    } catch (err) {
      log.warn('failed to revoke a device', err)
    }
    onChanged()
  }

  const revokeInactive = async (): Promise<void> => {
    const gone = groups.inactive
    const n = gone.length
    const kept = total - n
    const lead =
      n === 1
        ? 'It has not connected in 30 days and must scan a new pairing code to come back.'
        : `${n === 2 ? 'Neither' : 'None'} has connected in 30 days. Each must scan a new pairing code to come back.`
    const ok = await confirm({
      title: `Revoke ${plural(n, 'inactive device')}?`,
      body: kept > 0 ? `${lead} The other ${plural(kept, 'device')} ${kept === 1 ? 'is' : 'are'} kept.` : lead,
      items: gone.map((d) => ({ label: deviceDisplayName(d), detail: `Last seen ${absoluteDate(d.lastSeenAt)}` })),
      confirmLabel: `Revoke ${plural(n, 'device')}`,
      destructive: true,
    })
    if (!ok) return
    for (const device of gone) {
      try {
        await window.api.app.mobileRevokeDevice(device.id)
      } catch (err) {
        log.warn('failed to revoke an inactive device', err)
      }
    }
    onChanged()
  }

  const rename = async (device: DeviceSessionView, name: string | null): Promise<void> => {
    try {
      await window.api.app.mobileRenameDevice(device.id, name)
    } catch (err) {
      log.warn('failed to rename a device', err)
    }
    onChanged()
  }

  const rows = (list: DeviceSessionView[]) =>
    list.map((device) => (
      <DeviceRow key={device.id} device={device} nowMs={nowMs} onRevoke={(d) => void revokeOne(d)} onRename={rename} />
    ))

  if (total === 0) {
    return (
      <div className="rounded-md border border-border bg-[var(--bg-surface)] px-6 py-10 text-center">
        <div className="mb-1 text-[13px] font-[600]">No devices paired yet</div>
        <p className="mx-auto mb-4 max-w-[380px] text-[12px] leading-normal text-[var(--text-secondary)]">
          A paired phone sees the same chats and sessions as this window. Show the pairing QR here and scan it with the
          Switchboard app.
        </p>
        <Button variant="outline" size="sm" disabled={!canPair} onClick={onShowPairing}>
          Show pairing QR
        </Button>
        <div className="mt-3 text-[11px] text-[var(--text-secondary)]">
          Need the app?{' '}
          <a href={playListingUrl} className="text-[var(--accent)] no-underline hover:underline">
            Google Play
          </a>
        </div>
      </div>
    )
  }

  const sortLabel = DEVICE_SORT_OPTIONS.find((o) => o.value === sort)?.label ?? 'Last seen'
  const nothingShown = groups.online.length + groups.earlier.length + groups.folded.length === 0

  return (
    <div data-testid="paired-devices">
      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <svg
            aria-hidden
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="pointer-events-none absolute left-[9px] text-[var(--text-muted)]"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <Input
            ref={searchRef}
            aria-label="Search devices"
            placeholder="Search name, model or platform"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 bg-[var(--bg-primary)] pl-7 pr-7 text-[12.5px]"
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="absolute right-1 text-[var(--text-secondary)]"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              <svg
                aria-hidden
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </Button>
          )}
        </div>
        <ChipSelect
          label="Sort devices"
          triggerLabel={`Sort by ${sortLabel}`}
          icon={<span>Sort</span>}
          full={sortLabel}
          options={DEVICE_SORT_OPTIONS}
          value={sort}
          onPick={(value) => setSort(value as DeviceSort)}
          className="h-7 rounded-md"
          menuClassName="w-[160px]"
        />
        {groups.inactive.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void revokeInactive()}
          >
            Revoke inactive ({groups.inactive.length})
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-[var(--bg-surface)]">
        {nothingShown ? (
          <div className="px-6 py-8 text-center">
            <p className="mb-1 text-[12.5px]">No devices match &quot;{query.trim()}&quot;</p>
            <div className="mb-3 text-[12px] text-[var(--text-secondary)]">
              Search matches the name, model or platform, like Pixel or iOS.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              Clear search
            </Button>
          </div>
        ) : (
          <>
            {groups.online.length > 0 && (
              <>
                <GroupHeader title="Online now" count={groups.online.length} />
                {rows(groups.online)}
              </>
            )}
            {groups.earlier.length + groups.folded.length > 0 && (
              <>
                <GroupHeader title="Earlier" count={groups.earlier.length + groups.folded.length} />
                {rows(groups.earlier)}
                {groups.folded.length > 0 && (
                  <Collapsible>
                    <CollapsibleContent>{rows(groups.folded)}</CollapsibleContent>
                    <FoldTrigger count={groups.folded.length} />
                  </Collapsible>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
