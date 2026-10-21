import type { ChatMessage } from '../../../src/shared/types'

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

/** A long chat: transcript lines, their stored copies (same id, other id, turn end), tool rows, markers. */
export function syntheticChat(seed: number, turns: number) {
  const random = rng(seed)
  const disk: ChatMessage[] = []
  const stored: ChatMessage[] = []
  const replies = ['ok', 'Done.', 'Looking now.', 'All tests pass.']
  let at = Date.UTC(2026, 0, 1)
  for (let turn = 0; turn < turns; turn++) {
    const prompt = random() < 0.2 ? 'continue' : `prompt ${turn}`
    disk.push({ id: `u${turn}`, role: 'user', content: prompt, timestamp: at })
    stored.push({ id: `su${turn}`, role: 'user', content: prompt, timestamp: at + Math.floor(random() * 3000) })
    const steps = 1 + Math.floor(random() * 6)
    let t = at
    for (let step = 0; step < steps; step++) {
      t += 1000 + Math.floor(random() * 40_000)
      const call = { id: `t${turn}_${step}`, name: 'Bash', input: `echo ${step}` }
      disk.push({ id: `a${turn}_${step}`, role: 'assistant', content: '', toolCalls: [call], timestamp: t })
      stored.push({
        id: `sa${turn}_${step}`,
        role: 'assistant',
        content: '',
        toolCalls: [{ ...call, output: 'x'.repeat(step * 10) }],
        timestamp: t + 500,
      })
    }
    t += 2000
    const reply = random() < 0.5 ? replies[Math.floor(random() * replies.length)] : `reply ${turn}`
    disk.push({ id: `r${turn}`, role: 'assistant', content: reply, timestamp: t })
    const copy = random()
    // Same id, another id stamped at the turn end, or no stored copy.
    if (copy < 0.4)
      stored.push({ id: `r${turn}`, role: 'assistant', content: reply, timestamp: t + 10, displayBody: 'b' })
    else if (copy < 0.8) stored.push({ id: `sr${turn}`, role: 'assistant', content: reply, timestamp: t + 20_000 })
    if (random() < 0.1)
      stored.push({ id: `m${turn}`, role: 'system', content: '[[sb:instance-rotated]] a → b', timestamp: t + 1 })
    // Stored-only turns: the transcript lost them.
    if (random() < 0.05) {
      stored.push({ id: `lost${turn}`, role: 'user', content: `lost ${turn}`, timestamp: t + 30_000 })
      stored.push({ id: `lostr${turn}`, role: 'assistant', content: 'ok', timestamp: t + 40_000 })
    }
    at = t + 60_000 + Math.floor(random() * 600_000)
  }
  return { disk, stored }
}
