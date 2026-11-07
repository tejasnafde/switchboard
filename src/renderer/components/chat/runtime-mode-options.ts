import { RUNTIME_MODE_LABELS, type RuntimeMode } from '@shared/provider-events'

export interface RuntimeModeOption {
  value: RuntimeMode
  label: string
  short: string
  detail: string
}

// Short labels: the footer chip shows the label, and `short` once the footer
// is narrow (ui/toolbar-steps.ts). The detail is a tooltip. The long label
// comes from the shared map, so the chip and the backend say one word.
const SHORT: ReadonlyArray<Omit<RuntimeModeOption, 'label'>> = [
  { value: 'sandbox', short: 'Supervised', detail: 'Ask before commands and file changes' },
  { value: 'accept-edits', short: 'Edits', detail: 'Ask before other actions' },
  { value: 'auto', short: 'Auto', detail: 'The agent approves routine actions. OpenCode still asks.' },
  { value: 'full-access', short: 'Full', detail: 'No prompts' },
  { value: 'plan', short: 'Plan', detail: 'No execution' },
]

export const RUNTIME_MODE_OPTIONS: ReadonlyArray<RuntimeModeOption> = SHORT.map((option) => ({
  ...option,
  label: RUNTIME_MODE_LABELS[option.value],
}))
