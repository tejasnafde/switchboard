/**
 * Seed a demo project + conversation into a Switchboard database so the mobile
 * app has something to render.
 *
 * The headless server keeps its own database (~/.switchboard) separate from the
 * desktop app's (~/Library/Application Support/switchboard), so a freshly paired
 * phone shows an empty list and there is no way to look at the Thread screen.
 * This creates a throwaway git repo and a realistic conversation pointing at it.
 *
 * Rows are written directly rather than through the app so this works with the
 * server stopped, and so the messages can include the shapes worth looking at:
 * plain prose, a tool call, and a longer reply.
 *
 * Run it with Electron's node, because better-sqlite3 is built for that ABI:
 *   npm run seed:demo
 *
 * Idempotent: re-running replaces the demo rows and leaves everything else alone.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const REPO_DIR = process.env.DEMO_REPO ?? join(homedir(), 'switchboard-demo')
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR ?? join(homedir(), '.switchboard')
const DB_PATH = join(DATA_DIR, 'data', 'switchboard.db')
const CONV_ID = 'demo-conversation-1'

function makeRepo() {
  if (!existsSync(join(REPO_DIR, '.git'))) {
    mkdirSync(REPO_DIR, { recursive: true })
    writeFileSync(
      join(REPO_DIR, 'README.md'),
      '# switchboard-demo\n\nA throwaway repo so the mobile app has a project to open.\n',
    )
    writeFileSync(join(REPO_DIR, 'index.js'), "console.log('hello from the demo repo')\n")
    const git = (...args) => execFileSync('git', args, { cwd: REPO_DIR, stdio: 'ignore' })
    git('init', '-q')
    git('add', '.')
    // -c so this never depends on, or touches, global git identity.
    execFileSync(
      'git',
      ['-c', 'user.email=demo@localhost', '-c', 'user.name=demo', 'commit', '-qm', 'initial commit'],
      { cwd: REPO_DIR, stdio: 'ignore' },
    )
    console.log(`created repo   ${REPO_DIR}`)
  } else {
    console.log(`repo exists    ${REPO_DIR}`)
  }
}

const MESSAGES = [
  {
    role: 'user',
    content: 'What does this repo do, and is there anything obviously wrong with index.js?',
  },
  {
    role: 'assistant',
    content:
      "It is a two-file demo: a README and an index.js that logs a line. Nothing is wrong with it as such, though `console.log` as the only entry point means there is no way to import it as a module - there are no exports.",
    toolCalls: [
      { id: 'demo-tool-1', name: 'Read', input: JSON.stringify({ file_path: 'index.js' }), output: "console.log('hello from the demo repo')" },
    ],
  },
  { role: 'user', content: 'Add a test for it.' },
  {
    role: 'assistant',
    content:
      'There is nothing exported to assert against yet, so a test would only be able to check that the file runs without throwing. Worth extracting the message into a function first, then the test has something real to pin: that it returns the expected string rather than merely not crashing.',
    toolCalls: [
      { id: 'demo-tool-2', name: 'Grep', input: JSON.stringify({ pattern: 'module.exports' }), output: 'no matches' },
    ],
  },
]

function seed() {
  if (!existsSync(DB_PATH)) {
    console.error(`no database at ${DB_PATH}`)
    console.error('start the server once so it is created, then re-run this.')
    process.exit(1)
  }
  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const now = Date.now()
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO projects (path, name, added_at) VALUES (?, ?, ?)').run(
      REPO_DIR,
      'switchboard-demo',
      now,
    )
    // Cascade clears any previous demo messages, so re-running does not stack them.
    db.prepare('DELETE FROM conversations WHERE id = ?').run(CONV_ID)
    db.prepare(
      `INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at, runtime_mode)
       VALUES (?, ?, 'claude-code', ?, ?, ?, 'sandbox')`,
    ).run(CONV_ID, REPO_DIR, 'Demo: reading the repo', now - 600_000, now)

    const insert = db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, tool_calls, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    MESSAGES.forEach((m, i) => {
      insert.run(
        `demo-msg-${i + 1}`,
        CONV_ID,
        m.role,
        m.content,
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        now - (MESSAGES.length - i) * 60_000,
      )
    })
  })()

  const counts = db
    .prepare(
      `SELECT (SELECT count(*) FROM projects) p,
              (SELECT count(*) FROM conversations) c,
              (SELECT count(*) FROM messages) m`,
    )
    .get()
  db.close()
  console.log(`seeded        ${DB_PATH}`)
  console.log(`db now has    projects=${counts.p} conversations=${counts.c} messages=${counts.m}`)
  console.log('\nRestart the server, then pull to refresh in the app.')
}

makeRepo()
seed()
