/**
 * Vocabulary prompt builder + base64 sizing for the backend STT layer
 * (src/shared/stt.ts). Pure functions, shared by the phone and both hosts.
 */
import { describe, it, expect } from 'vitest'
import { base64DecodedBytes, buildSttPrompt, STT_PROMPT_CAP_CHARS } from '../../src/shared/stt'

describe('buildSttPrompt', () => {
  it('splits paths into segments and joins them after the preamble', () => {
    const prompt = buildSttPrompt(['src/main/stt/whisper-binary.ts'])
    expect(prompt.startsWith('Software project dictation. Vocabulary: ')).toBe(true)
    expect(prompt).toContain('src')
    expect(prompt).toContain('main')
    expect(prompt).toContain('whisper-binary.ts')
  })

  it('dedupes case-insensitively while keeping the first spelling', () => {
    const prompt = buildSttPrompt(['src/Foo.ts', 'src/foo.ts', 'lib/src/other.ts'])
    expect(prompt.match(/Foo\.ts/g)).toHaveLength(1)
    expect(prompt).not.toContain('foo.ts,')
    // 'src' appears once even though three paths carry it.
    expect(prompt.match(/\bsrc\b/g)).toHaveLength(1)
  })

  it('drops segments shorter than three characters', () => {
    const prompt = buildSttPrompt(['ui/ab/db.ts'])
    expect(prompt).toContain('db.ts')
    expect(prompt).not.toMatch(/\bui\b/)
    expect(prompt).not.toMatch(/\bab\b/)
  })

  it('puts recent identifiers ahead of file segments', () => {
    const prompt = buildSttPrompt(['zeta/file.ts'], ['resolveTranscriptSwap'])
    expect(prompt.indexOf('resolveTranscriptSwap')).toBeLessThan(prompt.indexOf('zeta'))
  })

  it('respects the character cap', () => {
    const names = Array.from({ length: 500 }, (_, i) => `directory-${i}/file-name-${i}.tsx`)
    const prompt = buildSttPrompt(names)
    expect(prompt.length).toBeLessThanOrEqual(STT_PROMPT_CAP_CHARS)
    expect(prompt.length).toBeGreaterThan(STT_PROMPT_CAP_CHARS / 2)
  })

  it('returns empty for no usable terms', () => {
    expect(buildSttPrompt([])).toBe('')
    expect(buildSttPrompt(['a/b'])).toBe('')
    expect(buildSttPrompt([], [])).toBe('')
  })

  it('honours a custom cap', () => {
    // Cap smaller than prefix + first term: nothing fits, so nothing is sent.
    expect(buildSttPrompt(['averylongfilename.ts'], [], 10)).toBe('')
  })
})

describe('base64DecodedBytes', () => {
  it('matches the real decoded length', () => {
    for (const size of [0, 1, 2, 3, 4, 5, 1000]) {
      const b64 = Buffer.alloc(size, 7).toString('base64')
      expect(base64DecodedBytes(b64)).toBe(size)
    }
  })
})
