/**
 * Run a remote command as another user (sudo) with nvm loaded. Needed when a
 * VM's node lives under the target user's nvm, which a non-interactive shell
 * would not have on PATH. No user -> the ssh login user runs it directly, but
 * still through the nvm-sourcing wrapper below (that user's own nvm may also
 * be off PATH in a non-interactive shell).
 *
 * `cd "$HOME"` first: sudo -H swaps HOME to the target user's but keeps the
 * ssh login user's cwd, which the target user may not even be able to read.
 * Every script should start from its own home, same as an interactive
 * `sudo su <user>; cd`.
 */
const NVM_PREAMBLE = 'cd "$HOME" 2>/dev/null || true; export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '

/**
 * remoteUser is user-typed and DB-stored, then interpolated unquoted into a
 * `sudo -u <user>` shell fragment - a trust boundary. Reject anything that
 * isn't a plausible unix username before it reaches a command line.
 */
const VALID_USER = /^[a-z_][a-z0-9._-]*$/i

function assertValidRemoteUser(remoteUser: string): void {
  if (!VALID_USER.test(remoteUser)) {
    throw new Error(`invalid remoteUser "${remoteUser}": must match ${VALID_USER}`)
  }
}

/**
 * A script with no stdin of its own (probe, install, launch). base64 sidesteps
 * quoting through ssh + sudo; the decoded script runs in bash with nvm sourced
 * first. Its stdout flows back unchanged. No remoteUser -> same wrapper, minus
 * the sudo prefix, so the login user still gets nvm loaded.
 */
export function asUserScript(remoteUser: string | null | undefined, script: string): string {
  const payload = Buffer.from(NVM_PREAMBLE + script, 'utf8').toString('base64')
  if (!remoteUser) return `printf %s '${payload}' | base64 -d | bash`
  assertValidRemoteUser(remoteUser)
  return `printf %s '${payload}' | base64 -d | sudo -n -H -u ${remoteUser} bash`
}

/**
 * A command that reads its own stdin (e.g. `cat > file` for an upload). Can't
 * pipe a script in (that would consume the stdin we need), so it runs via
 * `bash -c` instead. `command` must be single-quote-safe (ours are).
 */
export function asUserUpload(remoteUser: string | null | undefined, command: string): string {
  if (!remoteUser) return command
  assertValidRemoteUser(remoteUser)
  return `sudo -n -H -u ${remoteUser} bash -c '${command}'`
}
