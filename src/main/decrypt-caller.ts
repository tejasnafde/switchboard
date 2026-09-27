/**
 * Where a safeStorage decrypt came from, for a debug line at each call site.
 * On an unsigned macOS build a decrypt can be a keychain password prompt, so
 * the log has to say who asked, to count prompts against a report.
 */
export function decryptCaller(): string {
  // Frames 0-2 are "Error", this function and the decrypting function itself.
  return (new Error().stack ?? '').split('\n').slice(3, 7).map((line) => line.trim()).join(' < ')
}
