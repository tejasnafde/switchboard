/**
 * The iOS store build links precompiled Expo frameworks. Each one is built
 * against the expo-modules-core of its own SDK patch release, so a lockfile
 * that mixes patch levels links a framework that imports symbols the bundled
 * core does not export. dyld then stops the app before any JS runs: builds 3
 * to 5 (expo-image-manipulator 57.0.20 on expo-modules-core 57.0.8) crashed on
 * launch and App Review rejected 0.4.1 for it. EAS only warns on this.
 */
const lock = require('../../package-lock.json') as { packages: Record<string, { version?: string }> }
const pkg = require('../../package.json') as { dependencies: Record<string, string> }
const bundled = require('expo/bundledNativeModules.json') as Record<string, string>

/** The three range forms bundledNativeModules.json uses: `~x.y.z`, `^x.y.z`, `x.y.z`. */
function satisfies(version: string, range: string): boolean {
  const op = range[0] === '~' || range[0] === '^' ? range[0] : ''
  const want = range.slice(op.length).split('.').map(Number)
  const have = version.split('.').map(Number)
  if (op === '') return want.every((n, i) => have[i] === n)
  const fixed = op === '~' ? 2 : 1
  for (let i = 0; i < fixed; i++) if (have[i] !== want[i]) return false
  for (let i = fixed; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i]
  return true
}

describe('Expo native module versions', () => {
  it('reads the range forms the SDK uses', () => {
    expect(satisfies('57.0.24', '~57.0.24')).toBe(true)
    expect(satisfies('57.0.8', '~57.0.24')).toBe(false)
    expect(satisfies('57.1.0', '~57.0.24')).toBe(false)
    expect(satisfies('5.8.0', '^5.7.0')).toBe(true)
    expect(satisfies('0.86.2', '0.86.3')).toBe(false)
  })

  it('locks every SDK-managed package at the version the installed expo expects', () => {
    const drift = Object.entries(bundled).flatMap(([name, range]) => {
      const locked = lock.packages[`node_modules/${name}`]?.version
      if (!locked || satisfies(locked, range)) return []
      return [`${name}@${locked} (expected ${range})`]
    })
    expect(drift).toEqual([])
  })

  it('takes expo-modules-core through expo, not as a direct dependency', () => {
    expect(pkg.dependencies['expo-modules-core']).toBeUndefined()
  })
})
