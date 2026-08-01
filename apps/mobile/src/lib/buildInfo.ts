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
  /** expo-updates id of the running bundle, null when it is the embedded one. */
  updateId: string | null
  /** Update channel, e.g. production. */
  channel: string | null
  /** True when running the bundle shipped inside the APK. */
  isEmbedded: boolean
}

/**
 * One short line, e.g. `v0.2.0 · production · ota 019fbd3f`.
 *
 * The update id is truncated: eight characters is enough to match against
 * `eas update:list` output without dominating the line.
 */
export function formatBuildStamp(facts: BuildFacts): string {
  const parts: string[] = [facts.version ? `v${facts.version}` : 'version unknown']
  if (facts.channel) parts.push(facts.channel)
  if (facts.isEmbedded || !facts.updateId) parts.push('embedded')
  else parts.push(`ota ${facts.updateId.slice(0, 8)}`)
  return parts.join(' · ')
}
