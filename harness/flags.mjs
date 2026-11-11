// Writes the Chromium arguments Playwright launches headless shell with, read from the running process, so the
// raw CDP driver starts the same browser. Drops what the raw driver sets itself.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const browser = await chromium.launch()
let args = null
for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
  let cmd
  try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch { continue }
  if (cmd.includes('--remote-debugging-pipe')) { args = cmd.slice(1); break }
}
await browser.close()
const drop = (a) => a === '--remote-debugging-pipe' || a === 'about:blank' || a.startsWith('--user-data-dir=')
writeFileSync(process.argv[2], `${JSON.stringify(args.filter((a) => !drop(a)), null, 1)}\n`)
console.log(`${args.length} arguments`)
