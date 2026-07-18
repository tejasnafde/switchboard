import { describe, it, expect } from 'vitest'
import { notebookWriteRedirect } from '../../src/main/provider/policy'

/**
 * The .ipynb guardrail: edit tools targeting notebook JSON are denied with a
 * message that names the .py mirror, teaching the agent the correct edit
 * surface. Reads stay allowed - agents may need outputs/errors for context.
 */

const REPO = '/Users/dev/project'

describe('notebookWriteRedirect', () => {
  it('redirects Claude Write/Edit/NotebookEdit targeting an .ipynb to its mirror', () => {
    for (const [tool, input] of [
      ['Write', { file_path: `${REPO}/analysis.ipynb`, content: '{}' }],
      ['Edit', { file_path: `${REPO}/analysis.ipynb`, old_string: 'a', new_string: 'b' }],
      ['NotebookEdit', { notebook_path: `${REPO}/analysis.ipynb`, new_source: 'x' }],
    ] as const) {
      const res = notebookWriteRedirect(tool, input, REPO)
      expect(res, tool).not.toBeNull()
      expect(res?.notebookRelPath).toBe('analysis.ipynb')
      expect(res?.mirrorRelPath).toBe('.switchboard/notebooks/analysis.py')
      expect(res?.message).toContain('.switchboard/notebooks/analysis.py')
    }
  })

  it('redirects Codex apply_patch changes touching an .ipynb', () => {
    const res = notebookWriteRedirect('apply_patch', { changes: [{ path: `${REPO}/reports/q3.ipynb` }] }, REPO)
    expect(res?.mirrorRelPath).toBe('.switchboard/notebooks/reports/q3.py')
  })

  it('leaves non-notebook writes alone', () => {
    expect(notebookWriteRedirect('Write', { file_path: `${REPO}/src/app.ts` }, REPO)).toBeNull()
    expect(notebookWriteRedirect('Write', { file_path: `${REPO}/.switchboard/notebooks/analysis.py` }, REPO)).toBeNull()
  })

  it('leaves notebook READS alone (Read / NotebookRead)', () => {
    expect(notebookWriteRedirect('Read', { file_path: `${REPO}/analysis.ipynb` }, REPO)).toBeNull()
    expect(notebookWriteRedirect('NotebookRead', { notebook_path: `${REPO}/analysis.ipynb` }, REPO)).toBeNull()
  })

  it('still denies an .ipynb write outside the repo root, with generic mirror guidance', () => {
    const res = notebookWriteRedirect('Write', { file_path: '/elsewhere/other.ipynb' }, REPO)
    expect(res).not.toBeNull()
    expect(res?.notebookRelPath).toBeNull()
    expect(res?.mirrorRelPath).toBeNull()
    expect(res?.message).toMatch(/mirror/i)
  })

  it('handles relative tool-input paths against the repo root', () => {
    const res = notebookWriteRedirect('Write', { file_path: 'analysis.ipynb' }, REPO)
    expect(res?.mirrorRelPath).toBe('.switchboard/notebooks/analysis.py')
  })
})

describe('path traversal hardening', () => {
  it('treats ../ escapes as outside the repo (no mirror path computed)', () => {
    for (const p of [
      `${REPO}/../../../tmp/evil.ipynb`,
      `${REPO}/sub/../../outside.ipynb`,
      '../sibling/evil.ipynb',
      '../../../../etc/evil.ipynb',
    ]) {
      const res = notebookWriteRedirect('Write', { file_path: p }, REPO)
      expect(res, p).not.toBeNull()
      expect(res?.notebookRelPath, p).toBeNull()
      expect(res?.mirrorRelPath, p).toBeNull()
    }
  })

  it('normalizes benign ./ and redundant segments to the correct mirror path', () => {
    const res = notebookWriteRedirect('Write', { file_path: `${REPO}/./reports//q3.ipynb` }, REPO)
    expect(res?.notebookRelPath).toBe('reports/q3.ipynb')
    expect(res?.mirrorRelPath).toBe('.switchboard/notebooks/reports/q3.py')
  })

  it('allows in-repo ..-segments that stay inside the repo', () => {
    const res = notebookWriteRedirect('Write', { file_path: `${REPO}/sub/../analysis.ipynb` }, REPO)
    expect(res?.notebookRelPath).toBe('analysis.ipynb')
  })
})
