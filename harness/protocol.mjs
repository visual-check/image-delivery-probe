// Reads a DEBUG=pw:protocol log split by bench.mjs --marks: writes Playwright's font table, and counts the CDP
// messages Playwright sends and receives per page setup and per capture.
import { readFileSync, writeFileSync } from 'node:fs'

const [log, fontsOut, auditOut] = process.argv.slice(2)
let seg = 'launch'
const segs = {}
let fonts = null
for (const line of readFileSync(log, 'utf8').split('\n')) {
  const m = line.match(/^@@ (\S+)/)
  if (m) { seg = m[1]; continue }
  const p = line.match(/(SEND ►|◀ RECV) (\{.*\})\s*$/)
  if (!p) continue
  const msg = JSON.parse(p[2])
  if (!fonts && msg.method === 'Page.setFontFamilies') fonts = msg.params
  const s = (segs[seg] ??= { n: 0, sent: {}, events: {}, replies: 0 })
  if (p[1].startsWith('SEND')) { s.sent[msg.method] = (s.sent[msg.method] ?? 0) + 1 }
  else if (msg.method) s.events[msg.method] = (s.events[msg.method] ?? 0) + 1
  else s.replies++
}
// Count how many segments of each kind there were, to report per-page and per-capture averages
const raw = readFileSync(log, 'utf8')
for (const k of Object.keys(segs)) segs[k].n = (raw.match(new RegExp(`^@@ ${k}`, 'gm')) ?? []).length || 1
writeFileSync(fontsOut, `${JSON.stringify(fonts)}\n`)
writeFileSync(auditOut, `${JSON.stringify(segs, null, 1)}\n`)
for (const [k, s] of Object.entries(segs)) {
  const sent = Object.values(s.sent).reduce((a, b) => a + b, 0), ev = Object.values(s.events).reduce((a, b) => a + b, 0)
  console.log(`${k}: x${s.n}, per one: sent ${(sent / s.n).toFixed(1)}, events ${(ev / s.n).toFixed(1)}`)
}
