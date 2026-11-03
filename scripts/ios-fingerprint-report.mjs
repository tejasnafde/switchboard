import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_\[\]()!|~]/g, (char) => `&#${char.charCodeAt(0)};`)
    .replace(/[\r\n]/g, ' ')

export function fingerprintMetadata(fingerprint) {
  return {
    hash: fingerprint.hash,
    sources: fingerprint.sources.map(({ type, id, filePath, overrideHashKey, hash, reasons }) => ({
      type,
      ...(id === undefined ? {} : { id }),
      ...(filePath === undefined ? {} : { filePath }),
      ...(overrideHashKey === undefined ? {} : { overrideHashKey }),
      hash,
      reasons,
    })),
  }
}

export function fingerprintSummary(base, head, changes) {
  const verdict = base.hash === head.hash ? 'OTA-compatible with this base' : 'new iOS binary required'
  const inputs = changes.map((change) => {
    const source = change.afterSource ?? change.addedSource ?? change.removedSource
    return `- ${change.op}: <code>${escape(source.filePath ?? source.id)}</code>`
  })
  return [
    `## iOS native fingerprint: ${verdict}`,
    '',
    `Base: <code>${escape(base.hash)}</code>`,
    `Merge result: <code>${escape(head.hash)}</code>`,
    '',
    ...inputs,
    ...(inputs.length ? [] : ['No changed native inputs.']),
    '',
    'Information only. This base comparison does not establish compatibility with every installed store binary. No shipped fingerprint is recorded here; Expo runtime fingerprint matching still controls OTA delivery.',
    '',
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, project, first, second] = process.argv.slice(2)
  const require = createRequire(resolve(project, 'package.json'))
  const { createFingerprintAsync, diffFingerprints } = require('expo/fingerprint')
  if (mode === 'create') {
    const fingerprint = await createFingerprintAsync(resolve(project), { platforms: ['ios'], concurrentIoLimit: 2 })
    writeFileSync(first, JSON.stringify(fingerprintMetadata(fingerprint), null, 2) + '\n')
  } else if (mode === 'compare') {
    const base = JSON.parse(readFileSync(first, 'utf8'))
    const head = JSON.parse(readFileSync(second, 'utf8'))
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, fingerprintSummary(base, head, diffFingerprints(base, head)))
  } else {
    throw new Error('Choose create or compare')
  }
}
