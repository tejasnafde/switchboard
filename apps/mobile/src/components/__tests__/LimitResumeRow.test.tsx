import React from 'react'
import { act } from 'react-test-renderer'
import type { LimitState } from '@shared/limit-resume'
import type { RuntimeEvent } from '@shared/provider-events'
import type { SwitchboardClient } from '../../lib/api'
import { renderComponent } from '../../test/render'
import { LimitResumeRow } from '../LimitResumeRow'

const RESET = new Date(2026, 9, 22, 15, 40).getTime()

function fakeClient(initial: LimitState) {
  let state = initial
  const handlers = new Set<(event: RuntimeEvent) => void>()
  const client = {
    limitResumeGet: jest.fn(async () => state),
    limitResumeCancel: jest.fn(async () => {}),
    limitResumeNow: jest.fn(async () => ({ ok: false as const, message: 'The usage window is still closed.' })),
    onEvent: (handler: (event: RuntimeEvent) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  const emit = (next: LimitState) => {
    state = next
    for (const handler of handlers) handler({ type: 'limit-resume.changed', threadId: 't1', state: next })
  }
  return { client, emit, asClient: client as unknown as SwitchboardClient }
}

const flush = () => act(async () => {})

it('shows the reset time with Resume now and Cancel auto-resume while armed', async () => {
  const { asClient } = fakeClient({ kind: 'armed', resetAt: RESET })
  const root = renderComponent(<LimitResumeRow client={asClient} threadId="t1" />)
  await flush()
  expect(root.texts().join(' ')).toMatch(/Usage limit\. Resumes \S*3:40/)
  expect(root.allByLabel('Resume now')).toHaveLength(1)
  expect(root.allByLabel('Cancel auto-resume')).toHaveLength(1)
})

it('renders nothing while the chat is not limited, and appears on limit-resume.changed', async () => {
  const { asClient, emit } = fakeClient({ kind: 'none' })
  const root = renderComponent(<LimitResumeRow client={asClient} threadId="t1" />)
  await flush()
  expect(root.texts()).toEqual([])
  emit({ kind: 'gave_up' })
  await flush()
  expect(root.texts()).toContain('Usage limit. Gave up after 3 tries.')
  expect(root.allByLabel('Resume now')).toHaveLength(0)
})

it('shows why Resume now did not resume, and cancels', async () => {
  const { client, asClient } = fakeClient({ kind: 'armed', resetAt: RESET })
  const root = renderComponent(<LimitResumeRow client={asClient} threadId="t1" />)
  await flush()
  await act(async () => root.byLabel('Resume now').props.onPress())
  expect(client.limitResumeNow).toHaveBeenCalledWith('t1')
  expect(root.texts().join(' ')).toContain('The usage window is still closed.')
  await act(async () => root.byLabel('Cancel auto-resume').props.onPress())
  expect(client.limitResumeCancel).toHaveBeenCalledWith('t1')
})
