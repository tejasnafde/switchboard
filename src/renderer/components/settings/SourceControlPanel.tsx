/**
 * Settings > Accounts & models > Source control: the accounts Reviews reads
 * pull requests with. Bitbucket takes an Atlassian email + API token, which
 * the backend encrypts with the OS keychain and never sends back (this card
 * only ever sees "configured" and the email). GitHub goes through the gh CLI
 * where the backend runs, so its card only shows the gh login.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceControlStatus } from '@shared/pull-requests'
import { confirm } from '../ui/confirm'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:source-control')

type Note = { ok: boolean; message: string } | null

const INPUT = 'h-[30px] w-full max-w-[360px] rounded-[7px] border border-[var(--border)] bg-[var(--bg-primary)] px-[10px] text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--border-focus)]'

export function SourceControlPanel() {
  const [status, setStatus] = useState<SourceControlStatus | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const reload = useCallback(() => {
    window.api.sourceControl.status()
      .then((next) => { if (mounted.current) setStatus(next) })
      .catch((err: unknown) => log.warn('reading source control status failed', err))
  }, [])
  useEffect(reload, [reload])

  return (
    <section className="mb-[18px]" aria-busy={status === null}>
      <h3 className="mb-2 text-[11px] font-[600] uppercase tracking-[0.07em] text-[var(--text-muted)]">Source control</h3>
      <BitbucketCard status={status} onChanged={reload} />
      <GithubCard status={status} />
    </section>
  )
}

function CardShell({ logo, title, detail, actions, children }: { logo: string; title: string; detail: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div data-source-control={title} className="mb-2 rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
      <div className="flex items-center gap-[10px] px-[14px] py-3">
        <span aria-hidden="true" className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] text-[11px] font-[700] text-white" style={{ background: logo }}>
          {title.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-[500]">{title}</div>
          <div className="truncate text-[12px] text-[var(--text-secondary)]">{detail}</div>
        </div>
        {actions && <div className="flex gap-[6px]">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

function NoteLine({ note, busy }: { note: Note; busy: string | null }) {
  if (!busy && !note) return null
  return (
    <div role="status" className={cn('px-[14px] pb-3 text-[12px] break-words', !busy && note && !note.ok ? 'text-[var(--error)]' : 'text-[var(--text-muted)]')}>
      {busy ?? note?.message}
    </div>
  )
}

function BitbucketCard({ status, onChanged }: { status: SourceControlStatus | null; onChanged: () => void }) {
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const bb = status?.bitbucket
  const configured = bb?.state === 'configured'
  const showForm = bb?.state === 'unconfigured' || editing

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setNote(null)
    try {
      await task()
    } catch (err) {
      log.warn(`${label} failed`, err)
      setNote({ ok: false, message: 'That did not work; see the log.' })
    } finally {
      setBusy(null)
    }
  }

  const save = () => run('Saving…', async () => {
    const result = await window.api.sourceControl.setBitbucket({ email, apiToken: token })
    if (!result.ok) {
      setNote({ ok: false, message: result.message ?? 'Saving failed.' })
      return
    }
    setToken('')
    setEditing(false)
    onChanged()
    setNote(await window.api.sourceControl.test('bitbucket'))
  })

  const test = () => run('Testing…', async () => {
    const typed = showForm && email && token ? { email, apiToken: token } : undefined
    setNote(await window.api.sourceControl.test('bitbucket', typed))
  })

  const remove = async () => {
    if (!(await confirm({ title: 'Remove the Bitbucket account?', body: 'Reviews stops reading Bitbucket pull requests until you add it again.', confirmLabel: 'Remove', destructive: true }))) return
    await run('Removing…', async () => {
      await window.api.sourceControl.removeBitbucket()
      onChanged()
    })
  }

  const detail = bb === undefined
    ? 'Checking…'
    : bb.state === 'needs_desktop'
      ? 'Bitbucket needs the desktop app in this release.'
      : bb.state === 'configured'
        ? bb.email
        : 'Not connected'

  return (
    <CardShell
      logo="#1f3f86"
      title="Bitbucket Cloud"
      detail={detail}
      actions={bb?.state === 'needs_desktop' ? undefined : (
        <>
          <Button variant="outline" size="sm" disabled={!!busy || (!configured && !(email && token))} onClick={() => void test()}>Test</Button>
          {configured && !editing && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => { setEditing(true); setEmail(bb.email) }}>Change</Button>}
          {configured && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void remove()}>Remove</Button>}
        </>
      )}
    >
      {showForm && (
        <form
          className="grid grid-cols-[120px_1fr] items-center gap-x-[14px] gap-y-[10px] border-t border-[var(--border)] px-[14px] py-3"
          onSubmit={(e) => { e.preventDefault(); void save() }}
        >
          <label htmlFor="bb-email" className="text-[12.5px] text-[var(--text-secondary)]">Email</label>
          <input id="bb-email" type="email" autoComplete="off" className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          <label htmlFor="bb-token" className="text-[12.5px] text-[var(--text-secondary)]">API token</label>
          <div>
            <input id="bb-token" type="password" autoComplete="off" className={INPUT} value={token} onChange={(e) => setToken(e.target.value)} />
            <div className="mt-1 text-[12px] text-[var(--text-muted)]">
              An Atlassian API token with these scopes: read:pullrequest:bitbucket and read:pipeline:bitbucket to read,
              write:pullrequest:bitbucket to reply, review, merge, change reviewers and decline, and read:workspace:bitbucket
              to suggest workspace members as reviewers. Stored encrypted on this computer.
            </div>
          </div>
          <span />
          <div className="flex gap-[6px]">
            <Button type="submit" size="sm" disabled={!!busy || !email || !token}>Save</Button>
            {editing && <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setToken('') }}>Cancel</Button>}
          </div>
        </form>
      )}
      <NoteLine note={note} busy={busy} />
    </CardShell>
  )
}

function GithubCard({ status }: { status: SourceControlStatus | null }) {
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const gh = status?.github
  const detail = gh === undefined
    ? 'Checking…'
    : gh.state === 'signed_in'
      ? `${gh.login} · through the gh CLI where the backend runs`
      : gh.state === 'signed_out'
        ? 'gh is signed out. Run gh auth login in a terminal.'
        : gh.state === 'gh_missing'
          ? 'Needs the gh CLI where the backend runs.'
          : gh.message

  const test = async () => {
    setBusy('Testing…')
    setNote(null)
    try {
      setNote(await window.api.sourceControl.test('github'))
    } catch (err) {
      log.warn('testing gh failed', err)
      setNote({ ok: false, message: 'That did not work; see the log.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <CardShell
      logo="#2b2d31"
      title="GitHub"
      detail={detail}
      actions={<Button variant="outline" size="sm" disabled={!!busy} onClick={() => void test()}>Test</Button>}
    >
      <NoteLine note={note} busy={busy} />
    </CardShell>
  )
}
