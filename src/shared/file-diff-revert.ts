import type { FileDiffNoRevertReason } from './provider-events'

/** Why a diff card offers no Reject, in the words the card shows. */
export function fileDiffNoRevertMessage(reason: FileDiffNoRevertReason): string {
  switch (reason) {
    case 'outside':
      return "Changed outside this chat's edit tools. Reject is off, so it cannot undo someone else's work."
    case 'binary':
      return 'Binary file. Reject is off, because writing it back as text would corrupt it.'
    case 'unknown':
      return 'Switchboard could not read this file at the checkpoint. Reject is off.'
  }
}
