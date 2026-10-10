import { describe, expect, it } from 'vitest'
import { prCommandLinks } from '../../src/shared/pr-command-links'

const PR = 'https://github.com/acme/proj/pull/55'

describe('prCommandLinks', () => {
  it('takes the PR a gh command works on', () => {
    expect(prCommandLinks(`gh pr checkout ${PR}`)).toEqual({ urls: [PR], creates: false })
    expect(prCommandLinks(`cd /repo && gh pr merge --merge ${PR}`).urls).toEqual([PR])
    expect(prCommandLinks(`gh pr comment ${PR} --body "lgtm"`).urls).toEqual([PR])
  })

  it('ignores reads and quoted mentions', () => {
    expect(prCommandLinks(`gh pr view ${PR}`).urls).toEqual([])
    expect(prCommandLinks(`gh pr diff ${PR} | head`).urls).toEqual([])
    expect(prCommandLinks(`cat CHANGELOG.md | grep ${PR}`).urls).toEqual([])
    expect(prCommandLinks(`gh pr comment 9 --body "follows ${PR}"`).urls).toEqual([])
  })

  it('marks gh pr create, whose output is the new PR, without linking its body', () => {
    expect(prCommandLinks(`gh pr create --title t --body "after ${PR}"`)).toEqual({ urls: [], creates: true })
  })

  it('takes the PR bbpr fetches for review', () => {
    const bb = 'https://bitbucket.org/ws/repo/pull-requests/605'
    expect(prCommandLinks(`bbpr ${bb} diff`).urls).toEqual([bb])
    expect(prCommandLinks('bbpr 605').urls).toEqual([])
  })
})
