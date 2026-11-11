// Summarises the network workflow: the proxy's cost per arm (median captures per second, Node CPU per capture) and
// which way into the job container reached the stand-in Storybook.
//   node network-summary.mjs <artifacts dir>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const files = (dir) => readdirSync(dir).flatMap((n) => { const f = path.join(dir, n); return statSync(f).isDirectory() ? files(f) : [f] })
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const all = files(root)
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const runs = all.filter((f) => f.endsWith('timed.jsonl')).flatMap((f) => lines(f).map((r) => ({ ...r, job: path.basename(path.dirname(f)) })))
const arms = {}
for (const r of runs) (arms[r.label.replace(/-p\d+$/, '')] ??= []).push(r)
console.log('## Proxy cost\n')
console.log('| Arm | Runs | Captures/s, median (min–max) | Node CPU ms per capture, median | Failures |')
console.log('|---|---:|---:|---:|---:|')
for (const [arm, rs] of Object.entries(arms).sort()) {
  const rate = rs.map((r) => r.capturesPerS)
  const cpu = rs.map((r) => (r.driverCpuS * 1000) / Math.max(r.captures, 1))
  console.log(`| ${arm} | ${rs.length} | ${median(rate).toFixed(2)} (${Math.min(...rate).toFixed(2)}–${Math.max(...rate).toFixed(2)}) | ${median(cpu).toFixed(1)} | ${rs.reduce((a, r) => a + r.failures, 0)} |`)
}
for (const cpus of ['2cpu', '4cpu']) {
  const h = arms[`hostnet-${cpus}`]; const p = arms[`proxy-${cpus}`]
  if (!h || !p) continue
  // Paired by job and pass, since the arms ran in round robin on the same machine
  const pairs = h.map((r) => [r, p.find((q) => q.job === r.job && q.label.endsWith(r.label.slice(r.label.lastIndexOf('-p'))))]).filter(([, q]) => q)
  const ratio = pairs.map(([a, b]) => b.capturesPerS / a.capturesPerS - 1)
  console.log(`\n${cpus}: proxy against host networking, paired by job and pass: median ${(median(ratio) * 100).toFixed(1)}% (${pairs.length} pairs, ${ratio.filter((x) => x < 0).length} slower)`)
}
const machines = all.filter((f) => f.endsWith('machine.txt'))
for (const m of machines) console.log(`\n${path.basename(path.dirname(m))}: ${readFileSync(m, 'utf8').split('\n').filter(Boolean).join('; ')}`)

console.log('\n## Ways into the job container\n')
console.log('| Way | 127.0.0.1 | localhost | hosts-file name | Proxy connections |')
console.log('|---|---|---|---|---|')
for (const f of all.filter((f) => f.endsWith('reach.jsonl'))) {
  for (const r of lines(f)) {
    const cell = (i) => { const x = r.results[i]; return !x ? (r.error ?? '?') : x.error ? x.error : x.title === 'reached the job container' ? 'reached' : `other: ${x.title}` }
    const s = r.socks.listen ? `${r.socks.listen}${r.socks.error ? ` (${r.socks.error})` : ''}: ${r.socks.connections.filter((c) => c.ok).length} ok of ${r.socks.connections.length}` : ''
    console.log(`| ${r.label} | ${cell(0)} | ${cell(1)} | ${cell(2)} | ${s} |`)
  }
}
for (const f of all.filter((f) => f.endsWith('capture.jsonl'))) for (const r of lines(f)) console.log(`\nCapture through join: ${r.captures} of ${r.cells} captured, ${r.failures} failures, ${r.capturesPerS}/s, ${r.browser}`)
