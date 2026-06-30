/**
 * Parse the JSON line our ssh probe prints on the remote. The probe runs a tiny
 * node script that reports the remote's node/platform/arch/abi and the installed
 * server version (from a marker file), so the connection manager can decide
 * whether to provision. node missing -> empty/garbage output -> all-null.
 */
export interface RemoteProbe {
  node: string | null
  platform: string | null
  arch: string | null
  abi: string | null
  server: string | null
}

const EMPTY: RemoteProbe = { node: null, platform: null, arch: null, abi: null, server: null }

export function parseProbeOutput(stdout: string): RemoteProbe {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) return { ...EMPTY }
  let parsed: Partial<RemoteProbe>
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return { ...EMPTY }
  }
  if (!parsed.node) return { ...EMPTY }
  return {
    node: parsed.node ?? null,
    platform: parsed.platform ?? null,
    arch: parsed.arch ?? null,
    abi: parsed.abi ?? null,
    server: parsed.server ?? null,
  }
}
