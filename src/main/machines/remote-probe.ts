/**
 * Parse the JSON line our ssh probe prints on the remote. The probe runs a tiny
 * node script that reports the remote's node/platform/arch/abi, the installed
 * server version (from a marker file), and - because a version marker alone
 * cannot tell us whether the managed CLIs actually work - the RESOLVED
 * executables and their installed versions. node missing -> empty/garbage
 * output -> all-null.
 */
export interface RemoteProbe {
  node: string | null
  platform: string | null
  arch: string | null
  abi: string | null
  server: string | null
  /** Payload marker of the sb-bridge extension installed on the remote. */
  bridge: string | null
  /**
   * realpath of the managed `claude` link, or null when it is absent OR
   * dangling. A dangling link is the case an existence test would pass and a
   * spawn would then fail, so it must read as absent here.
   */
  claudeBin: string | null
  /** Version of the installed `@anthropic-ai/claude-agent-sdk` whose CLI we link. */
  claudeVersion: string | null
  /** realpath of the managed `codex` link, same null semantics as claudeBin. */
  codexBin: string | null
  /** Version of the installed `@openai/codex`, not merely its presence. */
  codexVersion: string | null
  /** Marker recording which PINNED tool versions provisioning last completed. */
  tools: string | null
}

const EMPTY: RemoteProbe = {
  node: null,
  platform: null,
  arch: null,
  abi: null,
  server: null,
  bridge: null,
  claudeBin: null,
  claudeVersion: null,
  codexBin: null,
  codexVersion: null,
  tools: null,
}

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
  // Every field defaults to null, so a remote running an OLDER probe (one that
  // predates the tool fields) reports "unknown" rather than "fine" - which
  // makes the tool plan do the work instead of skipping it.
  return {
    node: parsed.node ?? null,
    platform: parsed.platform ?? null,
    arch: parsed.arch ?? null,
    abi: parsed.abi ?? null,
    server: parsed.server ?? null,
    bridge: parsed.bridge ?? null,
    claudeBin: parsed.claudeBin ?? null,
    claudeVersion: parsed.claudeVersion ?? null,
    codexBin: parsed.codexBin ?? null,
    codexVersion: parsed.codexVersion ?? null,
    tools: parsed.tools ?? null,
  }
}
