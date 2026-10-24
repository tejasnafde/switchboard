/**
 * FNV-1a 64 over the UTF-16 code units of `input`, low byte first, as 16 hex
 * digits. Not a secret: it fingerprints what a phone showed, so the backend can
 * check it posts the same thing. Both phones port it without a crypto library.
 */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i)
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit & 0xff)) * FNV_PRIME)
    hash = BigInt.asUintN(64, (hash ^ BigInt(unit >>> 8)) * FNV_PRIME)
  }
  return hash.toString(16).padStart(16, '0')
}

const FNV_OFFSET = BigInt('0xcbf29ce484222325')
const FNV_PRIME = BigInt('0x100000001b3')
