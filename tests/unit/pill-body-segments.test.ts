import { describe, expect, it } from 'vitest'
import { pillBodySegments } from '../../src/shared/pill-body-text'

const meta = { a: { label: 'src/app.ts', kind: 'file' as const }, b: { label: 'npm test', kind: 'terminal' as const } }

describe('pillBodySegments', () => {
  it('splits a body into text runs and known chips', () => {
    expect(pillBodySegments('Fix [[pill:a]] and [[pill:b]]', meta)).toEqual([
      { kind: 'text', text: 'Fix ' },
      { kind: 'pill', id: 'a', label: 'src/app.ts' },
      { kind: 'text', text: ' and ' },
      { kind: 'pill', id: 'b', label: 'npm test' },
    ])
  })

  it('drops an unknown token and joins the text around it', () => {
    expect(pillBodySegments('a [[pill:gone]] b', meta)).toEqual([{ kind: 'text', text: 'a  b' }])
    expect(pillBodySegments('[[pill:toString]]', {})).toEqual([])
  })

  it('returns nothing for an empty body and leaves a body without tokens whole', () => {
    expect(pillBodySegments('', meta)).toEqual([])
    expect(pillBodySegments('plain [x]', undefined)).toEqual([{ kind: 'text', text: 'plain [x]' }])
  })
})
