/**
 * App chrome uses Combobox or ChipSelect from components/ui, never a native
 * <select>. ESLint enforces it at commit time (eslint.config.mjs); this keeps
 * the rule wired and checks the whole renderer in CI, where lint does not run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const renderer = join(root, 'src/renderer')
const ui = join(renderer, 'components/ui')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return name.endsWith('.tsx') ? [path] : []
  })
}

describe('no native <select> outside components/ui', () => {
  it('the ESLint rule flags one in app chrome and allows one in components/ui', async () => {
    const eslint = new ESLint({ cwd: root })
    const code = 'export const A = () => <select><option>a</option></select>\n'
    const lint = async (file: string) =>
      (await eslint.lintText(code, { filePath: join(root, file) }))[0].messages.map((m) => m.message)

    expect(await lint('src/renderer/components/kanban/Example.tsx')).toEqual([
      expect.stringContaining('Native <select> outside components/ui'),
    ])
    expect(await lint('src/renderer/components/ui/example.tsx')).toEqual([])
  })

  it('the renderer has none', () => {
    const offenders = walk(renderer)
      .filter((file) => !file.startsWith(ui))
      .filter((file) => /<select[\s>]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
    expect(offenders).toEqual([])
  })
})
