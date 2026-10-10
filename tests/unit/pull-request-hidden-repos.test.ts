/**
 * Repositories the list could not read: which reasons offer hiding, one
 * group per host and reason with every owner named once, and the argument
 * check the hide channels run.
 */
import { describe, expect, it } from 'vitest'
import {
  groupRepoFailures,
  isHideableRepoError,
  MAX_REPOS_PER_HIDE,
  parseRepoRefs,
} from '../../src/shared/pull-request-hidden-repos'
import type { PrError, PrErrorKind, PrSource, RepoRef } from '../../src/shared/pull-requests'

const bb = (owner: string, name: string): RepoRef => ({ host: 'bitbucket', owner, name })
const source = (repo: RepoRef, kind: PrErrorKind | null): PrSource => ({
  repo,
  projectPaths: [],
  error: kind ? { kind, host: repo.host, message: 'x' } : null,
})

describe('isHideableRepoError', () => {
  it('offers hiding only for a repository the account cannot see', () => {
    const err = (kind: PrErrorKind): PrError => ({ kind, host: 'bitbucket', message: 'x' })
    expect(isHideableRepoError(err('not_found'))).toBe(true)
    expect(isHideableRepoError(err('forbidden'))).toBe(true)
    for (const kind of ['rate_limited', 'offline', 'token_rejected', 'unknown', 'no_account'] as const)
      expect(isHideableRepoError(err(kind))).toBe(false)
    expect(isHideableRepoError(null)).toBe(false)
  })
})

describe('groupRepoFailures', () => {
  it('groups by host and reason, owners in first-seen order', () => {
    const groups = groupRepoFailures([
      source(bb('geoiq-staging', 'geoiq_broker_app_stg'), 'not_found'),
      source(bb('geoiqadmin', 'ssg-bot'), null),
      source(bb('geoiq-staging', 'geoiqcore_stg'), 'not_found'),
      source(bb('other', 'x'), 'not_found'),
      source(bb('geoiqadmin', 'slow'), 'rate_limited'),
      source({ host: 'github', owner: 'acme', name: 'app' }, 'forbidden'),
    ])
    expect(groups).toEqual([
      {
        host: 'bitbucket',
        kind: 'not_found',
        owners: [
          { owner: 'geoiq-staging', names: ['geoiq_broker_app_stg', 'geoiqcore_stg'] },
          { owner: 'other', names: ['x'] },
        ],
        repos: [bb('geoiq-staging', 'geoiq_broker_app_stg'), bb('geoiq-staging', 'geoiqcore_stg'), bb('other', 'x')],
      },
      {
        host: 'github',
        kind: 'forbidden',
        owners: [{ owner: 'acme', names: ['app'] }],
        repos: [{ host: 'github', owner: 'acme', name: 'app' }],
      },
    ])
  })

  it('names a repository once, however it is spelled', () => {
    const groups = groupRepoFailures([
      source(bb('GeoIQ-Staging', 'Core'), 'not_found'),
      source(bb('geoiq-staging', 'core'), 'not_found'),
    ])
    expect(groups[0].owners).toEqual([{ owner: 'GeoIQ-Staging', names: ['Core'] }])
  })
})

describe('parseRepoRefs', () => {
  it('keeps only the three fields of a valid list', () => {
    expect(parseRepoRefs([{ host: 'bitbucket', owner: 'geoiq-staging', name: 'core_stg', number: 3 }])).toEqual([
      bb('geoiq-staging', 'core_stg'),
    ])
  })

  it('refuses anything else', () => {
    expect(parseRepoRefs([])).toBeNull()
    expect(parseRepoRefs('geoiq/core')).toBeNull()
    expect(parseRepoRefs([{ host: 'gitlab', owner: 'a', name: 'b' }])).toBeNull()
    expect(parseRepoRefs([{ host: 'github', owner: '../etc', name: 'b' }])).toBeNull()
    expect(parseRepoRefs([bb('a', 'b'), null])).toBeNull()
    expect(parseRepoRefs(Array.from({ length: MAX_REPOS_PER_HIDE + 1 }, (_, i) => bb('a', `r${i}`)))).toBeNull()
  })
})
