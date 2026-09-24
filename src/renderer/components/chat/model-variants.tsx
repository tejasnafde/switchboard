import { useAgentStore } from '../../stores/agent-store'

/**
 * Split a flat model list into provider-prefix groups.
 * IDs without a `/` go into `ungrouped` (Claude/Codex static lists). Order
 * is stable: groups appear in the order their first member shows up in the
 * input array.
 *
 * Exported for unit tests.
 */
export function groupModelsByProvider<T extends { id: string }>(
  models: T[],
): { ungrouped: T[]; groups: Array<{ provider: string; models: T[] }> } {
  const ungrouped: T[] = []
  const groupMap = new Map<string, T[]>()
  const order: string[] = []
  for (const m of models) {
    const slash = m.id.indexOf('/')
    if (slash === -1) {
      ungrouped.push(m)
      continue
    }
    const provider = m.id.slice(0, slash)
    if (!groupMap.has(provider)) {
      groupMap.set(provider, [])
      order.push(provider)
    }
    groupMap.get(provider)!.push(m)
  }
  return {
    ungrouped,
    groups: order.map((p) => ({ provider: p, models: groupMap.get(p)! })),
  }
}

// ─── Variant chips (OpenCode ACP) ───────────────────────────────

/**
 * Renders a small chip group next to the model picker showing the variants
 * (`low` / `medium` / `high` / `max`, etc.) the agent has advertised for the
 * currently selected model. Hidden when the model has no variants.
 *
 * The base model id is the current `model` prop with any trailing variant
 * stripped - variants are the third path segment for OpenCode-style ids
 * (`provider/model/<variant>`). When the user clicks a chip, we rewrite the
 * model to `<base>/<variant>` and bubble through `onChange`.
 */
export function VariantChips({
  sessionId,
  model,
  onChange,
}: {
  sessionId: string | null
  model: string
  onChange: (model: string) => void
}) {
  const session = useAgentStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined,
  )
  const available = session?.availableVariants ?? []
  const current = session?.currentVariant ?? ''
  if (available.length === 0) return null

  const { base } = splitModelVariant(model, available)

  const chip = (label: string, variant: string, active: boolean) => (
    <button
      key={variant || '__base__'}
      onClick={() => onChange(variant ? `${base}/${variant}` : base)}
      style={{
        background: active ? 'var(--accent)' : 'var(--bg-tertiary)',
        color: active ? 'white' : 'var(--text-secondary)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        padding: '2px 6px',
        fontSize: '10px',
        fontFamily: 'var(--font-mono)',
        cursor: 'pointer',
        outline: 'none',
      }}
      title={`thinking budget: ${label}`}
    >
      {label}
    </button>
  )

  return (
    <span style={{ display: 'inline-flex', gap: '3px', alignItems: 'center' }}>
      {available.map((v) => chip(v || 'base', v, v === current))}
    </span>
  )
}

/**
 * Strip a variant suffix (e.g. `/low` / `/high`) from a model id, given the
 * set of variants the agent advertises. Returns the base id and the
 * detected variant (empty string when the id is already a base model).
 *
 * Exported for unit tests.
 */
export function splitModelVariant(
  id: string,
  variants: string[],
): { base: string; variant: string } {
  for (const v of variants) {
    if (v && id.endsWith(`/${v}`)) {
      return { base: id.slice(0, -v.length - 1), variant: v }
    }
  }
  return { base: id, variant: '' }
}
