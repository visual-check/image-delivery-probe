// Compares capture hashes across images, passes and jobs. Each input folder holds pixels.jsonl (bench.mjs records,
// label <image>-p<pass>) and store/<sha1>.png. For every pair of differing PNGs of one cell: differing pixels and the
// largest channel delta.
//   node compare.mjs <out.json> <folder>...   (the folder's name is the job)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

const [outFile, ...dirs] = process.argv.slice(2)
const obs = [] // { cell, image, job, pass, hash }
const runs = []
const stores = []
for (const dir of dirs) {
  const job = path.basename(dir)
  stores.push(path.join(dir, 'store'))
  for (const line of readFileSync(path.join(dir, 'pixels.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line)
    const m = r.label.match(/^(.*)-p(\d+)$/)
    const image = m[1]
    const pass = Number(m[2])
    runs.push({ job, image, pass, captures: r.captures, failures: r.failures, capturesPerS: r.capturesPerS, browser: r.browser, failureSamples: r.failureSamples })
    for (const [cell, hash] of Object.entries(r.hashes)) obs.push({ cell, image, job, pass, hash })
  }
}
const png = new Map()
const load = (h) => {
  if (!png.has(h)) {
    const f = stores.map((s) => path.join(s, `${h}.png`)).find((p) => existsSync(p))
    png.set(h, f ? PNG.sync.read(readFileSync(f)) : null)
  }
  return png.get(h)
}
const deltas = new Map()
const delta = (a, b) => {
  const k = a < b ? `${a}:${b}` : `${b}:${a}`
  if (deltas.has(k)) return deltas.get(k)
  const x = load(a)
  const y = load(b)
  let d
  if (!x || !y) d = { missing: true }
  else if (x.width !== y.width || x.height !== y.height) d = { size: [`${x.width}x${x.height}`, `${y.width}x${y.height}`] }
  else {
    let pixels = 0
    let max = 0
    for (let i = 0; i < x.data.length; i += 4) {
      let m = 0
      for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(x.data[i + c] - y.data[i + c]))
      if (m) { pixels++; max = Math.max(max, m) }
    }
    d = { pixels, maxDelta: max }
  }
  deltas.set(k, d)
  return d
}
const mode = (hs) => {
  const c = new Map()
  for (const h of hs) c.set(h, (c.get(h) ?? 0) + 1)
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

const images = [...new Set(obs.map((o) => o.image))]
const cells = [...new Set(obs.map((o) => o.cell))].sort()
const byCell = new Map(cells.map((c) => [c, obs.filter((o) => o.cell === c)]))
const result = { inputs: dirs.map((d) => path.basename(d)), images, cells: cells.length, runs: [], stability: {}, pairs: {} }

// Runs: captures, failures, speed
for (const image of images) {
  const rs = runs.filter((r) => r.image === image)
  const speeds = rs.map((r) => r.capturesPerS).sort((a, b) => a - b)
  result.runs.push({ image, runs: rs.length, browser: rs[0]?.browser, failures: rs.reduce((a, r) => a + r.failures, 0), captures: rs.map((r) => r.captures),
    capturesPerS: { median: speeds[Math.floor(speeds.length / 2)], min: speeds[0], max: speeds.at(-1), all: rs.map((r) => `${r.job}/p${r.pass}: ${r.capturesPerS}`) },
    failureSamples: rs.flatMap((r) => r.failureSamples ?? []).slice(0, 5) })
}
// Stability within one image across passes and jobs
for (const image of images) {
  const unstable = []
  for (const cell of cells) {
    const os = byCell.get(cell).filter((o) => o.image === image)
    const hs = [...new Set(os.map((o) => o.hash))]
    if (hs.length > 1) {
      const m = mode(os.map((o) => o.hash))
      unstable.push({ cell, variants: hs.length, seen: os.map((o) => `${o.job}/p${o.pass}:${o.hash.slice(0, 7)}`), vsMode: hs.filter((h) => h !== m).map((h) => delta(m, h)) })
    }
  }
  result.stability[image] = { observations: obs.filter((o) => o.image === image).length, unstableCells: unstable.length, unstable }
}
// Pairs of images: per cell, the image's most common hash
const modal = new Map(cells.map((c) => [c, Object.fromEntries(images.map((i) => {
  const hs = byCell.get(c).filter((o) => o.image === i).map((o) => o.hash)
  return [i, hs.length ? mode(hs) : null]
}))]))
for (let i = 0; i < images.length; i++) {
  for (let j = i + 1; j < images.length; j++) {
    const [a, b] = [images[i], images[j]]
    const diff = []
    let shared = 0
    let disjoint = 0
    for (const cell of cells) {
      const m = modal.get(cell)
      if (!m[a] || !m[b]) continue
      shared++
      const sa = new Set(byCell.get(cell).filter((o) => o.image === a).map((o) => o.hash))
      const sb = byCell.get(cell).filter((o) => o.image === b).map((o) => o.hash)
      if (!sb.some((h) => sa.has(h))) disjoint++
      if (m[a] !== m[b]) diff.push({ cell, ...delta(m[a], m[b]) })
    }
    result.pairs[`${a} vs ${b}`] = { cells: shared, modalDiffer: diff.length, noCommonHash: disjoint, maxPixels: Math.max(0, ...diff.map((d) => d.pixels ?? 0)), maxDelta: Math.max(0, ...diff.map((d) => d.maxDelta ?? 0)), diff }
  }
}
writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`)
console.log(JSON.stringify(result.runs.map(({ failureSamples, capturesPerS: { all, ...speed }, ...r }) => ({ ...r, capturesPerS: speed }))))
for (const [image, s] of Object.entries(result.stability)) console.log(`stability ${image}: ${s.unstableCells} unstable of ${cells.length}`, s.unstable.slice(0, 5).map((u) => `${u.cell} ${JSON.stringify(u.vsMode)}`).join('; '))
for (const [k, p] of Object.entries(result.pairs)) console.log(`${k}: ${p.modalDiffer} modal differ, ${p.noCommonHash} no common hash, max ${p.maxPixels} px / delta ${p.maxDelta}`, p.diff.slice(0, 5).map((d) => `${d.cell} ${d.pixels}px/${d.maxDelta}`).join('; '))
