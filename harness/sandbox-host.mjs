// visual-check#51 on `host`: headless shell started straight on the runner, with Chromium's sandbox against without
// (Playwright's arguments, which carry --no-sandbox). First a bare launch with the sandbox, to see whether it starts
// at all and how long a failed start takes. Then, unless --probe-only, 300 stories at 2 workers per arm, arms in
// round robin per pass, with a look at the renderer processes 15 s and 30 s into each run.
//   node sandbox-host.mjs --exe <headless shell> --tag <name> --out <dir> [--probe-only] [--sb <dir> --rot n --passes n]
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CSS, OFFLINE, bench, renderers, serve } from './sandbox-lib.mjs'

const { values: o } = parseArgs({
  options: {
    exe: { type: 'string' }, tag: { type: 'string', default: 'default' }, out: { type: 'string' }, meta: { type: 'string', default: 'meta' },
    'probe-only': { type: 'boolean', default: false }, sb: { type: 'string' }, rot: { type: 'string', default: '0' }, passes: { type: 'string', default: '3' },
  },
})
o.exe = path.resolve(o.exe)
mkdirSync(o.out, { recursive: true })
const log = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`)
const jsonl = (file, rec) => appendFileSync(path.join(o.out, file), `${JSON.stringify({ tag: o.tag, platform: process.platform, ...rec })}\n`)

// A bare launch that loads about:blank, prints the DOM and exits
function probe(label, extra) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vc-probe-'))
  const t = performance.now()
  const r = spawnSync(o.exe, [...extra, '--no-first-run', `--user-data-dir=${dir}`, '--dump-dom', 'about:blank'], { encoding: 'utf8', timeout: 60_000 })
  const ms = Math.round(performance.now() - t)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  const started = r.status === 0 && /<html/i.test(r.stdout ?? '')
  const rec = { label, started, status: r.status, signal: r.signal, ms, uid: process.getuid?.() ?? null, stderr: (r.stderr ?? '').slice(-900) }
  jsonl('probe.jsonl', rec)
  log(`probe ${o.tag} ${label}: started=${started} status=${r.status} ${ms} ms`)
  return started
}

const sandboxStarts = probe('sandbox', [])
probe('no-sandbox', ['--no-sandbox'])
if (o['probe-only']) process.exit(0)
if (!sandboxStarts) { log('the sandbox does not start here; no arms'); process.exit(0) }

const args = JSON.parse(readFileSync(path.join(o.meta, 'browser-args.json'), 'utf8'))
const flags = {
  'no-sandbox': [...args, OFFLINE],
  sandbox: [...args.filter((a) => a !== '--no-sandbox'), OFFLINE],
}
for (const [arm, f] of Object.entries(flags)) writeFileSync(path.join(o.out, `flags-${arm}.json`), JSON.stringify(f))
const ARMS = Object.keys(flags)
writeFileSync(path.join(o.out, 'machine.json'), JSON.stringify({ platform: process.platform, arch: process.arch, cpus: os.cpus().length, model: os.cpus()[0]?.model, memMb: Math.round(os.totalmem() / 1048576), release: os.release() }))
for (let pass = 1; pass <= Number(o.passes); pass++) {
  for (let i = 0; i < ARMS.length; i++) {
    const arm = ARMS[(i + Number(o.rot)) % ARMS.length]
    const label = `${arm}-p${pass}`
    const stop = await serve(o.sb, () => {})
    log(`### ${o.tag} ${label} ${new Date().toISOString()}`)
    const r = await bench(
      ['--engine', 'raw', '--exe', o.exe, '--flags', path.join(o.out, `flags-${arm}.json`), '--storybook', o.sb, '--stories', '300',
        '--area', 'viewport', '--viewport', '1280x720', '--css', CSS, '--fonts', path.join(o.meta, 'fonts.json'), '--workers', '2',
        '--label', `${o.tag}/${label}`, '--out', path.join(o.out, 'timed.jsonl')],
      (s) => jsonl('renderers.jsonl', { label, atS: s, renderers: renderers() }),
    )
    log(r.tail.split('\n').slice(-3).join('\n'))
    await stop()
  }
}
