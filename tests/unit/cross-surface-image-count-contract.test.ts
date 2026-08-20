import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

describe('image attachment count is budget-driven on every composer', () => {
  it('does not cap the React Native picker at four', () => {
    const contents = source('apps/mobile/src/components/ImageAttachments.tsx')
    expect(contents).not.toContain('MAX_PER_TURN')
    expect(contents).toContain('selectionLimit: 0')
  })

  it('does not cap the native Android picker at four', () => {
    const contents = source(
      'apps/android/app/src/main/java/app/switchboard/mobile/ui/thread/ThreadScreen.kt',
    )
    expect(contents).not.toContain('(4 - state.attachments.size)')
    expect(contents).not.toContain('state.attachments.size < 4')
  })
})
