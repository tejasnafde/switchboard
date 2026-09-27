/**
 * The chats a pull request is linked to (Overview's "Linked chat" card), and
 * the dialog that asks which chat gets review context when the PR has none
 * or several linked. Both pick from the chats of the PR's projects.
 */
import { useEffect, useMemo, useState } from 'react'
import type { PrLinkChat } from '@shared/pull-request-links'
import { prKey, type PrSummary } from '@shared/pull-requests'
import { reviewContextLabel } from '@shared/review-context'
import { agentLabel, isAgentType } from '@shared/types'
import { createRendererLogger } from '../../logger'
import { useReviewStore } from '../../stores/review-store'
import { Combobox, type ComboboxOption } from '../ui/combobox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { CardRow, SideCard } from './review-ui'
import { deliverReviewContext, openReviewChat } from './review-to-chat'
import { linkThenDeliver, pickNeedsLink } from './ask-chat-pick'

const log = createRendererLogger('reviews:links')

function chatAgent(chat: PrLinkChat): string {
  return isAgentType(chat.agentType) ? agentLabel(chat.agentType) : chat.agentType
}

/** Chats of the PR's projects, loaded once per open card or dialog. */
function useLinkableChats(pr: PrSummary['ref']): PrLinkChat[] {
  const [chats, setChats] = useState<PrLinkChat[]>([])
  const key = prKey(pr)
  useEffect(() => {
    let live = true
    window.api.pullRequests.linkableChats(pr)
      .then((list) => { if (live) setChats(list) })
      .catch((err) => log.warn('listing chats for a pull request failed', err))
    return () => { live = false }
    // `pr` is a fresh object per render; the key names it.
  }, [key])
  return chats
}

function chatOptions(chats: PrLinkChat[], linked: PrLinkChat[]): ComboboxOption[] {
  const linkedIds = new Set(linked.map((c) => c.id))
  return [...linked, ...chats.filter((c) => !linkedIds.has(c.id))].map((c) => ({
    value: c.id,
    label: c.title,
    hint: linkedIds.has(c.id) ? `${chatAgent(c)} · linked` : chatAgent(c),
  }))
}

export function useLinkedChats(pr: PrSummary): PrLinkChat[] {
  const key = prKey(pr.ref)
  const chats = useReviewStore((s) => s.linkedChats[key])
  useEffect(() => {
    void useReviewStore.getState().loadLinkedChats(pr.ref)
    return window.api.pullRequests.onLinksChanged(() => void useReviewStore.getState().loadLinkedChats(pr.ref))
  }, [key])
  return chats ?? []
}

export function LinkedChatsCard({ pr }: { pr: PrSummary }) {
  const linked = useLinkedChats(pr)
  const linkable = useLinkableChats(pr.ref)
  const [error, setError] = useState<string | null>(null)
  const options = useMemo(() => chatOptions(linkable.filter((c) => !linked.some((l) => l.id === c.id)), []), [linkable, linked])

  const change = async (action: 'link' | 'unlink', chat: string) => {
    setError(null)
    try {
      const result = await window.api.pullRequests[action](chat, pr.ref)
      if (!result.ok) setError(result.message)
    } catch (err) {
      log.warn(`${action} failed`, err)
      setError('That did not work; see the log.')
    }
    await useReviewStore.getState().loadLinkedChats(pr.ref)
  }

  return (
    <SideCard title="Linked chat">
      {linked.map((chat) => (
        <CardRow key={chat.id}>
          <button
            type="button"
            onClick={() => void openReviewChat(chat)}
            title="Open this chat"
            className="min-w-0 cursor-pointer truncate border-none bg-transparent p-0 text-left text-[12.5px] text-[var(--text-primary)] hover:underline"
          >
            {chat.title}
          </button>
          <span className="ml-auto shrink-0 text-[12px] text-[var(--text-secondary)]">{chatAgent(chat)}</span>
          <Button variant="ghost" size="sm" onClick={() => void change('unlink', chat.id)} aria-label={`Unlink ${chat.title}`}>Unlink</Button>
        </CardRow>
      ))}
      <div className="px-3 py-[8px]">
        <Combobox
          value=""
          onValueChange={(id) => void change('link', id)}
          options={options}
          placeholder={linked.length ? 'Link another chat' : 'Link to chat'}
          searchPlaceholder="Search chats"
          emptyText="No chats in this project."
          aria-label="Link to chat"
          className="w-full"
        />
        {error && <div role="alert" className="mt-[6px] text-[12px] text-[var(--error)]">{error}</div>}
      </div>
    </SideCard>
  )
}

/** Asks which chat gets the pending review context. Picking one when none is linked also links it. */
export function AskChatDialog() {
  const pending = useReviewStore((s) => s.pendingAsk)
  const setPendingAsk = useReviewStore((s) => s.setPendingAsk)
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPendingAsk(null) }}>
      {pending && <AskChatBody key={prKey(pending.pr)} />}
    </Dialog>
  )
}

function AskChatBody() {
  const pending = useReviewStore((s) => s.pendingAsk)!
  const linked = useReviewStore((s) => s.linkedChats[prKey(pending.pr)]) ?? []
  const linkable = useLinkableChats(pending.pr)
  const options = useMemo(() => chatOptions(linkable, linked), [linkable, linked])

  const [error, setError] = useState<string | null>(null)

  // The dialog stays open with the reason when the link fails, and nothing is delivered.
  const pick = async (id: string) => {
    const chat = [...linked, ...linkable].find((c) => c.id === id)
    if (!chat) return
    setError(null)
    const failed = await linkThenDeliver(
      pickNeedsLink(linked, chat.id),
      () => window.api.pullRequests.link(chat.id, pending.pr),
      async () => {
        useReviewStore.getState().setPendingAsk(null)
        await deliverReviewContext(chat, pending)
      },
    )
    setError(failed)
  }

  return (
    <DialogContent
      overlayClassName="z-[1300] bg-[rgba(0,0,0,0.4)]"
      className="sb-floating-surface inset-x-0 top-[18vh] z-[1300] mx-auto flex w-[min(460px,92vw)] flex-col gap-[10px] rounded-[10px] border border-[var(--border)] px-4 py-[14px] text-[13px] text-[var(--text-primary)]"
    >
      <DialogTitle className="m-0 text-[14px] font-[600]">Which chat should get this?</DialogTitle>
      <DialogDescription className="m-0 text-[12.5px] text-[var(--text-secondary)]">
        {reviewContextLabel(pending)}
        {'. A chat you pick that is not linked yet gets linked to this pull request.'}
      </DialogDescription>
      <Combobox
        value=""
        onValueChange={(id) => void pick(id)}
        options={options}
        placeholder="Pick a chat"
        searchPlaceholder="Search chats"
        emptyText="No chats in this project."
        aria-label="Chat"
        className="w-full"
        contentClassName="z-[1400]"
      />
      {error && <div role="alert" className="text-[12px] text-[var(--error)]">{error}</div>}
    </DialogContent>
  )
}
