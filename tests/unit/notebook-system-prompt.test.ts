import { describe, it, expect } from 'vitest'
import { buildNotebookSystemPrompt } from '../../src/main/notebooks/system-prompt'

describe('buildNotebookSystemPrompt', () => {
  const pairs = [
    { notebookRelPath: 'analysis.ipynb', mirrorRelPath: '.switchboard/notebooks/analysis.py' },
    { notebookRelPath: 'reports/q3.ipynb', mirrorRelPath: '.switchboard/notebooks/reports/q3.py' },
  ]

  it('returns an empty string when the project has no notebooks', () => {
    expect(buildNotebookSystemPrompt([])).toBe('')
  })

  it('teaches the mirror rule and the marker format', () => {
    const prompt = buildNotebookSystemPrompt(pairs)
    expect(prompt).toMatch(/never edit .*\.ipynb/i)
    expect(prompt).toContain('# %% [cellbridge_id=')
    expect(prompt).toMatch(/preserve/i)
    expect(prompt).toMatch(/markdown/i)
  })

  it('lists every notebook with its mirror path', () => {
    const prompt = buildNotebookSystemPrompt(pairs)
    expect(prompt).toContain('analysis.ipynb -> .switchboard/notebooks/analysis.py')
    expect(prompt).toContain('reports/q3.ipynb -> .switchboard/notebooks/reports/q3.py')
  })

  it('explains that new notebooks are authored by writing a new mirror file', () => {
    const prompt = buildNotebookSystemPrompt(pairs)
    expect(prompt).toMatch(/new notebook/i)
    expect(prompt).toContain('.switchboard/notebooks/')
  })
})
