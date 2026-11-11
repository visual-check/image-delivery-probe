// Where the browser comes from, on a Docker Desktop-like runtime (Docker Desktop on Windows, OrbStack on macOS):
//   a: full image (browser inside)
//   b: base image + the unzipped CfT folder on the host, bind-mounted read-only
//   c: base image + a named volume, populated once by streaming the zip into a helper container that unzips it
// Times to the first CDP reply (Browser.getVersion over the docker run -i pipe), per pass. Optionally captures the
// Storybook with bench.mjs for some variants (SOCKS proxy on 127.0.0.1, reached through host.docker.internal).
// Dependency-free apart from bench.mjs's. Reads meta/pins.json and meta/browser-args.json. Appends JSON lines to --out.
//   node mount-probe.mjs --docker '["docker"]' --host <label> --zip <CfT zip> --chs <unzipped folder> --out <jsonl>
//        [--passes 3] [--pull] [--drop-caches] [--platform linux/amd64] [--capture a,b --storybook <dir> --pngs <dir>]
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values: o } = parseArgs({
  options: {
    docker: { type: 'string', default: '["docker"]' },
    host: { type: 'string' },
    zip: { type: 'string' },
    chs: { type: 'string' },
    out: { type: 'string' },
    passes: { type: 'string', default: '3' },
    pull: { type: 'boolean', default: false },
    'drop-caches': { type: 'boolean', default: false },
    platform: { type: 'string' },
    capture: { type: 'string', default: '' },
    storybook: { type: 'string' },
    pngs: { type: 'string' },
    volume: { type: 'string', default: 'vc-probe-chs' },
  },
})
const H = path.dirname(fileURLToPath(import.meta.url))
const pins = JSON.parse(readFileSync('meta/pins.json', 'utf8'))
const browserArgs = JSON.parse(readFileSync('meta/browser-args.json', 'utf8'))
const docker = JSON.parse(o.docker)
const HELPER = 'alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f'
const full = pins.images['full-gzip']
const base = pins.images['base-gzip']
const plat = o.platform ? ['--platform', o.platform] : []
const record = (r) => {
  const line = JSON.stringify({ host: o.host, ...r, at: new Date().toISOString() })
  console.log(line)
  appendFileSync(o.out, `${line}\n`)
}
const run = (args, opts = {}) => {
  const t = performance.now()
  const r = spawnSync(docker[0], [...docker.slice(1), ...args], { encoding: 'utf8', maxBuffer: 1 << 26, ...opts })
  const s = (performance.now() - t) / 1000
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')}: exit ${r.status} ${r.stderr}`)
  return { s: +s.toFixed(3), stdout: r.stdout }
}
const mounts = {
  a: [],
  b: ['--mount', `type=bind,source=${path.resolve(o.chs)},target=/opt/chrome-headless-shell,readonly`],
  c: ['--mount', `type=volume,source=${o.volume},target=/opt/chrome-headless-shell,readonly`],
}
const image = { a: full, b: base, c: base }
// The same argv shape as lib.sh's docker_argv
const argv = (v, dockerArgs, extra) => [...docker, 'run', '-i', '--rm', '--pull', 'never', ...plat, ...dockerArgs, ...mounts[v], image[v],
  'sh', '-c', 'exec "$0" "$@" 3<&0 4>&1 1>&2', pins.ourExe, ...browserArgs, '--user-data-dir=/tmp/u', '--remote-debugging-pipe', ...extra, 'about:blank']
const firstReply = (v) => {
  const r = spawnSync(process.execPath, [path.join(H, 'first-reply.mjs'), JSON.stringify(argv(v, [], []))], { encoding: 'utf8' })
  try { return JSON.parse(r.stdout.trim().split('\n').at(-1)) } catch { return { ms: null, stdout: r.stdout, stderr: r.stderr } }
}

record({ kind: 'runtime', info: run(['info', '--format', '{{.ServerVersion}} | {{.OperatingSystem}} | {{.KernelVersion}} | {{.NCPU}} CPUs | {{.MemTotal}} | {{.Driver}}']).stdout.trim() })
if (o.pull) {
  for (const [name, ref] of [['full-gzip', full], ['base-gzip', base], ['helper', HELPER]]) record({ kind: 'pull', image: name, s: run(['pull', '-q', ...plat, ref]).s })
}
// Volume: a fresh one, filled from the zip streamed over stdin, so no host path is shared
spawnSync(docker[0], [...docker.slice(1), 'volume', 'rm', '-f', o.volume])
run(['volume', 'create', o.volume])
{
  const t = performance.now()
  const child = spawn(docker[0], [...docker.slice(1), 'run', '-i', '--rm', '--pull', 'never', ...plat, '--mount', `type=volume,source=${o.volume},target=/v`, HELPER,
    'sh', '-c', 'cat > /tmp/c.zip && unzip -q /tmp/c.zip -d /v && ls -l /v/*/chrome-headless-shell'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  createReadStream(o.zip).pipe(child.stdin)
  const code = await new Promise((r) => child.on('exit', r))
  record({ kind: 'populate-volume', s: +((performance.now() - t) / 1000).toFixed(3), exit: code, how: `zip streamed over stdin into ${HELPER.split('@')[0]} (busybox unzip)`, out: out.trim() })
}
const dropCaches = () => {
  if (o['drop-caches']) run(['run', '--rm', '--privileged', '--pid', 'host', '--pull', 'never', ...plat, HELPER, 'sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches'])
}
for (let p = 1; p <= Number(o.passes); p++) {
  for (const v of ['a', 'b', 'c']) {
    dropCaches()
    const r1 = firstReply(v)
    const r2 = firstReply(v)
    record({ kind: 'first-reply', pass: p, variant: v, cachesDropped: o['drop-caches'], ms: r1.ms, warmMs: r2.ms, product: r1.product ?? null, error: r1.ms ? undefined : r1 })
  }
}
// Captures through the SOCKS proxy in bench.mjs's process
for (const v of o.capture.split(',').filter(Boolean)) {
  dropCaches()
  const extra = ['--proxy-server=socks5://host.docker.internal:1080', '--proxy-bypass-list=<-loopback>']
  const save = path.join(o.pngs, `run-${v}`)
  const label = `${o.host}-${v}-p1`
  const serve = spawn(process.execPath, [path.join(H, 'serve.mjs'), o.storybook, '6400', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((r) => serve.stdout.on('data', (d) => { if (String(d).includes('serving')) r() }))
  const b = spawnSync(process.execPath, [path.join(H, 'bench.mjs'), '--engine', 'raw', '--spawn', JSON.stringify(argv(v, ['--init', '--ipc=host', '--cpus=2', '--memory=7g'], extra)),
    '--socks', '127.0.0.1:1080', '--socks-allow', '127.0.0.1:6400,localhost:6400', '--storybook', o.storybook, '--stories', '300', '--area', 'viewport',
    '--viewport', '1280x720', '--css', 'html>:not(head):not(body){display:none!important}', '--fonts', 'meta/fonts.json', '--workers', '2',
    '--label', label, '--out', path.join(o.pngs, 'pixels.jsonl'), '--save', save], { encoding: 'utf8', env: { ...process.env, CPUS: '2' } })
  serve.kill()
  const brief = b.stdout.trim().split('\n').at(-1)
  record({ kind: 'capture', variant: v, label, exit: b.status, brief: brief?.slice(0, 1500), stderr: b.stderr?.slice(-800) })
  mkdirSync(path.join(o.pngs, 'store'), { recursive: true })
  if (existsSync(save)) {
    for (const f of readdirSync(save)) {
      const h = createHash('sha1').update(readFileSync(path.join(save, f))).digest('hex')
      const dest = path.join(o.pngs, 'store', `${h}.png`)
      if (existsSync(dest)) rmSync(path.join(save, f))
      else renameSync(path.join(save, f), dest)
    }
    rmSync(save, { recursive: true, force: true })
  }
}
spawnSync(docker[0], [...docker.slice(1), 'volume', 'rm', '-f', o.volume])
