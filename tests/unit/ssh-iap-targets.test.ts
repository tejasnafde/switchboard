/**
 * parseIapTargets: discover IAP VMs from ~/.ssh/config ProxyCommand lines, so
 * the mobile app can offer them instead of making the user retype project /
 * zone / instance. Fixtures mirror the real shapes in the author's config,
 * including the quoted and unquoted flag styles that coexist there.
 */
import { describe, it, expect } from 'vitest'
import { parseIapTargets } from '../../src/main/machines/sshConfig'

describe('parseIapTargets', () => {
  it('extracts project and zone from a quoted ProxyCommand', () => {
    const config = `
Host geoiq-ssg-dev-in
  User tejas
  ProxyCommand gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project "prj-geoiq-decisioniq-in-prod" --zone "asia-south1-b"
`
    expect(parseIapTargets(config)).toEqual([
      {
        alias: 'geoiq-ssg-dev-in',
        instance: 'geoiq-ssg-dev-in',
        project: 'prj-geoiq-decisioniq-in-prod',
        zone: 'asia-south1-b',
      },
    ])
  })

  it('handles unquoted flags and an absolute gcloud path', () => {
    const config = `
Host giq-stg
  HostName geoiq-be-deployment-in-stg
  ProxyCommand /Users/x/.config/gcloud/virtenv/bin/python3 /Users/x/gcloud.py compute start-iap-tunnel 'geoiq-be-deployment-in-stg' '%p' --listen-on-stdin --project prj-geoiq-product-in-stg --zone=asia-south1-b --verbosity warning
`
    expect(parseIapTargets(config)).toEqual([
      {
        alias: 'giq-stg',
        // %h expands to HostName when set, so the instance is not the alias here.
        instance: 'geoiq-be-deployment-in-stg',
        project: 'prj-geoiq-product-in-stg',
        zone: 'asia-south1-b',
      },
    ])
  })

  it('ignores hosts with no IAP ProxyCommand', () => {
    const config = `
Host github.com
  User git
  IdentityFile ~/.ssh/id_ed25519

Host plain-box
  HostName 10.0.0.5
  ProxyCommand ssh -W %h:%p bastion
`
    expect(parseIapTargets(config)).toEqual([])
  })

  it('skips an IAP block missing project or zone rather than guessing', () => {
    const config = `
Host half-configured
  ProxyCommand gcloud compute start-iap-tunnel %h %p --project only-project
`
    expect(parseIapTargets(config)).toEqual([])
  })

  it('skips path-like Host aliases (real configs contain Host /usr/bin/ssh)', () => {
    const config = `
Host /usr/bin/ssh
  ProxyCommand gcloud compute start-iap-tunnel %h %p --project p --zone z
`
    expect(parseIapTargets(config)).toEqual([])
  })

  it('skips wildcard Host patterns', () => {
    const config = `
Host *
  ProxyCommand gcloud compute start-iap-tunnel %h %p --project p --zone z
`
    expect(parseIapTargets(config)).toEqual([])
  })

  it('emits one target per alias on a shared Host line', () => {
    const config = `
Host box-a box-b
  ProxyCommand gcloud compute start-iap-tunnel %h %p --project p --zone z
`
    expect(parseIapTargets(config).map((t) => t.alias)).toEqual(['box-a', 'box-b'])
  })

  it('parses several blocks and does not leak state between them', () => {
    const config = `
Host one
  ProxyCommand gcloud compute start-iap-tunnel %h %p --project p1 --zone z1

Host two
  ProxyCommand gcloud compute start-iap-tunnel %h %p --project p2 --zone z2

Host three
  HostName example.com
`
    const targets = parseIapTargets(config)
    expect(targets).toHaveLength(2)
    expect(targets[1]).toMatchObject({ alias: 'two', project: 'p2', zone: 'z2' })
  })
})
