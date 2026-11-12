// visual-check#51 in visual-check's own container: today's `docker run` (root, Docker's default capabilities) against
// a hardened one (the image's non-root `ubuntu` user, every capability dropped, no new privileges). Both keep
// --no-sandbox. 300 stories at 2 workers per arm, arms in round robin per pass. Also records what a process in each
// arm holds, and whether Chromium's sandbox can start in the container at all.
//   node sandbox-container.mjs --docker '["docker"]' --net host|proxy --tag <name> --out <dir> --sb <dir> [--rot n --passes n]
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { CSS, OFFLINE, bench, serve } from './sandbox-lib.mjs'

const { values: o } = parseArgs({
  options: {
    docker: { type: 'string', default: '["docker"]' }, net: { type: 'string', default: 'host' }, tag: { type: 'string', default: 'container' },
    out: { type: 'string' }, sb: { type: 'string' }, meta: { type: 'string', default: 'meta' }, rot: { type: 'string', default: '0' }, passes: { type: 'string', default: '3' },
  },
})
mkdirSync(o.out, { recursive: true })
const log = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`)
const jsonl = (file, rec) => appendFileSync(path.join(o.out, file), `${JSON.stringify({ tag: o.tag, ...rec })}\n`)
const docker = JSON.parse(o.docker)
const pins = JSON.parse(readFileSync(path.join(o.meta, 'pins.json'), 'utf8'))
const IMG = pins.images['full-gzip']
const EXE = pins.ourExe
const browserArgs = JSON.parse(readFileSync(path.join(o.meta, 'browser-args.json'), 'utf8'))
const run = (args, timeout = 90_000) => spawnSync(docker[0], [...docker.slice(1), ...args], { encoding: 'utf8', timeout })

const ARMS = {
  today: [],
  hardened: ['--user', 'ubuntu', '--cap-drop=ALL', '--security-opt=no-new-privileges'],
}
const common = ['--init', '--ipc=host', '--memory=7g', '--pull', 'never', '--cpus=2']
const net = o.net === 'host' ? ['--network', 'host'] : []
const extra = o.net === 'host' ? [OFFLINE] : ['--proxy-server=socks5://host.docker.internal:1080', '--proxy-bypass-list=<-loopback>']
const socks = o.net === 'host' ? [] : ['--socks', '127.0.0.1:1080', '--socks-allow', '127.0.0.1:6400,localhost:6400']

const info = run(['info', '--format', '{{.ServerVersion}} | {{.OperatingSystem}} | {{.KernelVersion}} | {{.NCPU}} CPUs | {{.MemTotal}} | {{json .SecurityOptions}}'])
jsonl('evidence.jsonl', { kind: 'docker-info', out: info.stdout.trim(), err: info.stderr.trim() })

// What a process in each arm holds
for (const [arm, flags] of Object.entries(ARMS)) {
  const r = run(['run', '--rm', ...common, ...net, ...flags, IMG, 'sh', '-c', 'id; grep -E "^(Cap(Prm|Eff|Bnd)|NoNewPrivs|Seccomp):" /proc/self/status'])
  jsonl('evidence.jsonl', { kind: 'process', arm, status: r.status, out: r.stdout.trim(), err: r.stderr.trim() })
  log(`${arm}: ${r.stdout.trim().replace(/\n/g, ' | ')}`)
}
// Whether Chromium's sandbox can start in the container: as root, as the non-root user, and hardened
for (const [label, flags] of Object.entries({ root: [], ubuntu: ['--user', 'ubuntu'], hardened: ARMS.hardened })) {
  const t = performance.now()
  const r = run(['run', '--rm', ...common, ...net, ...flags, IMG, EXE, '--no-first-run', '--user-data-dir=/tmp/p', '--dump-dom', 'about:blank'])
  const started = r.status === 0 && /<html/i.test(r.stdout)
  jsonl('evidence.jsonl', { kind: 'sandbox-start', label, started, status: r.status, ms: Math.round(performance.now() - t), stderr: r.stderr.slice(-900) })
  log(`sandbox in container as ${label}: started=${started} status=${r.status}`)
}

for (let pass = 1; pass <= Number(o.passes); pass++) {
  const names = Object.keys(ARMS)
  for (let i = 0; i < names.length; i++) {
    const arm = names[(i + Number(o.rot)) % names.length]
    const label = `${arm}-p${pass}`
    const spawnArgv = [...docker, 'run', '-i', '--rm', ...common, ...net, ...ARMS[arm], IMG, 'sh', '-c', 'exec "$0" "$@" 3<&0 4>&1 1>&2', EXE,
      ...browserArgs, '--user-data-dir=/tmp/u', '--remote-debugging-pipe', ...extra, 'about:blank']
    const stop = await serve(o.sb, () => {})
    log(`### ${o.tag} ${label} ${new Date().toISOString()}`)
    const r = await bench(['--engine', 'raw', '--spawn', JSON.stringify(spawnArgv), ...socks, '--storybook', o.sb, '--stories', '300',
      '--area', 'viewport', '--viewport', '1280x720', '--css', CSS, '--fonts', path.join(o.meta, 'fonts.json'), '--workers', '2',
      '--label', `${o.tag}/${label}`, '--out', path.join(o.out, 'timed.jsonl')])
    log(r.tail.split('\n').slice(-3).join('\n'))
    await stop()
  }
}
