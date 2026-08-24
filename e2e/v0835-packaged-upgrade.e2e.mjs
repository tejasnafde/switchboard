#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
const packagedExecutable = process.env.SB_PACKAGED_EXECUTABLE
  ?? join(repoRoot, 'release/mac-arm64/Switchboard.app/Contents/MacOS/Switchboard')
const previousPackagedExecutable = process.env.SB_PREVIOUS_PACKAGED_EXECUTABLE

if (!existsSync(packagedExecutable)) {
  console.error(`Packaged executable missing: ${packagedExecutable}`)
  process.exit(1)
}
if (previousPackagedExecutable && !existsSync(previousPackagedExecutable)) {
  console.error(`Previous packaged executable missing: ${previousPackagedExecutable}`)
  process.exit(1)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'sb-v0835-packaged-'))
const extractedRoot = join(tempRoot, 'v0835-source')
const userDataDir = join(tempRoot, 'user-data')
const isolatedHome = join(tempRoot, 'home')
const isolatedTmp = join(tempRoot, 'tmp')
let app

for (const path of [extractedRoot, userDataDir, isolatedHome, isolatedTmp]) {
  mkdirSync(path, { recursive: true })
}

const cleanup = () => rmSync(tempRoot, { recursive: true, force: true })
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`✓ ${message}`)
}

function isolatedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/i.test(key)) delete env[key]
  }
  delete env.SWITCHBOARD_BACKEND_URL
  delete env.SWITCHBOARD_DATA_DIR
  return {
    ...env,
    HOME: isolatedHome,
    TMPDIR: isolatedTmp,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local/share'),
    CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'),
    CODEX_HOME: join(isolatedHome, '.codex'),
    OPENCODE_CONFIG_DIR: join(isolatedHome, '.config/opencode'),
    SB_USER_DATA: userDataDir,
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
}

async function closeApp() {
  if (!app) return
  const closing = app
  app = undefined
  const closed = await Promise.race([
    closing.close().then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!closed) closing.process().kill('SIGKILL')
}

async function launch(executablePath = packagedExecutable) {
  app = await electron.launch({
    executablePath,
    args: [],
    cwd: repoRoot,
    env: isolatedEnv(),
  })
  const win = await app.firstWindow({ timeout: 30_000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 30_000 })
  return win
}

async function seedWithPublishedInitializer() {
  const archive = execFileSync('/usr/bin/git', [
    '-C',
    repoRoot,
    'archive',
    '--format=tar',
    'v0.8.35',
  ], { maxBuffer: 100 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', extractedRoot], { input: archive })

  const fixtureEntry = join(extractedRoot, 'seed-v0835.ts')
  const fixtureBundle = join(tempRoot, 'seed-v0835.cjs')
  writeFileSync(fixtureEntry, `
    import { getDb, closeDb } from './src/main/db/database'
    const db = getDb()
    db.prepare('INSERT INTO projects(path, name, added_at, sort_order) VALUES (?, ?, ?, ?)')
      .run('/fixture/project', 'Fixture project', 100, 3)
    db.prepare(\`
      INSERT INTO conversations
        (id, project_path, agent_type, session_id, title, created_at, updated_at,
         archived, runtime_mode, sidebar_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`).run(
      'fixture-thread', '/fixture/project', 'claude-code', 'native-session',
      'Upgrade fixture', 101, 102, 0, 'sandbox', 'managed',
    )
    db.prepare(\`
      INSERT INTO messages
        (id, conversation_id, role, content, images, timestamp, display_body, pills_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    \`).run(
      'fixture-message', 'fixture-thread', 'user', 'provider text',
      JSON.stringify([{ url: 'data:image/png;base64,AAA', mimeType: 'image/png' }]),
      103, 'visible text', JSON.stringify({}),
    )
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)')
      .run('fixture-setting', 'preserved')
    closeDb()
  `)

  await build({
    entryPoints: [fixtureEntry],
    outfile: fixtureBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: join(extractedRoot, 'tsconfig.main.json'),
    external: ['better-sqlite3', 'electron'],
    logLevel: 'silent',
  })

  execFileSync(packagedExecutable, [fixtureBundle], {
    cwd: repoRoot,
    env: {
      ...isolatedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SWITCHBOARD_DATA_DIR: userDataDir,
      NODE_PATH: join(repoRoot, 'node_modules'),
    },
    stdio: 'inherit',
  })
}

async function assertFixture(win, phase) {
  const result = await win.evaluate(async () => ({
    setting: await window.api.settings.get('fixture-setting'),
    projects: await window.api.app.getProjects(),
    messages: await window.api.app.searchMessages('provider'),
  }))
  const serializedProjects = JSON.stringify(result.projects)
  check(result.setting === 'preserved', `${phase}: v0.8.35 setting survived`)
  check(serializedProjects.includes('Fixture project'), `${phase}: v0.8.35 project survived`)
  check(result.messages.some((row) => row.conversationId === 'fixture-thread' && row.content === 'provider text'),
    `${phase}: v0.8.35 conversation and message survived`)
}

try {
  await seedWithPublishedInitializer()
  check(existsSync(join(userDataDir, 'data', 'switchboard.db')), 'published v0.8.35 initializer created the fixture')

  if (previousPackagedExecutable) {
    const previousWindow = await launch(previousPackagedExecutable)
    await assertFixture(previousWindow, 'predecessor packaged launch')
    await closeApp()
  }

  let win = await launch()
  await assertFixture(win, 'first packaged launch')
  await closeApp()

  win = await launch()
  await assertFixture(win, 'second packaged launch')
  await closeApp()
  console.log('✓ packaged v0.8.35 → current migration and restart rehearsal passed')
} finally {
  await closeApp()
  cleanup()
}
