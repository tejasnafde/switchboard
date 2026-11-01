/**
 * Saved secrets masked in what the backend logs. A log line belongs to no
 * chat, so every live value is matched (`redactAnyText`). The logger masks
 * each line it writes; a caller that truncates a payload masks it first
 * (`maskLog`), so a cut never leaves part of a value. A child's stderr comes
 * in chunks that can split a value, so it is logged by whole lines
 * (`LogLines`).
 */
import { secretRedactor } from './secret-redactor'

/** A line held this long with no newline is logged up to where a match could start. */
const MAX_PENDING_CHARS = 8 * 1024

export function maskLog(text: string): string {
  return secretRedactor.any() ? (secretRedactor.redactAnyText(text) ?? text) : text
}

export class LogLines {
  private pending = ''

  constructor(private readonly write: (text: string) => void) {}

  push(chunk: string): void {
    const text = this.pending + chunk
    let cut = text.lastIndexOf('\n') + 1
    if (cut === 0 && text.length > MAX_PENDING_CHARS) cut = secretRedactor.holdFromAny(text)
    this.pending = text.slice(cut)
    if (cut > 0) this.write(maskLog(text.slice(0, cut).replace(/\n$/, '')))
  }

  /** The stream closed: log what is left. */
  end(): void {
    if (this.pending) this.write(maskLog(this.pending))
    this.pending = ''
  }
}
