/**
 * The rules behind link provenance, a link's stored PR state, several remotes
 * per project and the shell commands that merge or close a PR.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canLinkToProject,
  linkHeaderState,
  linkSourceLabel,
  mergesOrClosesPr,
  phoneLinkRowText,
  unlinkPrLabel,
  type PrLink,
} from '../../src/shared/pull-request-links'
import { coveredRepos, projectReposFrom } from '../../src/shared/project-repos'
import { parseFullName, repoFromRemotes, reposFromRemotes } from '../../src/shared/pull-request-remote'
import type { RepoRef } from '../../src/shared/pull-requests'

const UP: RepoRef = { host: 'github', owner: 'acme', name: 'app' }
const FORK: RepoRef = { host: 'github', owner: 'me', name: 'app' }
const OTHER: RepoRef = { host: 'github', owner: 'acme', name: 'lib' }

describe('link provenance labels', () => {
  it('names every source, and an unknown one from a newer backend neutrally', () => {
    expect(linkSourceLabel('manual')).toBe('Linked by you')
    expect(linkSourceLabel('auto')).toBe('Linked automatically')
    expect(linkSourceLabel('agent')).toBe('Linked by the agent')
    expect(linkSourceLabel('created')).toBe('Opened by the agent')
    expect(linkSourceLabel('stack')).toBe('Linked')
    expect(linkSourceLabel(undefined)).toBe('Linked')
  })
})

const rowCases: Array<{ id: string; link: PrLink; text: string; unlinkLabel: string }> = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/pr-link-rows.json'), 'utf8'),
)

describe('phoneLinkRowText (tests/fixtures/pr-link-rows.json, shared with Android)', () => {
  it.each(rowCases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(phoneLinkRowText(c.link)).toBe(c.text)
    expect(unlinkPrLabel(c.link.ref)).toBe(c.unlinkLabel)
  })
})

describe('linkHeaderState', () => {
  it('prefers a state stored after the Reviews list was read', () => {
    expect(linkHeaderState({ state: 'merged', stateAt: 200 }, 'open', 100)).toBe('merged')
    expect(linkHeaderState({ state: 'merged', stateAt: 50 }, 'open', 100)).toBe('open')
  })

  it('falls back to whichever one is known', () => {
    expect(linkHeaderState({ state: 'closed', stateAt: 5 }, null, null)).toBe('closed')
    expect(linkHeaderState({}, 'merged', 100)).toBe('merged')
    expect(linkHeaderState({}, null, null)).toBeNull()
  })
})

describe('mergesOrClosesPr', () => {
  it.each([
    'gh pr merge 612 --merge',
    'cd app && gh pr merge --squash',
    'gh pr close 9',
    'bbpr merge 605',
    'bbpr decline 605',
  ])('%s', (command) => expect(mergesOrClosesPr(command)).toBe(true))

  it.each(['gh pr view 612', 'gh pr list', 'echo gh pr merges', 'git merge main', 'bbpr 605'])('not %s', (command) => {
    expect(mergesOrClosesPr(command)).toBe(false)
  })
})

describe('several remotes per project', () => {
  const remotes = [
    `origin\tgit@github.com:${FORK.owner}/${FORK.name}.git (fetch)`,
    `origin\tgit@github.com:${FORK.owner}/${FORK.name}.git (push)`,
    `upstream\thttps://github.com/${UP.owner}/${UP.name}.git (fetch)`,
    `upstream\thttps://github.com/${UP.owner}/${UP.name}.git (push)`,
    'mirror\thttps://gitlab.com/x/y.git (fetch)',
  ].join('\n')

  it('lists every supported remote, upstream first, then origin, once each', () => {
    expect(reposFromRemotes(remotes)).toEqual([UP, FORK])
    expect(repoFromRemotes(remotes)).toEqual(UP)
    expect(reposFromRemotes('')).toEqual([])
  })

  it('a project covers its other remotes and a fork parent, and still nothing else', () => {
    const project = projectReposFrom(UP, [], [FORK, UP])
    expect(coveredRepos(project)).toEqual([UP, FORK])
    expect(canLinkToProject({ ...FORK, number: 3 }, project)).toBe(true)
    expect(canLinkToProject({ ...UP, number: 4 }, project)).toBe(true)
    expect(canLinkToProject({ ...OTHER, number: 5 }, project)).toBe(false)
  })

  it('a fork-only clone covers the fork parent it was given', () => {
    const project = projectReposFrom(FORK, [], [UP])
    expect(canLinkToProject({ ...UP, number: 4 }, project)).toBe(true)
  })

  it('a parent folder keeps covering only its children', () => {
    const project = projectReposFrom(null, [{ path: '/p/a', relPath: 'a', repo: OTHER }], [UP])
    expect(coveredRepos(project)).toEqual([OTHER])
  })
})

describe('parseFullName', () => {
  it('reads owner/name and refuses anything else', () => {
    expect(parseFullName('github', 'acme/app')).toEqual(UP)
    expect(parseFullName('bitbucket', 'geoiq/bot')).toEqual({ host: 'bitbucket', owner: 'geoiq', name: 'bot' })
    expect(parseFullName('github', '')).toBeNull()
    expect(parseFullName('github', 'null')).toBeNull()
    expect(parseFullName('github', 'a/b/c')).toBeNull()
    expect(parseFullName('github', 'a/..')).toBeNull()
  })
})
