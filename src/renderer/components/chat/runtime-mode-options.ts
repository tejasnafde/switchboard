import type { RuntimeMode } from '@shared/provider-events'

// Short labels only: a native select is as wide as its longest option, and
// the long text pushed the footer onto a second row. The detail is a tooltip.
export const RUNTIME_MODE_OPTIONS: ReadonlyArray<{ value: RuntimeMode; label: string; detail: string }> = [
  { value: 'sandbox', label: 'Supervised', detail: 'Ask before commands and file changes' },
  { value: 'accept-edits', label: 'Auto-accept edits', detail: 'Ask before other actions' },
  { value: 'auto', label: 'Auto', detail: 'The agent approves routine actions. OpenCode still asks.' },
  { value: 'full-access', label: 'Full access', detail: 'No prompts' },
  { value: 'plan', label: 'Plan', detail: 'No execution' },
]
