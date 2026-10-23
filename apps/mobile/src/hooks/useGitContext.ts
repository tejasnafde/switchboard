import { useCallback, useEffect, useRef, useState } from 'react'
import { getClient } from '../stores/connections'
import {
  INITIAL_GIT_CONTEXT,
  gitContextAnswered,
  gitContextFailed,
  gitContextLoading,
  type GitContextState,
} from '../lib/git-context'

/**
 * The branch of `cwd` on this connection's machine, read once on mount and
 * again on `refresh`. An answer to an older request is dropped.
 */
export function useGitContext(connectionId: string, cwd: string): { state: GitContextState; refresh: () => void } {
  const [state, setState] = useState(INITIAL_GIT_CONTEXT)
  const request = useRef(0)
  const checkout = useRef('')

  const refresh = useCallback(() => {
    const token = ++request.current
    // A retry keeps the last branch; another checkout must not show it.
    const target = `${connectionId}\n${cwd}`
    const same = checkout.current === target
    checkout.current = target
    setState((s) => gitContextLoading(same ? s : INITIAL_GIT_CONTEXT))
    const client = getClient(connectionId)
    if (!client) {
      setState((s) => gitContextFailed(s, 'Machine is not ready. Retry branch lookup.'))
      return
    }
    client.currentBranch(cwd).then(
      (result) => {
        if (token === request.current) setState((s) => gitContextAnswered(s, result))
      },
      (err: unknown) => {
        if (token === request.current)
          setState((s) => gitContextFailed(s, err instanceof Error ? err.message : String(err)))
      },
    )
  }, [connectionId, cwd])

  useEffect(() => {
    refresh()
    return () => {
      request.current += 1
    }
  }, [refresh])

  return { state, refresh }
}
