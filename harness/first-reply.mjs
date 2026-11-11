// Time from spawning a command (docker run -i ...) whose stdin/stdout carry Chromium's CDP pipe to the reply to
// Browser.getVersion. Dependency-free. Sends the request at once; it waits in the pipe until the browser reads it.
//   node first-reply.mjs '<json argv>'   prints {"ms":..,"product":".."}; exits 1 on failure or after 120 s
import { spawn } from 'node:child_process'

const argv = JSON.parse(process.argv[2])
const t0 = performance.now()
const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
let err = ''
let out = Buffer.alloc(0)
let done = false
const finish = (code, record) => {
  if (done) return
  done = true
  console.log(JSON.stringify(record))
  child.stdin.end()
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000)
  child.once('exit', () => { clearTimeout(kill); process.exit(code) })
}
child.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
child.stdout.on('data', (d) => {
  out = Buffer.concat([out, d])
  const i = out.indexOf(0)
  if (i === -1) return
  const ms = performance.now() - t0
  const m = JSON.parse(out.subarray(0, i).toString('utf8'))
  child.stdin.write(`${JSON.stringify({ id: 2, method: 'Browser.close' })}\0`)
  finish(m.result ? 0 : 1, { ms: Math.round(ms), product: m.result?.product ?? null, error: m.error ?? null })
})
child.on('exit', (code) => { if (!done) { done = true; console.log(JSON.stringify({ ms: null, exit: code, stderr: err })); process.exit(1) } })
child.stdin.on('error', () => {})
child.stdin.write(`${JSON.stringify({ id: 1, method: 'Browser.getVersion' })}\0`)
setTimeout(() => { if (!done) { done = true; console.log(JSON.stringify({ ms: null, timeout: true, stderr: err })); child.kill('SIGKILL'); process.exit(1) } }, 120_000)
