import { describe, expect, it } from 'vitest'
import fixture from '../fixtures/chat-search-cases.json'
import { chatSearchSections, parseChatQuery, rankChats, titleMatchRange } from '@shared/chat-search'

const chats = fixture.chats

describe('rankChats (shared fixture, also run by Android ChatSearchFixturesTest)', () => {
  for (const c of fixture.cases) {
    it(c.id, () => {
      expect(rankChats(chats, c.query).map((chat) => chat.id)).toEqual(c.expected)
    })
  }
})

describe('parseChatQuery', () => {
  it('drops the archive words and turns archived chats on', () => {
    expect(parseChatQuery(' Fix ARCHIVED  sync ')).toEqual({ needle: 'fix sync', includeArchived: true })
    expect(parseChatQuery('fix')).toEqual({ needle: 'fix', includeArchived: false })
  })
})

describe('chatSearchSections', () => {
  it('splits an empty query into the newest 5 and the rest', () => {
    const sections = chatSearchSections(chats, '')
    expect(sections.map((s) => [s.heading, s.items.map((c) => c.id)])).toEqual([
      ['Recent', ['improvements', 'jitter', 'review', 'backoff', 'landing']],
      ['All chats', ['parity', 'engine', 'sync-exact', 'launch']],
    ])
  })

  it('drops an empty All chats section', () => {
    expect(chatSearchSections(chats.slice(0, 3), '').map((s) => s.heading)).toEqual(['Recent'])
  })

  it('gives a query one ranked list', () => {
    expect(chatSearchSections(chats, 'sync').map((s) => [s.heading, s.items.length])).toEqual([[null, 4]])
  })
})

describe('titleMatchRange', () => {
  it('finds the needle case-insensitively, ignoring the archive word', () => {
    expect(titleMatchRange('Fix sync jitter', 'SYNC archived')).toEqual([4, 8])
    expect(titleMatchRange('Fix sync jitter', 'ssg')).toBeNull()
    expect(titleMatchRange('Fix sync jitter', '')).toBeNull()
  })
})
