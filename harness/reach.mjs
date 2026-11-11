// Whether a browser in a container reaches each URL. Spawns a command (docker run -i ...) whose stdin/stdout carry
// Chromium's CDP pipe, opens one page and navigates it to each URL in turn. Dependency-free.
//   node reach.mjs --label <l> --spawn '<json argv>' --urls <u1,u2> [--socks <host:port>] [--out <file.jsonl>]
// --socks runs a SOCKS5 proxy (CONNECT only, no auth, every destination) in this process, as visual-check would.
// Prints one JSON line per run: per URL, the navigation's error or the page title, and the proxy's connections.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import { parseArgs } from 'node:util'

const { values: o } = parseArgs({
  options: {
    label: { type: 'string', default: '' },
    spawn: { type: 'string' },
    urls: { type: 'string' },
    socks: { type: 'string' },
    out: { type: 'string' },
  },
})

const socks = { listen: o.socks ?? null, error: null, connections: [] }
if (o.socks) {
  const i = o.socks.lastIndexOf(':')
  const server = net.createServer((c) => {
    c.on('error', () => {})
    c.once('data', () => {
      c.write(Buffer.from([5, 0]))
      c.once('data', (req) => {
        const atyp = req[3]
        let addr
        let off
        if (atyp === 1) { addr = Array.from(req.subarray(4, 8)).join('.'); off = 8 }
        else if (atyp === 3) { addr = req.subarray(5, 5 + req[4]).toString(); off = 5 + req[4] }
        else { addr = Array.from({ length: 8 }, (_, k) => req.readUInt16BE(4 + 2 * k).toString(16)).join(':'); off = 20 }
        const port = req.readUInt16BE(off)
        const rest = req.subarray(off + 2)
        const reply = (code) => c.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
        const record = { from: c.remoteAddress, to: `${addr}:${port}`, ok: false }
        socks.connections.push(record)
        const up = net.connect(port, addr)
        up.once('connect', () => { record.ok = true; reply(0); if (rest.length) up.write(rest); c.pipe(up); up.pipe(c) })
        up.on('error', (e) => { record.error = e.code; if (up.connecting) reply(5); c.destroy() })
        c.on('close', () => up.destroy())
      })
    })
  })
  await new Promise((resolve) => {
    server.once('error', (e) => { socks.error = e.code; resolve() })
    server.listen(Number(o.socks.slice(i + 1)), o.socks.slice(0, i), resolve)
  })
}

const argv = JSON.parse(o.spawn)
const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-3000) })
child.stdin.on('error', () => {})
let nextId = 1
const pending = new Map()
const waiters = []
let buf = Buffer.alloc(0)
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  let i
  while ((i = buf.indexOf(0)) !== -1) {
    const m = JSON.parse(buf.subarray(0, i).toString('utf8'))
    buf = buf.subarray(i + 1)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else for (const w of waiters.splice(0)) if (!w(m)) waiters.push(w)
  }
})
const exited = new Promise((r) => child.on('exit', (code) => r(code)))
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
  child.stdin.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
})
const event = (method, sessionId, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms)
  waiters.push((m) => { if (m.method === method && m.sessionId === sessionId) { clearTimeout(t); resolve(m.params); return true } return false })
})
const within = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`${what}: timeout`)), ms))])

const result = { label: o.label, browser: null, results: [], socks, error: null, at: new Date().toISOString() }
try {
  result.browser = (await within(send('Browser.getVersion'), 120_000, 'launch')).product
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  for (const url of o.urls.split(',')) {
    const t0 = performance.now()
    const r = { url, error: null, title: null, href: null, ms: null }
    try {
      const loaded = event('Page.loadEventFired', sessionId, 20_000)
      const nav = await within(send('Page.navigate', { url }, sessionId), 25_000, 'navigate')
      if (nav.errorText) r.error = nav.errorText
      else {
        await loaded
        const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify([document.title, location.href])', returnByValue: true }, sessionId)
        ;[r.title, r.href] = JSON.parse(ev.result.value)
      }
    } catch (e) {
      r.error = String(e.message ?? e)
    }
    r.ms = Math.round(performance.now() - t0)
    result.results.push(r)
  }
  await within(send('Browser.close'), 10_000, 'close').catch(() => {})
} catch (e) {
  result.error = String(e.message ?? e)
  result.stderr = stderr
}
child.stdin.end()
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => { child.kill('SIGKILL'); r('killed') }, 15_000))])
result.exit = code
const line = JSON.stringify(result)
if (o.out) appendFileSync(o.out, `${line}\n`)
console.log(line)
process.exit(0)
