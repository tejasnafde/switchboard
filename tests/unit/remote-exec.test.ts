/**
 * Wrapping remote commands to run as another user (sudo) with nvm loaded, so a
 * VM whose node lives under the target user's nvm is reachable non-interactively.
 * No remoteUser -> the login user runs it, still through the same nvm wrapper.
 */
import { describe, it, expect } from 'vitest'
import { asUserScript, asUserUpload } from '../../src/main/machines/remoteExec'

const b64 = (cmd: string) => {
  const m = cmd.match(/printf %s '([A-Za-z0-9+/=]+)'/)
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null
}

describe('asUserScript', () => {
  it('wraps through base64 + bash (no sudo) when no user is set', () => {
    const out = asUserScript(null, 'node -v')
    expect(out).toBe(asUserScript(undefined, 'node -v'))
    expect(out).not.toContain('sudo')
    expect(out).toMatch(/\| base64 -d \| bash$/)
    const decoded = b64(out)
    expect(decoded).toContain('NVM_DIR')
    expect(decoded?.endsWith('node -v')).toBe(true)
  })

  it('runs the script as the user via non-interactive sudo bash', () => {
    const out = asUserScript('ubuntu', 'node -v')
    expect(out).toContain('sudo -n -H -u ubuntu bash')
    expect(out).toMatch(/\| base64 -d \|/)
  })

  it('loads nvm before the script (base64 payload)', () => {
    const decoded = b64(asUserScript('ubuntu', 'node -v'))
    expect(decoded).toContain('NVM_DIR')
    expect(decoded).toContain('nvm.sh')
    expect(decoded?.endsWith('node -v')).toBe(true)
  })

  it('base64 avoids quoting hazards in the script', () => {
    const out = asUserScript('ubuntu', `node -e "console.log('hi')"`)
    // The raw quotes never appear unescaped in the wrapper - they are inside base64.
    expect(out).not.toContain(`console.log('hi')`)
    expect(b64(out)).toContain(`console.log('hi')`)
  })

  it('rejects a remoteUser that is not a plausible unix username', () => {
    expect(() => asUserScript('ubuntu; rm -rf ~', 'node -v')).toThrow(/invalid remoteUser/)
    expect(() => asUserScript('ubuntu ', 'node -v')).toThrow(/invalid remoteUser/)
    expect(() => asUserScript('-x', 'node -v')).toThrow(/invalid remoteUser/)
  })

  it('accepts common username shapes', () => {
    expect(() => asUserScript('ubuntu', 'node -v')).not.toThrow()
    expect(() => asUserScript('deploy-user_1.x', 'node -v')).not.toThrow()
  })
})

describe('asUserUpload', () => {
  it('passes through when no user is set', () => {
    expect(asUserUpload(null, 'cat > f')).toBe('cat > f')
  })

  it('runs a stdin-reading command as the user without consuming stdin for the script', () => {
    // Must NOT pipe (that would eat the uploaded content); uses bash -c instead.
    const out = asUserUpload('ubuntu', 'cat > "$HOME/x"')
    expect(out).toBe(`sudo -n -H -u ubuntu bash -c 'cat > "$HOME/x"'`)
    expect(out).not.toContain('base64')
  })

  it('rejects a remoteUser that is not a plausible unix username', () => {
    expect(() => asUserUpload('ubuntu; rm -rf ~', 'cat > f')).toThrow(/invalid remoteUser/)
    expect(() => asUserUpload('ubuntu\n', 'cat > f')).toThrow(/invalid remoteUser/)
  })
})
