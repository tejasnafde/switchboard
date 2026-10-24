import { resolve, sep } from 'node:path'

/**
 * Local dev server addresses seen in terminal output, per PTY. The sender line
 * reads them so the agent knows which ports already serve the project.
 *
 * A PTY's entry holds the cwd it spawned in and the newest few loopback
 * addresses its output printed ("Local: http://localhost:5173/", "Listening on
 * port 8080"). The entry goes when the PTY exits. Output is scanned only when
 * a chunk holds a likely marker, so a busy terminal costs one substring test
 * per chunk.
 */

/** Addresses kept per PTY, newest first. */
export const DEV_SERVERS_PER_PTY = 3
/** Output (ANSI stripped) kept from the previous chunk, so an address split across two chunks still matches. */
const CARRY_CHARS = 256

// CSI, OSC (BEL or ST terminated) and two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const MARKER = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::|port/i
const LOOPBACK_URL = /\b(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})\b/gi
const LISTENING_PORT = /\b(?:listening|running|serving|started)\b[^\n]{0,40}?\bport\s*:?\s*(\d{1,5})\b/gi

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

function address(scheme: string, port: string): string | null {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return scheme.toLowerCase() === 'https' ? `https://localhost:${n}` : `localhost:${n}`
}

interface Match {
  end: number
  value: string
}

function matchDevServers(clean: string): Match[] {
  if (!MARKER.test(clean)) return []
  const found: Array<Match & { at: number }> = []
  for (const m of clean.matchAll(LOOPBACK_URL)) {
    const value = address(m[1], m[2])
    if (value) found.push({ at: m.index, end: m.index + m[0].length, value })
  }
  for (const m of clean.matchAll(LISTENING_PORT)) {
    const value = address('http', m[1])
    if (value) found.push({ at: m.index, end: m.index + m[0].length, value })
  }
  return found.sort((a, b) => a.at - b.at)
}

/** Loopback dev server addresses in `text`, in the order they appear. */
export function extractDevServers(text: string): string[] {
  return matchDevServers(stripAnsi(text)).map((m) => m.value)
}

interface PtyEntry {
  cwd: string
  /** Newest first, at most DEV_SERVERS_PER_PTY. */
  servers: string[]
  carry: string
}

function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

export class DevServerWatch {
  private ptys = new Map<string, PtyEntry>()

  /** Feed one chunk of a PTY's output. */
  observe(id: string, cwd: string, chunk: string): void {
    let entry = this.ptys.get(id)
    if (!entry) {
      entry = { cwd: resolve(cwd), servers: [], carry: '' }
      this.ptys.set(id, entry)
    }
    // The carry was scanned with the previous chunk, so a match that ends
    // inside it is not new. A match that ends at the end of the text may be
    // cut short ("localhost:51" of 5173); the next chunk reads it whole.
    const text = entry.carry + stripAnsi(chunk)
    const carried = entry.carry.length
    entry.carry = text.slice(-CARRY_CHARS)
    for (const { end, value } of matchDevServers(text)) {
      if (end < carried || end === text.length) continue
      entry.servers = [value, ...entry.servers.filter((s) => s !== value)].slice(0, DEV_SERVERS_PER_PTY)
    }
  }

  /** The PTY exited or was killed. */
  forget(id: string): void {
    this.ptys.delete(id)
  }

  /** Addresses from PTYs that run in `projectPath` or a folder under it, newest PTY first. */
  serversFor(projectPath: string | undefined, max = DEV_SERVERS_PER_PTY): string[] {
    if (!projectPath) return []
    const root = resolve(projectPath)
    const out: string[] = []
    for (const entry of [...this.ptys.values()].reverse()) {
      if (!isAtOrUnder(entry.cwd, root)) continue
      for (const server of entry.servers) {
        if (!out.includes(server)) out.push(server)
        if (out.length >= max) return out
      }
    }
    return out
  }
}

/** The backend's one watch, fed by `PtyManager` on the desktop and the headless server. */
export const devServerWatch = new DevServerWatch()
