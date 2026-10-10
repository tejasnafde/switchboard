import { describe, expect, it } from 'vitest'
import { parseRemoteUrl, repoFromRemotes } from '../../src/shared/pull-request-remote'

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/tejasnafde/switchboard.git', 'github', 'tejasnafde', 'switchboard'],
    ['https://github.com/tejasnafde/switchboard', 'github', 'tejasnafde', 'switchboard'],
    ['https://github.com/tejasnafde/switchboard/', 'github', 'tejasnafde', 'switchboard'],
    ['git@github.com:tejasnafde/switchboard.git', 'github', 'tejasnafde', 'switchboard'],
    ['ssh://git@github.com/tejasnafde/switchboard.git', 'github', 'tejasnafde', 'switchboard'],
    ['ssh://git@ssh.github.com:443/tejasnafde/switchboard.git', 'github', 'tejasnafde', 'switchboard'],
    ['https://tejas@bitbucket.org/geoiq/ssg-bot-v2.git', 'bitbucket', 'geoiq', 'ssg-bot-v2'],
    ['git@bitbucket.org:geoiq/ssg-bot-v2.git', 'bitbucket', 'geoiq', 'ssg-bot-v2'],
    ['ssh://git@bitbucket.org/geoiq/ssg_bot.v2.git', 'bitbucket', 'geoiq', 'ssg_bot.v2'],
    ['  https://GitHub.com/Owner/Repo.GIT  ', 'github', 'Owner', 'Repo'],
  ])('%s', (url, host, owner, name) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, name })
  })

  it.each([
    'https://gitlab.com/group/project.git',
    'git@bitbucket.example.com:scm/proj/repo.git',
    'https://github.com/only-owner',
    'https://github.com/a/b/c',
    'https://github.com/a/..',
    '/Users/me/src/repo',
    'file:///Users/me/src/repo',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseRemoteUrl(url)).toBeNull()
  })
})

describe('repoFromRemotes', () => {
  const out = (lines: string[]) => lines.join('\n')

  it('prefers upstream, then origin, then any supported remote', () => {
    expect(
      repoFromRemotes(
        out([
          'origin\tgit@github.com:me/fork.git (fetch)',
          'origin\tgit@github.com:me/fork.git (push)',
          'upstream\thttps://github.com/org/repo.git (fetch)',
        ]),
      ),
    ).toEqual({ host: 'github', owner: 'org', name: 'repo' })
    expect(
      repoFromRemotes(
        out([
          'mirror\thttps://bitbucket.org/geoiq/mirror.git (fetch)',
          'origin\thttps://bitbucket.org/geoiq/main.git (fetch)',
        ]),
      ),
    ).toEqual({ host: 'bitbucket', owner: 'geoiq', name: 'main' })
    expect(
      repoFromRemotes(
        out(['origin\thttps://gitlab.com/a/b.git (fetch)', 'backup\tgit@github.com:me/backup.git (fetch)']),
      ),
    ).toEqual({ host: 'github', owner: 'me', name: 'backup' })
  })

  it('reads only fetch URLs, and nothing from an empty or unsupported list', () => {
    expect(repoFromRemotes(out(['origin\tgit@github.com:me/a.git (push)']))).toBeNull()
    expect(repoFromRemotes('')).toBeNull()
    expect(repoFromRemotes(out(['origin\thttps://gitlab.com/a/b.git (fetch)']))).toBeNull()
  })
})
