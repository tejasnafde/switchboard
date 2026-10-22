/**
 * Matching the reviewers an agent names on create_pull_request against the
 * repository's reviewer candidates: exact (case and a leading @ aside) on id,
 * login, display name or a listed email; else the one close candidate; several
 * close candidates or none refused; the signed-in user refused; at most 10.
 */
import { describe, expect, it } from 'vitest'
import { checkReviewerNames, keptReviewers, resolveReviewers, reviewerLabel } from '../../src/shared/agent-pr-reviewers'
import { checkCreatePrArgs } from '../../src/shared/agent-pr-create'
import type { PrReviewerCandidate } from '../../src/shared/pull-requests'

const user = (id: string, login: string, displayName: string, email?: string): PrReviewerCandidate => ({
  id,
  person: { login, displayName, avatarUrl: null },
  kind: 'user',
  reviewed: 0,
  ...(email ? { email } : {}),
})
const GH = [
  user('jdoe', 'jdoe', 'Jane Doe', 'jane@acme.dev'),
  user('jsmith', 'jsmith', 'Jane Smith'),
  user('rahul', 'rahul', 'rahul'),
  user('me', 'me', 'Me Myself'),
  {
    id: 'team:platform',
    person: { login: 'platform', displayName: 'Platform', avatarUrl: null },
    kind: 'team' as const,
    reviewed: 0,
  },
]
const ME = { id: 'me', login: 'me' }

describe('checkReviewerNames', () => {
  it('is none when absent, trims, and drops case-insensitive duplicates', () => {
    expect(checkReviewerNames(undefined)).toEqual({ ok: true, value: [] })
    expect(checkReviewerNames([' jdoe ', 'JDOE', 'rahul'])).toEqual({ ok: true, value: ['jdoe', 'rahul'] })
  })

  it('refuses a non-list, an empty entry and more than 10', () => {
    expect(checkReviewerNames('jdoe').ok).toBe(false)
    expect(checkReviewerNames(['jdoe', ' ']).ok).toBe(false)
    expect(checkReviewerNames([1]).ok).toBe(false)
    expect(checkReviewerNames(Array.from({ length: 10 }, (_, i) => `r${i}`)).ok).toBe(true)
    expect(checkReviewerNames(Array.from({ length: 11 }, (_, i) => `r${i}`))).toEqual({
      ok: false,
      message: 'That is 11 reviewers; a pull request opened here asks for at most 10.',
    })
  })

  it('rides on checkCreatePrArgs', () => {
    expect(checkCreatePrArgs({ title: 'T', reviewers: ['a'] })).toMatchObject({ ok: true, value: { reviewers: ['a'] } })
    expect(checkCreatePrArgs({ title: 'T' })).toMatchObject({ ok: true, value: { reviewers: [] } })
    expect(checkCreatePrArgs({ title: 'T', reviewers: 'a' }).ok).toBe(false)
  })
})

describe('resolveReviewers', () => {
  it('matches exactly on login, display name, email or team slug, ignoring case and a leading @', () => {
    expect(
      resolveReviewers('github', ['@JDOE', 'jane smith', 'Platform', 'team:platform', 'JANE@acme.dev'], GH, ME),
    ).toEqual({
      ok: true,
      value: [
        { id: 'jdoe', login: 'jdoe', displayName: 'Jane Doe', kind: 'user' },
        { id: 'jsmith', login: 'jsmith', displayName: 'Jane Smith', kind: 'user' },
        { id: 'team:platform', login: 'team:platform', displayName: 'Platform', kind: 'team' },
      ],
    })
  })

  it('takes the one close candidate when no name matches exactly', () => {
    const team = [user('sidhu', 'sidhu', 'Sidhu Subhash'), ...GH]
    expect(resolveReviewers('github', ['Sidhu'], team, ME)).toEqual({
      ok: true,
      value: [{ id: 'sidhu', login: 'sidhu', displayName: 'Sidhu Subhash', kind: 'user' }],
    })
    const self = resolveReviewers('github', ['Myself'], GH, ME)
    expect(self.ok ? null : self.message).toContain('the only close one is the signed-in user')
  })

  it('never takes a close candidate by a shared word or an email', () => {
    const team = [user('abrown', 'abrown', 'Alex Brown'), user('sj', 'sam.jones', 'Sam Jones', 'x@geoiq.io')]
    for (const name of ['Alex Kumar', 'geoiq reviewer']) {
      const r = resolveReviewers('github', [name], [...team, ...GH], ME)
      expect(r.ok, name).toBe(false)
    }
    const kumar = resolveReviewers('github', ['Alex Kumar'], team, ME)
    expect(kumar.ok ? null : kumar.message).toContain('close: Alex Brown (abrown)')
  })

  it('refuses a name with several close candidates, listing them, and one with none', () => {
    const r = resolveReviewers('github', ['jane'], GH, ME)
    expect(r).toEqual({
      ok: false,
      message: expect.stringContaining(
        '"jane" is not an exact match, and 2 people are close: Jane Doe (jdoe), Jane Smith (jsmith). Use a login.',
      ),
    })
    const nobody = resolveReviewers('github', ['zzz'], GH, ME)
    expect(nobody.ok ? null : nobody.message).toContain('"zzz" is not someone who can review here.')
  })

  it('refuses a name two people share', () => {
    const twins = [user('a1', 'alex1', 'Alex'), user('a2', 'alex2', 'Alex')]
    const r = resolveReviewers('github', ['alex'], twins, ME)
    expect(r.ok ? null : r.message).toContain('"alex" matches 2 people: Alex (alex1), Alex (alex2). Use a login.')
  })

  it('refuses the signed-in user: by GitHub login in any case, by Bitbucket uuid', () => {
    const gh = resolveReviewers('github', ['ME'], GH, ME)
    expect(gh.ok ? null : gh.message).toContain('"ME" is the signed-in user')
    const uuid = '{00000000-0000-4000-8000-000000000001}'
    const bb = resolveReviewers('bitbucket', ['Tejas'], [user(uuid, 'tejas', 'Tejas')], { id: uuid, login: null })
    expect(bb.ok).toBe(false)
    expect(
      resolveReviewers('bitbucket', ['Tejas'], [user(uuid, 'tejas', 'Tejas')], { id: '{other}', login: null }).ok,
    ).toBe(true)
  })

  it('names every name that failed at once', () => {
    const r = resolveReviewers('github', ['zzz', 'jdoe', 'me'], GH, ME)
    expect(r.ok ? null : r.message).toMatch(/"zzz".*"me"/)
    expect(r.ok ? null : r.message).toContain('Nothing was created.')
  })

  it('keeps one entry when two names are the same person', () => {
    expect(resolveReviewers('github', ['jdoe', 'Jane Doe'], GH, ME)).toMatchObject({
      ok: true,
      value: [{ id: 'jdoe' }],
    })
  })
})

describe('keptReviewers and reviewerLabel', () => {
  const card = [
    { id: 'a', login: 'a', displayName: 'A', kind: 'user' as const },
    { id: 'b', login: 'b', displayName: 'b', kind: 'user' as const },
  ]
  it('keeps all when the approval says nothing, else only the listed ids of the card, in its order', () => {
    expect(keptReviewers(card, undefined)).toEqual(card)
    expect(keptReviewers(card, ['b', 'x', 'a'])).toEqual(card)
    expect(keptReviewers(card, ['b'])).toEqual([card[1]])
    expect(keptReviewers(card, [])).toEqual([])
  })
  it('labels with the login alone when the display name is the login', () => {
    expect(card.map(reviewerLabel)).toEqual(['A (a)', 'b'])
  })
})
