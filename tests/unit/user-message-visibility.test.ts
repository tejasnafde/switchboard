import { describe, expect, it } from 'vitest'
import { validateUserMessageImages, visibleUserMessageText } from '../../src/shared/provider-events'

describe('visibleUserMessageText', () => {
  it('prefers the explicit display body over the provider wire body', () => {
    expect(visibleUserMessageText('hidden context\n\nactual prompt', 'actual prompt')).toBe('actual prompt')
  })

  it('filters a recognized injected context bundle', () => {
    const bundle = `<recommended_plugins>\n- GitHub\n</recommended_plugins>\n# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nKeep tests green.\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>`
    expect(visibleUserMessageText(bundle)).toBeNull()
  })

  it('does not hide genuine user text that merely mentions a context marker', () => {
    expect(visibleUserMessageText('Please explain <environment_context> in the transcript.')).toBe(
      'Please explain <environment_context> in the transcript.',
    )
  })
})

describe('validateUserMessageImages', () => {
  it('accepts bounded image data URLs', () => {
    const images = [{ url: 'data:image/png;base64,AAA=', mimeType: 'image/png' }]
    expect(validateUserMessageImages(images)).toBe(images)
  })

  it('rejects external URLs and mismatched MIME declarations', () => {
    expect(() => validateUserMessageImages([{ url: 'https://tracker.test/pixel.png' }])).toThrow()
    expect(() => validateUserMessageImages([
      { url: 'data:image/png;base64,AAA=', mimeType: 'image/jpeg' },
    ])).toThrow()
  })

  it('rejects a payload above the replay-safe synchronization budget', () => {
    const payload = 'A'.repeat(3 * 1024 * 1024)
    expect(() => validateUserMessageImages([{ url: `data:image/png;base64,${payload}` }])).toThrow()
  })
})
