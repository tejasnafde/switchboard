# Native thread rich presentation design

## Goal

Match the React Native thread's transcript, slash command, and interactive
request behavior without translating its component architecture. The native
feed keeps stable row identities and restrained layout while presenting rich
agent output and truthful pending actions.

## Transcript presentation

A pure Kotlin parser converts agent Markdown into a small block and inline
model. It supports paragraphs, headings, fenced code (including incomplete
streaming fences), lists, quotes, rules, GFM tables, inline code, emphasis,
strong text, strike-through, and links. Compose renders that model directly.
Code and tables scroll horizontally; the feed itself owns vertical scrolling.
No row animation or nested vertical list may move the composer while streaming.

## Slash commands

Slash detection opens only when the whole draft matches
`^/([^\s/]*)$`. Switchboard built-ins precede backend skills and own collisions.
Prefix matches rank above substring matches while preserving source order.
Mode commands invoke the exact requested mode, stop invokes interrupt, image
opens the existing picker, and clear removes only this phone's visible feed.
Provider skills insert `/<name> ` for the user to complete and send.

The thread coordinator loads skills for its exact thread. A request token and
the existing connection/generation response key reject stale callbacks.

## Pending interactions

The coordinator publishes typed pending approval request IDs, question request
IDs, and plan IDs. Existing duplicate guards remain authoritative. A tap enters
pending state synchronously. Only a matching backend acknowledgement, a
matching user-message acknowledgement for plan implementation, or a definite
failure removes it. Events from another connection, generation, or thread are
ignored by the existing scope checks.

Approval, question, and plan cards disable while their own ID is pending and
show action-specific pending labels. Backend-resolved approvals/questions stay
resolved. No optimistic pending presentation claims command success.

## Verification

Pure JVM tests cover Markdown parsing, slash detection/merge/ranking/actions,
pending-state projection, exact identifier preservation, definite failure, and
stale response/event rejection. Existing thread reducer and presentation tests
remain green. Production Kotlin compilation validates the Compose renderer.
Physical-device typography, link launching, keyboard interaction, and long
streaming transcript feel remain hardware checks.
