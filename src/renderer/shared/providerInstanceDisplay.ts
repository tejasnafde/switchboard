/**
 * Pure display/default helpers for ProvidersTab.tsx's credential-home
 * display and new-instance auth-mode defaults. A path is only ever shown as
 * a path here - never inferred as an account identity, and never sourced
 * from an env value - so nothing here can leak a secret or an account
 * identity even by accident.
 */
import type { AgentType, EffectiveOauthDirSource } from '@shared/types'

export interface CredentialHomeDisplay {
  /** Text to render after "Credential home:". Never a raw guess - the
   *  'unresolved' case renders "cannot verify" instead of a directory. */
  text: string
  /** True only when this instance's credential home is genuinely isolated
   *  from every other instance of its kind (oauth_dir or a legacy env
   *  overlay) - false for the shared canonical default and for unresolved. */
  isolated: boolean
  /** Isolation-risk warning to show alongside `text`, or null when there is
   *  none to show (isolated, or unresolved - "cannot verify" already says
   *  enough without compounding it with a risk claim it cannot back up). */
  warning: string | null
}

const CANNOT_VERIFY = 'cannot verify'
const SHARED_WARNING = 'shared/ambient - not isolated to this instance'

/**
 * Render an instance's credential-home directory per `effectiveOauthDirSource`
 * - the backend-authoritative field, not the raw `oauthDir` column (a legacy
 * env-overlay row has no `oauthDir` at all but is still isolated).
 */
export function credentialHomeDisplay(
  effectiveOauthDir: string | null,
  source: EffectiveOauthDirSource,
): CredentialHomeDisplay {
  switch (source) {
    case 'oauth_dir':
      return { text: effectiveOauthDir ?? CANNOT_VERIFY, isolated: true, warning: null }
    case 'env':
      return {
        text: `${effectiveOauthDir ?? CANNOT_VERIFY} (legacy env-overlay home)`,
        isolated: true,
        warning: null,
      }
    case 'default':
      return {
        text: `${effectiveOauthDir ?? CANNOT_VERIFY} (shared canonical home)`,
        isolated: false,
        warning: SHARED_WARNING,
      }
    case 'unresolved':
      return { text: CANNOT_VERIFY, isolated: false, warning: null }
  }
}

export function defaultAuthModeForNewInstance(agentType: AgentType): 'env' | 'oauth_dir' {
  return agentType === 'codex' ? 'oauth_dir' : 'env'
}
