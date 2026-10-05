// Approximate retained UTF-16 strings and object overhead without serializing
// a second copy of image and tool bodies.
export function retainedJsonBytes(value: unknown): number {
  const pending = [value]
  let bytes = 0
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') bytes += item.length * 2
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
