/**
 * Search over an index of ACP agents, for the Add agent dialog.
 *
 * STAGED: no registry backend exists yet, so the dialog's registry section is
 * behind `ACP_REGISTRY_SEARCH_ENABLED` (off) and the only source is a stub
 * that always reports the registry as unreachable. A real source replaces
 * `STUB_ACP_REGISTRY_SOURCE`; nothing here names an index URL.
 */

/** Feature flag `acp_registry_search`. Off until a registry backend exists. */
export const ACP_REGISTRY_SEARCH_ENABLED = false

export interface AcpRegistryEntry {
  id: string
  name: string
  description: string
  /** What "Add" puts in the local command form. */
  command: string
  args: string[]
}

export type AcpRegistryResult = { status: 'ok'; total: number; entries: AcpRegistryEntry[] } | { status: 'unreachable' }

export interface AcpRegistrySource {
  search(query: string): Promise<AcpRegistryResult>
}

export const STUB_ACP_REGISTRY_SOURCE: AcpRegistrySource = {
  search: async () => ({ status: 'unreachable' }),
}
