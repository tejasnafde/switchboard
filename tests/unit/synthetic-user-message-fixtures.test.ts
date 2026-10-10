/**
 * Shared vectors for the user-role split. The native Android test
 * (SyntheticUserMessageFixturesTest.kt) reads the same file, so the TS and
 * Kotlin rule sets cannot drift apart. `expected: null` means a real message.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import {
  splitSyntheticUserText,
  syntheticPartDetail,
  syntheticPartLabel,
  syntheticPartTone,
} from '../../src/shared/synthetic-message'

interface Case {
  id: string
  text: string
  expected: { rows: Array<{ label: string; tone: string; detail?: string }>; userText: string } | null
}

const here = dirname(fileURLToPath(import.meta.url))
const cases: Case[] = JSON.parse(readFileSync(resolve(here, '../fixtures/synthetic-user-message-cases.json'), 'utf8'))

describe('synthetic-user-message-cases fixture', () => {
  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const split = splitSyntheticUserText(c.text)
    expect(
      split && {
        rows: split.parts.map((part) => {
          const detail = syntheticPartDetail(part)
          return {
            label: syntheticPartLabel(part),
            tone: syntheticPartTone(part),
            ...(detail === undefined ? {} : { detail }),
          }
        }),
        userText: split.userText,
      },
    ).toEqual(c.expected)
  })
})
