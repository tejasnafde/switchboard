// V8 keeps a string whose characters all fit in Latin-1 at one byte each.
const TWO_BYTE = /[^\u0000-ÿ]/

// Approximate retained strings and object overhead without serializing
// a second copy of image and tool bodies.
export function retainedJsonBytes(value: unknown): number {
  const pending = [value]
  let bytes = 0
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') bytes += TWO_BYTE.test(item) ? item.length * 2 : item.length
    else if (item !== null && item !== undefined) {
      if (typeof item !== 'object') bytes += 8
      else if (Array.isArray(item)) {
        bytes += 32
        for (const child of item) pending.push(child)
      } else {
        bytes += 64
        for (const [key, child] of Object.entries(item)) {
          bytes += key.length * 2
          pending.push(child)
        }
      }
    }
  }
  return bytes
}
