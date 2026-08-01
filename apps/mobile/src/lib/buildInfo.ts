/**
 * What build am I looking at.
 *
 * An APK carries native code from one commit and then stacks OTA bundles on top,
 * so "the app version" alone does not identify what is running. When something
 * looks wrong the first question is which bundle it is, and guessing wastes a
 * debugging round.
 *
 * Pure formatting; the caller supplies the values from expo-updates.
 */

export interface BuildFacts {
  /** Native app version, from the installed binary. */
  version: string | null
  /**
   * expo-updates id of the running bundle.
   *
   * Null only where expo-updates is disabled, which in practice means a dev
   * client served by Metro. A production APK running its embedded bundle still
   * reports a real id, so this does NOT distinguish embedded from OTA -
   * `isEmbedded` is what does that.
   */
  updateId: string | null
  /** Update channel, e.g. production. */
  channel: string | null
  /** True when running the bundle shipped inside the APK. */
  isEmbedded: boolean
  /**
   * True when a downloaded update failed to load and expo-updates fell back to
   * the embedded bundle.
   *
   * Worth its own word on the stamp: the app is running code the user did not
   * get served, and without this it is indistinguishable from a normal
   * embedded launch, which is the exact confusion this module exists to end.
   */
  isEmergencyLaunch: boolean
}

/**
 * One short line, e.g. `v0.3.0 · production · ota 019fbd3f`.
 *
 * The update id is truncated: eight characters is enough to match against
 * `eas update:list` output without dominating the line.
 */
export function formatBuildStamp(facts: BuildFacts): string {
  const parts: string[] = [facts.version ? `v${facts.version}` : 'version unknown']
  if (facts.channel) parts.push(facts.channel)
  // Checked before the embedded/ota split: a fallback launch IS embedded, and
  // reporting only that would hide the failure that caused it.
  if (facts.isEmergencyLaunch) parts.push('embedded (update failed)')
  else if (facts.isEmbedded) parts.push('embedded')
  else if (facts.updateId) parts.push(`ota ${facts.updateId.slice(0, 8)}`)
  // No id and not embedded means expo-updates is off, i.e. Metro is serving.
  else parts.push('dev bundle')
  return parts.join(' · ')
}
