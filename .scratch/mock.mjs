import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/Users/tejas/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
await p.goto('file:///Users/tejas/.claude-tech-team/sb-jobs/toolbar/toolbar-mock.html')
await p.screenshot({ path: '/tmp/sb-toolbar-mock.png', fullPage: true })
const h = await p.evaluate(() => document.body.scrollHeight)
console.log(h)
await b.close()
