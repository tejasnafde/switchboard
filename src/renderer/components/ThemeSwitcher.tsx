import { useThemeStore, type ThemeName } from '../stores/theme-store'

const THEMES: { value: ThemeName; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'translucent', label: 'Translucent' },
]

export function ThemeSwitcher() {
  const { theme, setTheme } = useThemeStore()

  return (
    <select
      value={theme}
      onChange={(e) => setTheme(e.target.value as ThemeName)}
      style={{
        background: 'transparent',
        color: 'var(--text-muted)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        padding: '2px 6px',
        fontSize: '11px',
        cursor: 'pointer',
        outline: 'none',
        WebkitAppRegion: 'no-drag',
      }}
    >
      {THEMES.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </select>
  )
}
