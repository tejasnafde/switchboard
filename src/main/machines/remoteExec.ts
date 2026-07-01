/**
 * Run a remote command as another user (sudo) with nvm loaded. Needed when a
 * VM's node lives under the target user's nvm, which a non-interactive shell
 * would not have on PATH. No user -> passthrough (the ssh login user runs it).
 */
const NVM_PREAMBLE = 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '

/**
 * A script with no stdin of its own (probe, install, launch). base64 sidesteps
 * quoting through ssh + sudo; the decoded script runs in the user's bash with
 * nvm sourced first. Its stdout flows back unchanged.
 */
export function asUserScript(remoteUser: string | null | undefined, script: string): string {
  if (!remoteUser) return script
  const payload = Buffer.from(NVM_PREAMBLE + script, 'utf8').toString('base64')
  return `printf %s '${payload}' | base64 -d | sudo -n -H -u ${remoteUser} bash`
}

/**
 * A command that reads its own stdin (e.g. `cat > file` for an upload). Can't
 * pipe a script in (that would consume the stdin we need), so it runs via
 * `bash -c` instead. `command` must be single-quote-safe (ours are).
 */
export function asUserUpload(remoteUser: string | null | undefined, command: string): string {
  if (!remoteUser) return command
  return `sudo -n -H -u ${remoteUser} bash -c '${command}'`
}
