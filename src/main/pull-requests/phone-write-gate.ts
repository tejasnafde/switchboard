/**
 * The gate in front of the write channels a `pr-write` phone may call. The
 * desktop and admin devices write as before. Any other caller (the channel
 * gate let it through, so it holds `pr-write`) must prove what its confirm
 * sheet showed, once per write id (`PullRequestService.checkPhoneWrite`).
 */
import type { PhonePrWriteAction } from '@shared/pull-request-phone-writes'
import type { PrError, PrResult } from '@shared/pull-requests'
import type { PrWriteDone } from '@shared/pull-request-writes'
import { recordPrWrite } from '../backend/device-sessions'
import { currentBackendRequestContext, describeRequestClient, remoteDeviceHasScope } from '../backend/request-context'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:phone-write')

export type WriteHandler = (ref: unknown, input: unknown) => Promise<PrResult<PrWriteDone>>

export interface PhoneWriteGateDeps {
  checkPhoneWrite(ref: unknown, action: PhonePrWriteAction, input: unknown): Promise<PrError | null>
  /** Stamps the device's last write for the Devices tab. */
  recordPrWrite?(sessionId: string): void
}

export function phoneWrite(
  action: PhonePrWriteAction,
  deps: () => PhoneWriteGateDeps,
  run: WriteHandler,
): WriteHandler {
  return async (ref, input) => {
    if (remoteDeviceHasScope('admin')) return run(ref, input)
    const gate = deps()
    const refused = await gate.checkPhoneWrite(ref, action, input)
    if (refused) return { ok: false, error: refused }
    log.info('phone pull request write', { action, client: describeRequestClient() })
    const result = await run(ref, input)
    const sessionId = currentBackendRequestContext()?.deviceSessionId
    if (result.ok && sessionId) {
      const record = gate.recordPrWrite ?? recordPrWrite
      try {
        record(sessionId)
      } catch (err) {
        log.warn('could not record the device last write time', err)
      }
    }
    return result
  }
}
