// Markdown summary of the sandbox workflow's artifacts: speed per arm, paired against the baseline arm, pixels between
// arms, whether the sandbox started, and what the renderer processes and containers held.
//   node sandbox-summary.mjs <dir with one folder per artifact>
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const read = (dir, f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const fmt = (a, d = 2) => (a.length ? `${median(a).toFixed(d)} (${Math.min(...a).toFixed(d)}–${Math.max(...a).toFixed(d)})` : '–')
const pct = (a) => (a.length ? `${((median(a) - 1) * 100).toFixed(1)}% (${((Math.min(...a) - 1) * 100).toFixed(1)} to ${((Math.max(...a) - 1) * 100).toFixed(1)})` : '–')
const arts = readdirSync(root).filter((d) => d.startsWith('sandbox-')).sort()
const groupOf = (a) => a.replace(/-job\d+$/, '')
const groups = [...new Set(arts.map(groupOf))]

console.log('## Speed and pixels\n')
console.log('| Group | Arm | Captures/s, median (range) | Failures | Against baseline, paired by job and pass | Cells same in every run | Cells differing by arm |')
console.log('|---|---|---:|---:|---:|---:|---:|')
for (const g of groups) {
  const jobs = arts.filter((a) => groupOf(a) === g)
  const recs = jobs.flatMap((j) => read(path.join(root, j), 'timed.jsonl').map((r) => ({ ...r, job: j, arm: r.label.split('/')[1].replace(/-p\d+$/, ''), pass: r.label.match(/-p(\d+)$/)[1] })))
  if (!recs.length) continue
  const arms = [...new Set(recs.map((r) => r.arm))]
  const base = arms.includes('today') ? 'today' : 'no-sandbox'
  let same = 0
  let byArm = 0
  for (const j of jobs) {
    const rs = recs.filter((r) => r.job === j)
    const keys = new Set(rs.flatMap((r) => Object.keys(r.hashes)))
    for (const k of keys) {
      const all = new Set(rs.map((r) => r.hashes[k]))
      if (all.size === 1) { same++; continue }
      const sets = arms.map((a) => new Set(rs.filter((r) => r.arm === a).map((r) => r.hashes[k])))
      if (sets.every((s, i) => sets.every((t, k2) => k2 === i || [...s].every((h) => !t.has(h))))) byArm++
    }
  }
  for (const a of arms) {
    const mine = recs.filter((r) => r.arm === a)
    const ratios = a === base ? [] : mine.map((r) => { const b = recs.find((x) => x.job === r.job && x.pass === r.pass && x.arm === base); return b ? r.capturesPerS / b.capturesPerS : null }).filter(Boolean)
    console.log(`| ${g} | ${a} | ${fmt(mine.map((r) => r.capturesPerS))} | ${mine.reduce((s, r) => s + r.failures, 0)} | ${a === base ? 'baseline' : pct(ratios)} | ${a === arms[0] ? same : ''} | ${a === arms[0] ? byArm : ''} |`)
  }
}

console.log('\n## Does the sandbox start? (bare launch of about:blank)\n')
console.log('| Artifact | Tag | Launch | Started | Exit | ms | uid | First error line |')
console.log('|---|---|---|---|---:|---:|---:|---|')
for (const a of arts) {
  for (const p of read(path.join(root, a), 'probe.jsonl')) {
    const line = p.stderr.split('\n').find((l) => /FATAL|ERROR|not supported|No usable/i.test(l)) ?? ''
    console.log(`| ${a} | ${p.tag} | ${p.label} | ${p.started} | ${p.status ?? p.signal} | ${p.ms} | ${p.uid ?? ''} | ${line.slice(0, 160).replace(/\|/g, '/')} |`)
  }
  for (const e of read(path.join(root, a), 'evidence.jsonl').filter((e) => e.kind === 'sandbox-start')) {
    const line = e.stderr.split('\n').find((l) => /FATAL|ERROR|not supported|No usable/i.test(l)) ?? ''
    console.log(`| ${a} | in container | ${e.label} | ${e.started} | ${e.status} | ${e.ms} | | ${line.slice(0, 160).replace(/\|/g, '/')} |`)
  }
}

console.log('\n## Renderer processes while capturing\n')
console.log('| Artifact | Arm | Samples | Renderers seen | Sandboxed |')
console.log('|---|---|---:|---:|---:|')
for (const a of arts) {
  const rs = read(path.join(root, a), 'renderers.jsonl')
  for (const arm of [...new Set(rs.map((r) => r.label.replace(/-p\d+$/, '')))]) {
    const all = rs.filter((r) => r.label.startsWith(`${arm}-p`)).flatMap((r) => r.renderers)
    const boxed = all.filter((x) => (x.seccomp !== undefined ? x.seccomp === '2' && x.ownPidNs : x.seatbelt !== undefined ? x.seatbelt : !x.noSandboxFlag))
    console.log(`| ${a} | ${arm} | ${rs.filter((r) => r.label.startsWith(`${arm}-p`)).length} | ${all.length} | ${boxed.length} |`)
  }
}

console.log('\n## Containers\n')
for (const a of arts) {
  const txt = path.join(root, a, 'incontainer.txt')
  if (existsSync(txt)) console.log(`**${a}**\n\n\`\`\`\n${readFileSync(txt, 'utf8').trim()}\n\`\`\`\n`)
}
for (const a of arts) {
  const ev = read(path.join(root, a), 'evidence.jsonl').filter((e) => e.kind !== 'sandbox-start')
  if (!ev.length) continue
  console.log(`**${a}**\n`)
  for (const e of ev) console.log(`- ${e.kind}${e.arm ? ` ${e.arm}` : ''}: \`${(e.out || e.err).replace(/\n/g, ' | ').slice(0, 400)}\``)
  console.log('')
}
