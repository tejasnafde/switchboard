import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Lets the global teardown attribute log files to this run's workers.
const root = process.env.SB_TEST_RUN_ROOT
if (root) writeFileSync(join(root, 'pids', String(process.pid)), '')
