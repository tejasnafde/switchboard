import type { RuntimeMode } from '@shared/provider-events'

// Short labels: the footer chip shows the label, and `short` once the footer
// is narrow (ui/toolbar-steps.ts). The detail is a tooltip.
export const RUNTIME_MODE_OPTIONS: ReadonlyArray<{ value: RuntimeMode; label: string; short: string; detail: string }> =
  [
    { value: 'sandbox', label: 'Supervised', short: 'Supervised', detail: 'Ask before commands and file changes' },
    { value: 'accept-edits', label: 'Auto-accept edits', short: 'Edits', detail: 'Ask before other actions' },
    { value: 'auto', label: 'Auto', short: 'Auto', detail: 'The agent approves routine actions. OpenCode still asks.' },
    { value: 'full-access', label: 'Full access', short: 'Full', detail: 'No prompts' },
    { value: 'plan', label: 'Plan', short: 'Plan', detail: 'No execution' },
  ]
