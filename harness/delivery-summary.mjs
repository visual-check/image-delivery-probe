// Medians and ranges per runner image and variant from delivery artifacts (folders holding variants.jsonl and
// machine.json). Folder names may carry the run, as <run>/delivery-<runner>-<shard>.
//   node delivery-summary.mjs <folder>...   prints Markdown tables
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const rows = []
const machines = []
for (const dir of process.argv.slice(2)) {
  const run = path.basename(path.dirname(dir))
  const f = path.join(dir, 'variants.jsonl')
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) rows.push({ run, ...JSON.parse(line) })
  const m = path.join(dir, 'machine.json')
  if (existsSync(m)) machines.push({ run, ...JSON.parse(readFileSync(m, 'utf8')) })
}
const q = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return '–'
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return `${med.toFixed(1)} (${s[0].toFixed(1)}–${s.at(-1).toFixed(1)})`
}
const names = { a: 'Playwright, MCR pull', b: 'full gzip, GHCR', c: 'full zstd, GHCR', d: 'base gzip + CfT zip (Google)', e: 'base zstd + CfT zip (Google)',
  f: 'Playwright tar, cache + load', g: 'full tar, cache + load', h: 'base tar + CfT zip, cache' }
const runners = [...new Set(rows.map((r) => r.runner))].sort()
const runs = [...new Set(rows.map((r) => r.run))].sort()
console.log(`Runs: ${runs.join(', ')}; ${rows.length} measurements.\n`)
for (const runner of runners) {
  console.log(`### ${runner}\n`)
  console.log('| Variant | n | Runnable image, s | First reply, ms | Total, s | Parts (median s) |')
  console.log('|---|---|---|---|---|---|')
  for (const v of Object.keys(names)) {
    const rs = rows.filter((r) => r.runner === runner && r.variant === v)
    if (!rs.length) continue
    const parts = [...new Set(rs.flatMap((r) => Object.keys(r.parts)))]
    const pm = parts.map((p) => `${p} ${q(rs.map((r) => r.parts[p])).split(' ')[0]}`).join(', ')
    const fails = rs.filter((r) => !r.firstReplyMs).length
    console.log(`| ${v} ${names[v]} | ${rs.length}${fails ? ` (${fails} no reply)` : ''} | ${q(rs.map((r) => r.runnableS))} | ${q(rs.map((r) => r.firstReplyMs))} | ${q(rs.map((r) => r.totalS))} | ${pm} |`)
  }
  console.log('')
  console.log('Per run (total s, median):', runs.map((run) => `${run}: ${Object.keys(names).map((v) => `${v} ${q(rows.filter((r) => r.runner === runner && r.run === run && r.variant === v).map((r) => r.totalS)).split(' ')[0]}`).join(' ')}`).join(' | '))
  console.log('Warm reply ms (median):', Object.keys(names).map((v) => `${v} ${q(rows.filter((r) => r.runner === runner && r.variant === v).map((r) => r.warmReplyMs)).split(' ')[0]}`).join(', '))
  const ms = machines.filter((m) => m.runner === runner)
  console.log(`Machines: ${[...new Set(ms.map((m) => `${m.image} ${m.nproc} CPU ${m.cpu} docker ${m.docker} ${m.storageDriver}${m.containerdSnapshotter ? ' (containerd snapshotter)' : ''}`))].join('; ')}; disk free ${q(ms.map((m) => m.diskFreeGb))} GB`)
  console.log(`Browser: ${[...new Set(rows.filter((r) => r.runner === runner).map((r) => r.product))].join(', ')}\n`)
}
