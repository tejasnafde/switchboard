import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_MARKS, type AgentMarkData } from '@shared/agent-marks'

/**
 * Android draws the same marks as the desktop and the Expo app, as vector
 * drawables. They are generated from `@shared/agent-marks`, never edited by
 * hand: run this test with `SB_UPDATE_FIXTURES=1` after a mark changes.
 */
const DRAWABLE_DIR = join(__dirname, '../../apps/android/app/src/main/res/drawable')

function drawableName(agent: string): string {
  return `agent_mark_${agent.replaceAll('-', '_')}`
}

function drawableXml(mark: AgentMarkData): string {
  const [minX, minY, width, height] = mark.viewBox.split(' ').map(Number)
  const paths = (pad: string) =>
    mark.paths
      .map((d) =>
        [
          `${pad}<path`,
          `${pad}    android:fillColor="#FFFFFFFF"`,
          ...(mark.fillRule === 'evenodd' ? [`${pad}    android:fillType="evenOdd"`] : []),
          `${pad}    android:pathData="${d}" />`,
        ].join('\n'),
      )
      .join('\n')
  // A view box with an origin becomes a translated group: a vector drawable has
  // a viewport size but no origin.
  const body =
    minX === 0 && minY === 0
      ? paths('    ')
      : [
          '    <group',
          `        android:translateX="${-minX}"`,
          `        android:translateY="${-minY}">`,
          paths('        '),
          '    </group>',
        ].join('\n')
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generated from src/shared/agent-marks.ts by tests/unit/android-agent-mark-drawables.test.ts. Do not edit. -->',
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '    android:width="24dp"',
    '    android:height="24dp"',
    `    android:viewportWidth="${width}"`,
    `    android:viewportHeight="${height}">`,
    body,
    '</vector>',
    '',
  ].join('\n')
}

describe('android agent mark drawables', () => {
  it('match the shared path data', () => {
    for (const [agent, mark] of Object.entries(AGENT_MARKS)) {
      const path = join(DRAWABLE_DIR, `${drawableName(agent)}.xml`)
      const expected = drawableXml(mark)
      if (process.env.SB_UPDATE_FIXTURES) {
        writeFileSync(path, expected)
        continue
      }
      expect(readFileSync(path, 'utf8'), agent).toBe(expected)
    }
  })

  it('names a drawable with characters Android allows', () => {
    for (const agent of Object.keys(AGENT_MARKS)) {
      expect(drawableName(agent), agent).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})
