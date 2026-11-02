// @vitest-environment jsdom
/**
 * Settings > General > Snooze presets: save on blur and on a pick, errors
 * only after a field loses focus, the keyboard on the radio groups, Remove
 * with Undo, the limit of 8, Reset through the confirm dialog, and the menu
 * preview and status line changing only at the save boundary.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSpec, type SnoozePresetsResult } from '../../src/shared/chat-snooze'
import { useSnoozePresetsStore } from '../../src/renderer/stores/snooze-presets-store'
import { SnoozePresetsPanel } from '../../src/renderer/components/settings/SnoozePresetsPanel'
import { ConfirmHost } from '../../src/renderer/components/ui/confirm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Monday 2 November 2026, 14:12. */
const now = () => new Date(2026, 10, 2, 14, 12)

let root: Root
let container: HTMLDivElement
let answers: Array<(result: SnoozePresetsResult) => void>
let setSnoozePresets: ReturnType<typeof vi.fn>

beforeEach(() => {
  answers = []
  setSnoozePresets = vi.fn(
    (_specs: SnoozePresetSpec[]) => new Promise<SnoozePresetsResult>((resolve) => answers.push(resolve)),
  )
  ;(window as unknown as { api: unknown }).api = { app: { setSnoozePresets } }
  useSnoozePresetsStore.setState({ presets: DEFAULT_SNOOZE_PRESETS, loaded: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  await new Promise((resolve) => setTimeout(resolve, 0))
})

function render(presets: readonly SnoozePresetSpec[] = DEFAULT_SNOOZE_PRESETS) {
  useSnoozePresetsStore.setState({ presets, loaded: true })
  act(() =>
    root.render(createElement('div', null, createElement(SnoozePresetsPanel, { now }), createElement(ConfirmHost))),
  )
}

const q = <T extends HTMLElement>(selector: string) => {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`nothing matches ${selector}`)
  return found
}
const byLabel = <T extends HTMLElement>(name: string) => q<T>(`[aria-label="${name}"]`)
const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!found) throw new Error(`no button named ${name}`)
  return found
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-row]')]
const status = () => q('[role="status"]').textContent
const preview = () =>
  [...q('[data-testid="snooze-preview"]').querySelectorAll(':scope > div')].map((item) => item.textContent)

function type(input: HTMLInputElement, value: string) {
  act(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const blur = (input: HTMLElement) => act(() => input.blur())
const key = (target: Element, k: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
async function answer(result?: SnoozePresetsResult) {
  const list = setSnoozePresets.mock.calls.at(-1)![0] as SnoozePresetSpec[]
  await act(async () => answers.shift()!(result ?? { ok: true, presets: list }))
}

describe('the Snooze presets editor', () => {
  it('lists the saved presets with the names the spec gives, and previews the menu soonest first', () => {
    render()
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Later today',
      'Tonight',
      'Tomorrow morning',
      'Next week',
    ])
    expect(byLabel<HTMLInputElement>('Label of preset 2').value).toBe('Tonight')
    expect(byLabel('Kind of Tonight').getAttribute('role')).toBe('radiogroup')
    expect(byLabel<HTMLInputElement>('Time of Tonight').value).toBe('20:00')
    expect(byLabel<HTMLInputElement>('Duration of Later today').value).toBe('3')
    expect(byLabel('Unit of Later today').querySelector('[aria-checked="true"]')?.textContent).toBe('Hours')
    expect(byLabel('Weekday of Next week').querySelector('[aria-checked="true"]')?.getAttribute('aria-label')).toBe(
      'Monday',
    )
    expect(byLabel('Move Later today up').getAttribute('aria-disabled')).toBe('true')
    expect(byLabel('Move Next week down').getAttribute('aria-disabled')).toBe('true')
    expect(status()).toBe('Saved. Your phones use these 4 presets the next time they open Snooze.')
    expect(preview()).toEqual([
      'Snooze until',
      'Later today17:30',
      'Tonight20:00',
      'Tomorrow morningTue 09:00',
      'Next week9 Nov',
      'Until PR #n changes',
      'Custom date and time...',
    ])
    expect(document.body.textContent).toContain('Your phones use these presets in their Snooze sheet.')
    expect(document.body.textContent).toContain('the time moves forward by the skipped amount (02:30 becomes 03:30)')
  })

  it('saves a label when it loses focus, not before, and shows Saving until the backend answers', async () => {
    render()
    const label = byLabel<HTMLInputElement>('Label of preset 2')
    type(label, 'Evening')
    expect(status()).toBe('You have a change that is not saved. It saves when you leave the field.')
    expect(rows()[1].textContent).toContain('Not saved yet. It saves when you leave the field.')
    expect(preview()).toContain('Tonight20:00')
    expect(setSnoozePresets).not.toHaveBeenCalled()
    blur(label)
    expect(setSnoozePresets).toHaveBeenCalledTimes(1)
    expect(setSnoozePresets.mock.calls[0][0][1]).toEqual({
      label: 'Evening',
      kind: 'time',
      dayOffset: 0,
      hour: 20,
      minute: 0,
    })
    expect(status()).toBe('Saving...')
    expect(preview()).toContain('Evening20:00')
    await answer()
    expect(status()).toBe('Saved. Your phones use these 4 presets the next time they open Snooze.')
    expect(useSnoozePresetsStore.getState().presets[1].label).toBe('Evening')
  })

  it('saves an edit still in its field when Settings closes', () => {
    render()
    type(byLabel<HTMLInputElement>('Label of preset 2'), 'Evening')
    act(() => root.unmount())
    root = createRoot(container)
    expect(setSnoozePresets).toHaveBeenCalledTimes(1)
    expect(setSnoozePresets.mock.calls[0][0][1]).toMatchObject({ label: 'Evening' })
  })

  it('shows a field error only after blur, and keeps the saved preset in the menu', () => {
    render()
    const time = byLabel<HTMLInputElement>('Time of Tonight')
    type(time, '24:00')
    expect(time.getAttribute('aria-invalid')).toBeNull()
    expect(document.body.textContent).not.toContain('Enter a time from 00:00 to 23:59')
    blur(time)
    expect(time.getAttribute('aria-invalid')).toBe('true')
    const described = document.getElementById(time.getAttribute('aria-describedby')!)
    expect(described?.textContent).toBe('Enter a time from 00:00 to 23:59, for example 07:30.')
    expect(rows()[1].textContent).toContain('Not saved. The menu keeps the saved "Tonight" until you fix this.')
    expect(status()).toBe('1 of 4 presets are not saved until fixed. The menu uses the saved versions.')
    expect(preview()).toContain('Tonight20:00')
    expect(setSnoozePresets).not.toHaveBeenCalled()
    type(time, '7:5')
    blur(time)
    expect(time.getAttribute('aria-invalid')).toBe('true')
    type(time, '7:30')
    blur(time)
    expect(time.value).toBe('07:30')
    expect(time.getAttribute('aria-invalid')).toBeNull()
    expect(setSnoozePresets.mock.calls[0][0][1]).toMatchObject({ hour: 7, minute: 30 })
  })

  it('checks a label and a duration against the stored limits', () => {
    render()
    const label = byLabel<HTMLInputElement>('Label of preset 1')
    type(label, 'x'.repeat(41))
    blur(label)
    expect(document.body.textContent).toContain('Use 40 characters or fewer (now 41).')
    type(label, '')
    blur(label)
    expect(document.body.textContent).toContain('Enter a label.')
    type(label, 'Soon')
    blur(label)
    const amount = byLabel<HTMLInputElement>('Duration of Soon')
    type(amount, '2.5')
    blur(amount)
    expect(document.body.textContent).toContain('Enter a whole number, for example 3.')
    type(amount, '9000')
    blur(amount)
    expect(document.body.textContent).toContain('Use a duration from 5 minutes to 365 days.')
  })

  it('moves the kind with the arrows, Home and End, keeps focus on the option, and saves each pick', () => {
    render()
    const kind = byLabel('Kind of Tonight')
    const checked = () => kind.querySelector<HTMLElement>('[aria-checked="true"]')!
    expect([...kind.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
    ])
    checked().focus()
    key(checked(), 'ArrowRight')
    expect(checked().textContent).toBe('Weekday and time')
    expect(document.activeElement).toBe(checked())
    expect(byLabel('Weekday of Tonight')).toBeTruthy()
    expect(setSnoozePresets.mock.calls.at(-1)![0][1]).toMatchObject({ kind: 'weekday', weekday: 1, hour: 20 })
    key(checked(), 'End')
    expect(checked().textContent).toBe('Duration')
    expect(document.activeElement).toBe(checked())
    expect(byLabel<HTMLInputElement>('Duration of Tonight').value).toBe('1')
    key(checked(), 'Home')
    expect(checked().textContent).toBe('Time of day')
    const day = byLabel('Day of Tonight')
    const today = day.querySelector<HTMLElement>('[aria-checked="true"]')!
    expect(today.textContent).toBe('Today')
    today.focus()
    key(today, 'ArrowLeft')
    expect(day.querySelector('[aria-checked="true"]')?.textContent).toBe('Tomorrow')
    expect(setSnoozePresets.mock.calls.at(-1)![0][1]).toMatchObject({ kind: 'time', dayOffset: 1 })
  })

  it('removes at once with an inline Undo that puts the row back where it was', () => {
    render()
    act(() => byLabel('Remove Tonight').click())
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual(['Later today', 'Tomorrow morning', 'Next week'])
    expect(document.activeElement).toBe(byLabel('Label of preset 2'))
    expect(document.body.textContent).toContain('Removed "Tonight".')
    expect(setSnoozePresets.mock.calls.at(-1)![0]).toHaveLength(3)
    act(() => button('Undo').click())
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Later today',
      'Tonight',
      'Tomorrow morning',
      'Next week',
    ])
    expect(document.activeElement).toBe(byLabel('Label of preset 2'))
    expect(document.body.textContent).not.toContain('Removed "Tonight".')
    expect(setSnoozePresets.mock.calls.at(-1)![0]).toHaveLength(4)
  })

  it('moves focus to Add when the last row is removed, and refuses to remove the only one', () => {
    render([DEFAULT_SNOOZE_PRESETS[0], DEFAULT_SNOOZE_PRESETS[1]])
    act(() => byLabel('Remove Tonight').click())
    expect(document.activeElement).toBe(button('Add preset'))
    const only = byLabel('Remove Later today')
    expect(only.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(only.getAttribute('aria-describedby')!)?.textContent).toContain(
      'The menu needs at least one preset',
    )
    act(() => only.click())
    expect(rows()).toHaveLength(1)
  })

  it('moves a row and keeps focus on the button that moved it', () => {
    render()
    act(() => byLabel('Move Tonight up').click())
    expect(rows().map((r) => r.getAttribute('aria-label'))[0]).toBe('Tonight')
    expect(document.activeElement).toBe(byLabel('Move Tonight up'))
    expect(byLabel('Move Tonight up').getAttribute('aria-disabled')).toBe('true')
  })

  it('adds an empty Time of day row with focus on its label, up to 8, then says why', () => {
    render()
    for (let i = 0; i < 4; i++) act(() => button('Add preset').click())
    expect(rows()).toHaveLength(8)
    expect(document.activeElement).toBe(byLabel('Label of preset 8'))
    expect(rows()[7].textContent).toContain('Not saved until it has a label.')
    expect(byLabel('Day of preset 8').querySelector('[aria-checked="true"]')?.textContent).toBe('Tomorrow')
    expect(byLabel<HTMLInputElement>('Time of preset 8').value).toBe('09:00')
    const add = button('Add preset')
    expect(add.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(add.getAttribute('aria-describedby')!)?.textContent).toBe(
      'You have 8 presets, the most the menu holds. Remove one to add another.',
    )
    act(() => add.click())
    expect(rows()).toHaveLength(8)
    // Rows with no label yet are not sent.
    expect(setSnoozePresets).not.toHaveBeenCalled()
    const label = byLabel<HTMLInputElement>('Label of preset 8')
    type(label, 'Lunch')
    blur(label)
    expect(setSnoozePresets.mock.calls.at(-1)![0]).toHaveLength(5)
  })

  it('resets to the defaults only after the confirm dialog', async () => {
    render([{ label: 'Lunch', kind: 'time', dayOffset: 0, hour: 13, minute: 0 }])
    await act(async () => button('Reset to defaults').click())
    const dialog = q('[role="alertdialog"]')
    expect(dialog.textContent).toContain('Reset snooze presets?')
    expect(dialog.textContent).toContain(
      'Your 1 preset changes to the 4 defaults: Later today, Tonight, Tomorrow morning and Next week. Your phones get the defaults too. You cannot undo this.',
    )
    await act(async () => button('Cancel').click())
    expect(rows()).toHaveLength(1)
    expect(setSnoozePresets).not.toHaveBeenCalled()
    await act(async () => button('Reset to defaults').click())
    await act(async () => button('Reset presets').click())
    expect(rows()).toHaveLength(4)
    expect(setSnoozePresets.mock.calls.at(-1)![0]).toEqual(DEFAULT_SNOOZE_PRESETS)
  })

  it('says why a preset is not in the menu now, and names the higher one that wins its minute', () => {
    render([
      DEFAULT_SNOOZE_PRESETS[1],
      { label: 'Evening', kind: 'time', dayOffset: 0, hour: 20, minute: 0 },
      { label: 'Lunch', kind: 'time', dayOffset: 0, hour: 13, minute: 0 },
    ])
    expect(rows()[1].textContent).toContain(
      'Hidden now: it wakes in the same minute as "Tonight", which is higher in the list. Move this one up to show it instead.',
    )
    expect(rows()[2].textContent).toContain(
      'Hidden now: today at 13:00 is less than an hour away or has passed. It shows again tomorrow.',
    )
    expect(document.body.textContent).toContain('Not in the menu now: Evening')
    expect(preview()).toEqual(['Snooze until', 'Tonight20:00', 'Until PR #n changes', 'Custom date and time...'])
  })

  it('takes a list another client saved, and says when the backend refuses one', async () => {
    render()
    act(() =>
      useSnoozePresetsStore.getState().take([{ label: 'Lunch', kind: 'time', dayOffset: 1, hour: 13, minute: 0 }]),
    )
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual(['Lunch'])
    const label = byLabel<HTMLInputElement>('Label of preset 1')
    type(label, 'Late lunch')
    blur(label)
    await answer({ ok: false, reason: 'invalid_preset', index: 0 })
    expect(status()).toBe('Not saved: Preset 1 is not valid. Change a preset to try again.')
  })
})

describe('the editor against a failing or slow backend', () => {
  it('waits for the first read, so an edit cannot start from the defaults', () => {
    useSnoozePresetsStore.setState({ presets: DEFAULT_SNOOZE_PRESETS, loaded: false })
    act(() => root.render(createElement(SnoozePresetsPanel, { now })))
    expect(rows()).toHaveLength(0)
    expect(status()).toBe('Reading the saved presets...')
    const lunch: SnoozePresetSpec = { label: 'Lunch', kind: 'time', dayOffset: 1, hour: 13, minute: 0 }
    act(() => useSnoozePresetsStore.getState().take([lunch]))
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual(['Lunch'])
  })

  it('reports a failed save while another row is not valid, and sends it again when Settings closes', async () => {
    render()
    const first = byLabel<HTMLInputElement>('Label of preset 1')
    type(first, '')
    blur(first)
    const second = byLabel<HTMLInputElement>('Label of preset 2')
    type(second, 'Evening')
    blur(second)
    await answer({ ok: false, reason: 'invalid_preset', index: 1 })
    expect(status()).toBe(
      'Not saved: Preset 2 is not valid. Change a preset to try again. 1 of 4 presets are not saved until fixed.',
    )
    const sent = setSnoozePresets.mock.calls.length
    act(() => root.unmount())
    root = createRoot(container)
    expect(setSnoozePresets).toHaveBeenCalledTimes(sent + 1)
    expect(setSnoozePresets.mock.calls.at(-1)![0][1]).toMatchObject({ label: 'Evening' })
  })

  it('keeps Remove on the one saved preset while the other row has no label yet', () => {
    render([DEFAULT_SNOOZE_PRESETS[1]])
    act(() => button('Add preset').click())
    const remove = byLabel('Remove Tonight')
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    act(() => remove.click())
    expect(rows()).toHaveLength(2)
    expect(setSnoozePresets).not.toHaveBeenCalled()
  })
})

describe('the menus follow the backend', () => {
  it('reads the presets once, then takes each broadcast, and a broadcast beats a read still out', async () => {
    useSnoozePresetsStore.setState({ presets: DEFAULT_SNOOZE_PRESETS, loaded: false })
    let push: (event: { presets: unknown }) => void = () => {}
    let read: (presets: unknown) => void = () => {}
    const off = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      app: {
        getSnoozePresets: vi.fn(() => new Promise((resolve) => (read = resolve))),
        onSnoozePresetsChanged: (cb: typeof push) => {
          push = cb
          return off
        },
      },
    }
    const { startSnoozePresetsSync } = await import('../../src/renderer/stores/snooze-presets-store')
    const stop = startSnoozePresetsSync()
    expect(startSnoozePresetsSync()).toBe(stop)
    const lunch = { label: 'Lunch', kind: 'time', dayOffset: 0, hour: 13, minute: 0 }
    push({ presets: [lunch] })
    await act(async () => read([{ label: 'Older', kind: 'duration', minutes: 30 }]))
    expect(useSnoozePresetsStore.getState()).toMatchObject({ presets: [lunch], loaded: true })
    // A list the parser cannot use reads as the defaults, as on the backend.
    push({ presets: 'nonsense' })
    expect(useSnoozePresetsStore.getState().presets).toEqual(DEFAULT_SNOOZE_PRESETS)
    stop()
    expect(off).toHaveBeenCalled()
  })

  it('reads again after a failed read', async () => {
    vi.useFakeTimers()
    try {
      useSnoozePresetsStore.setState({ presets: DEFAULT_SNOOZE_PRESETS, loaded: false })
      const lunch = { label: 'Lunch', kind: 'time', dayOffset: 0, hour: 13, minute: 0 }
      const getSnoozePresets = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValueOnce([lunch])
      ;(window as unknown as { api: unknown }).api = {
        app: { getSnoozePresets, onSnoozePresetsChanged: () => () => {} },
      }
      const { startSnoozePresetsSync } = await import('../../src/renderer/stores/snooze-presets-store')
      const stop = startSnoozePresetsSync()
      await vi.advanceTimersByTimeAsync(0)
      expect(useSnoozePresetsStore.getState().loaded).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(getSnoozePresets).toHaveBeenCalledTimes(2)
      expect(useSnoozePresetsStore.getState()).toMatchObject({ presets: [lunch], loaded: true })
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
