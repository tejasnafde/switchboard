/**
 * The app links this phone opens, after the `switchboard://` prefix. Same rule
 * as Android's `SwitchboardDeepLinkContract.appRoute`: only `settings`, with no
 * query, fragment or extra path. Anything else is ignored rather than guessed at.
 */
export type AppLinkRoute = 'Settings'

export function appLinkRoute(path: string): AppLinkRoute | null {
  return path === 'settings' || path === '/settings' ? 'Settings' : null
}
