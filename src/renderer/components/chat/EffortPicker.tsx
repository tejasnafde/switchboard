import { effortLabel, type EffortControl } from '@shared/effort'
import { ChipSelect, GaugeIcon } from './FooterChip'

/**
 * "Effort: High" next to the model chip. The same control for every agent:
 * it lists only the levels the selected model takes (see `shared/effort.ts`)
 * and a pick applies from the next turn.
 */
export function EffortPicker({ control, onPick }: { control: EffortControl; onPick: (value: string) => void }) {
  const value = effortLabel(control.value)
  return (
    <ChipSelect
      label="Thinking effort"
      title="Thinking effort. A change applies from the next turn."
      triggerData={{ 'data-effort-picker': '' }}
      icon={<GaugeIcon />}
      full={<><span className="font-normal text-[var(--text-secondary)]">Effort: </span>{value}</>}
      short={value}
      options={effortOptions(control)}
      value={control.value}
      onPick={onPick}
    />
  )
}

export function effortOptions(control: EffortControl) {
  return control.choices.map((choice) => ({
    value: choice.value,
    label: choice.label,
    hint: choice.isDefault ? 'default' : undefined,
  }))
}
