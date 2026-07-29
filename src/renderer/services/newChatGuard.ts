/**
 * Key for the in-flight New Chat guard in App.tsx. Worktree-mode chats run
 * a real `git worktree add` (seconds locally, longer over SSH), so a second
 * click mid-flight would create a duplicate worktree + conversation.
 */
export function newChatKey(projectPath: string, machineId: string = 'local'): string {
  // NUL cannot appear in either field, so keys never collide across the
  // machine/path boundary (same trick as MachineLayer's collapse keys).
  return `${machineId}\0${projectPath}`
}
