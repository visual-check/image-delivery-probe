// Shared by the sandbox probes for visual-check#51: the Storybook server, one bench run, and a look at the browser's
// renderer processes while it captures.
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const H = path.dirname(fileURLToPath(import.meta.url))
export const OFFLINE = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
export const CSS = 'html>:not(head):not(body){display:none!important}'

export async function serve(sb, log) {
  const p = spawn(process.execPath, [path.join(H, 'serve.mjs'), sb, '6400', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { log(String(d)); if (String(d).includes('serving')) resolve() })
    p.on('exit', (c) => reject(new Error(`serve exited ${c}`)))
  })
  return () => new Promise((r) => { p.once('exit', r); p.kill() })
}

// Runs bench.mjs; calls onTick(seconds) at 15 s and 30 s so the caller can look at the browser's processes.
export function bench(args, onTick) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(H, 'bench.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CPUS: '2' } })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    const timers = [15, 30].map((s) => setTimeout(() => onTick?.(s), s * 1000))
    p.on('exit', (code) => { timers.forEach(clearTimeout); resolve({ code, tail: out.slice(-1500) }) })
  })
}

// Renderer processes of a headless shell started on this machine, and what shows whether each one is sandboxed.
export function renderers() {
  if (process.platform === 'linux') {
    const self = readlinkSync('/proc/self/ns/user')
    const found = []
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      let cmd
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0') } catch { continue }
      if (!cmd[0]?.includes('chrome-headless-shell') || !cmd.includes('--type=renderer')) continue
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8')
        const field = (k) => status.match(new RegExp(`^${k}:\\s*(\\S+)`, 'm'))?.[1]
        found.push({ pid: +pid, noSandboxFlag: cmd.includes('--no-sandbox'), seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs'), uid: field('Uid'), ownUserNs: readlinkSync(`/proc/${pid}/ns/user`) !== self })
      } catch {}
    }
    return found
  }
  if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout
    return ps.split('\n').filter((l) => l.includes('chrome-headless-shell') && l.includes('--type=renderer'))
      .map((l) => ({ pid: +l.trim().split(/\s+/)[0], noSandboxFlag: l.includes('--no-sandbox'), seatbelt: /--seatbelt-client/.test(l) }))
  }
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='chrome-headless-shell.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"], { encoding: 'utf8' }).stdout
  return ps.split('\n').filter((l) => l.includes('--type=renderer'))
    .map((l) => ({ pid: +l.trim().split(/\s+/)[0], noSandboxFlag: l.includes('--no-sandbox') }))
}
