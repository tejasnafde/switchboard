import { RUNTIME_MODE_LABELS, type RuntimeMode } from '@shared/provider-events'

// The footer chip shows the label, and `short` once the footer is narrow
// (ui/toolbar-steps.ts). The detail is a tooltip. The label comes from the
// shared map, so the chip and the backend's refusals say one word.
const option = (value: RuntimeMode, short: string, detail: string) => ({
  value,
  label: RUNTIME_MODE_LABELS[value],
  short,
  detail,
})

export const RUNTIME_MODE_OPTIONS = [
  option('sandbox', 'Supervised', 'Ask before commands and file changes'),
  option('accept-edits', 'Edits', 'Ask before other actions'),
  option('auto', 'Auto', 'The agent approves routine actions. OpenCode still asks.'),
  option('full-access', 'Full', 'No prompts'),
  option('plan', 'Plan', 'No execution'),
]
