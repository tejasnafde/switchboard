/**
 * What a machine row renders for each transport state. The state rules are
 * tested in tests/unit/connection-security.test.ts.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import type { ConnectionSecurity } from '@shared/connection-security'
import { MachineRow } from '../MachineRow'
import { OldQrSheet } from '../OldQrSheet'
import { renderComponent } from '../../test/render'
import type { ConnectionConfig, ConnectionStatus } from '../../stores/connections'

const FP = '7c0e51b2' + 'a'.repeat(56)

function row(
  security: ConnectionSecurity,
  config: Partial<ConnectionConfig> = {},
  status: ConnectionStatus = 'connected',
) {
  const handlers = {
    onOpen: jest.fn(),
    onActions: jest.fn(),
    onScan: jest.fn(),
    onUseIap: jest.fn(),
    onRemove: jest.fn(),
  }
  const view = renderComponent(
    <MachineRow
      config={
        {
          id: 'a',
          kind: 'ws',
          label: 'Build server',
          url: `ws://192.168.1.40:8765?fp=${FP}`,
          ...config,
        } as ConnectionConfig
      }
      status={status}
      security={security}
      {...handlers}
    />,
  )
  return { view, handlers }
}

describe('MachineRow', () => {
  it('shows a pinned row with the lock, Encrypted, the short fingerprint and the address', () => {
    const { view } = row('pinned')
    const texts = view.texts()
    expect(texts).toEqual(expect.arrayContaining(['Build server', '7c0e51b2', 'Encrypted', '192.168.1.40:8765']))
    expect(view.iconNames()).toEqual(['lock-closed'])
    expect(texts.join(' ')).not.toContain(FP)
  })

  it('shows a local row with no lock, no fingerprint and no hint', () => {
    const { view } = row('local', { url: 'ws://127.0.0.1:8765' })
    expect(view.texts()).toEqual(expect.arrayContaining(['Not encrypted, local only', '127.0.0.1:8765']))
    expect(view.iconNames()).toEqual([])
    expect(view.allByLabel(/Scan|Cloud IAP|Remove/)).toHaveLength(0)
  })

  it('shows the IAP zone with a lock', () => {
    const { view } = row('iap', {
      kind: 'iap',
      label: 'geoiq-ssg-dev',
      zone: 'asia-south1-a',
      instance: 'vm',
      project: 'p',
      port: 8766,
    } as never)
    expect(view.texts()).toEqual(expect.arrayContaining(['Cloud IAP', 'asia-south1-a']))
    expect(view.iconNames()).toEqual(['lock-closed'])
  })

  it('gives a refused row the amber hint with Scan new QR and Use Cloud IAP, and no retry', () => {
    const { view, handlers } = row('refused', { url: 'ws://10.0.4.17:8765' }, 'error')
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        'Needs encryption',
        'Not encrypted. This app only connects over an encrypted link. Update Switchboard on that computer and scan its new QR, or use Cloud IAP.',
      ]),
    )
    expect(view.root.findByProps({ testID: 'machine-dot-refused' })).toBeTruthy()
    expect(view.allByLabel(/Retry|Connect/)).toHaveLength(0)
    act(() => view.byLabel('Scan new QR').props.onPress())
    act(() => view.byLabel('Use Cloud IAP').props.onPress())
    expect(handlers.onScan).toHaveBeenCalledTimes(1)
    expect(handlers.onUseIap).toHaveBeenCalledTimes(1)
  })

  it('gives a certificate-changed row the red hint with the pinned fingerprint, Scan QR again and Remove', () => {
    const { view, handlers } = row('certificate-changed', {}, 'error')
    const text = view.texts().join('')
    expect(text).toContain('Certificate changed')
    expect(text).toContain(
      'After a reinstall or reset, scan its new QR from Settings, Devices & machines on that computer. Not expected? Someone on this network may be intercepting. Check that screen first: if it still shows 7c0e51b2, do not scan.',
    )
    act(() => view.byLabel('Scan QR again').props.onPress())
    act(() => view.byLabel('Remove').props.onPress())
    expect(handlers.onScan).toHaveBeenCalledTimes(1)
    expect(handlers.onRemove).toHaveBeenCalledTimes(1)
  })
})

describe('OldQrSheet', () => {
  it('names the old QR, the refused address and the two ways out', () => {
    const handlers = { onScanAgain: jest.fn(), onUseIap: jest.fn(), onCancel: jest.fn() }
    const view = renderComponent(<OldQrSheet address="ws://10.0.4.17:8765" {...handlers} />)
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        'QR from an older Switchboard',
        'ws://10.0.4.17:8765',
        'no certificate',
        'Update Switchboard on that computer first. Its new QR is in Settings, Devices & machines.',
        'For a Google Cloud VM. Sign in with Google, then pick the instance.',
        'Cancel',
      ]),
    )
    act(() => view.byLabel('Scan again').props.onPress())
    act(() => view.byLabel('Connect through Cloud IAP').props.onPress())
    expect(handlers.onScanAgain).toHaveBeenCalledTimes(1)
    expect(handlers.onUseIap).toHaveBeenCalledTimes(1)
  })

  it('renders nothing while there is no refused address', () => {
    const view = renderComponent(
      <OldQrSheet address={null} onScanAgain={jest.fn()} onUseIap={jest.fn()} onCancel={jest.fn()} />,
    )
    expect(view.texts()).not.toContain('QR from an older Switchboard')
  })
})
