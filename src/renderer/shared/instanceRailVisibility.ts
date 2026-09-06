/**
 * UnifiedProviderPicker's instance rail collapses to a single column when
 * the active agent has fewer than 2 enabled instances - there is nothing to
 * choose between. But `instances` here is always the ENABLED set, so if the
 * stored/selected `instanceId` names a row that is missing or disabled, the
 * picker silently falls back to whichever enabled instance is left (see
 * `effectiveInstance` in UnifiedProviderPicker.tsx) with the rail hidden -
 * the one case where the user most needs to see and confirm what just
 * happened. The rail must stay visible for that repair, even down to a
 * single remaining enabled instance.
 */
export function shouldShowInstanceRail(
  instances: Array<{ id: string }>,
  instanceId: string | undefined,
): boolean {
  if (instances.length >= 2) return true
  if (!instanceId) return false
  return !instances.some((i) => i.id === instanceId)
}
