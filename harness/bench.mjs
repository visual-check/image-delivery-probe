// One timed run: captures a list of Storybook cells with one driver, then appends a JSON line to --out.
// Every driver captures the way Story readiness and page reuse decided: goto per capture on Storybook's test path,
// the no-animation stylesheet at document start, storyFinished, then images and fonts.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: o } = parseArgs({
  options: {
    engine: { type: 'string', default: 'pw' }, // pw (launch) | pw-connect (run-server) | raw
    transport: { type: 'string', default: 'pipe' }, // raw: pipe | ws
    endpoint: { type: 'string' }, // pw-connect: run-server ws URL; raw over ws: http URL of an already running browser
    encoder: { type: 'string', default: 'png' }, // raw: png | png-fast
    workers: { type: 'string', default: '2' },
    cells: { type: 'string' }, // JSON [{ id, theme?, page? }]; default: the first --stories story ids of index.json
    stories: { type: 'string', default: '300' },
    storybook: { type: 'string' },
    base: { type: 'string', default: 'http://127.0.0.1:6400' },
    area: { type: 'string', default: 'viewport' }, // viewport | mix (page cells fill a mobile viewport, others clip to --clip)
    clip: { type: 'string', default: '' },
    viewport: { type: 'string', default: '1280x720' },
    mobile: { type: 'string', default: '393x851' },
    locale: { type: 'string', default: 'en-US' },
    tz: { type: 'string', default: 'UTC' },
    css: { type: 'string', default: '' }, // appended to the stylesheet, to hide dev overlays
    fonts: { type: 'string' }, // raw: Page.setFontFamilies params as Playwright sends them; 'none' skips
    flags: { type: 'string' }, // raw: Chromium arguments as Playwright launches them
    exe: { type: 'string' },
    label: { type: 'string', default: '' },
    out: { type: 'string' },
    save: { type: 'string' },
    deadline: { type: 'string', default: '1200000' },
    marks: { type: 'boolean', default: false }, // writes @@ markers to stderr, to split a protocol log by phase
    browser: { type: 'string', default: 'chromium' }, // pw engines: chromium | webkit
    spawn: { type: 'string' }, // raw: JSON command whose stdin/stdout carry the CDP pipe, e.g. docker run -i ...
    network: { type: 'boolean', default: false }, // raw: also send Network.enable on every page
    socks: { type: 'string' }, // host:port to run a SOCKS5 proxy on, in this process, for a browser in a container
    'socks-allow': { type: 'string', default: '' }, // comma list of host:port the proxy connects; the rest are refused
    expose: { type: 'string', default: '<loopback>' }, // pw-connect: exposeNetwork
  },
})
const workers = Number(o.workers)
const size = (s) => { const [width, height] = s.split('x').map(Number); return { width, height } }
const VIEWPORT = size(o.viewport)
const MOBILE = size(o.mobile)
const TIMEOUT = 30_000
// Raw CDP messages per phase (meaningful with 1 worker), set by the same marks
const counts = {}
let phase = 'launch'
const count = (k) => { const c = (counts[phase] ??= { n: 0, sent: 0, received: 0 }); c[k]++ }
const mark = (s) => {
  phase = s.split(' ')[0]
  if (counts[phase]) counts[phase].n++
  else counts[phase] = { n: 1, sent: 0, received: 0 }
  if (o.marks) process.stderr.write(`@@ ${s}\n`)
}

// ---- workload ----
const cells = o.cells
  ? JSON.parse(readFileSync(o.cells, 'utf8'))
  : Object.values(JSON.parse(readFileSync(path.join(o.storybook, 'index.json'), 'utf8')).entries)
      .filter((e) => e.type === 'story')
      .map((e) => e.id)
      .sort()
      .slice(0, Number(o.stories))
      .map((id) => ({ id }))
const url = (c) => `${o.base}/iframe.html?id=${c.id}&viewMode=story${c.theme ? `&globals=theme:${c.theme}` : ''}`
const keyOf = (c) => (c.theme ? `${c.id}@${c.theme}` : c.id)

// ---- scripts run in the page, identical for every driver ----
const NOANIM = '*,*::before,*::after{animation:none!important;transition:none!important}'
// Runs before any page script: adds the stylesheet and catches storyFinished from the moment the channel exists.
const INIT = `(() => {
  const css = ${JSON.stringify(NOANIM + o.css)}
  const add = () => { const s = document.createElement('style'); s.textContent = css; document.documentElement.append(s) }
  document.documentElement ? add() : document.addEventListener('readystatechange', add, { once: true })
  const vc = (window.__vc = {})
  vc.finished = new Promise((resolve) => { vc.resolve = resolve })
  let channel
  Object.defineProperty(globalThis, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    get: () => channel,
    set: (c) => { channel = c; c.on('storyFinished', (e) => vc.resolve({ status: e.status, storyId: e.storyId })) },
  })
})()`
const readyScript = (id) => `(async () => {
  const vc = window.__vc
  if (!vc) return { status: 'no hook' }
  const f = await Promise.race([vc.finished, new Promise((r) => setTimeout(() => r({ status: 'timeout' }), 10000))])
  if (f.status !== 'success') return f
  if (f.storyId !== ${JSON.stringify(id)}) return { status: 'wrong story ' + f.storyId }
  const images = Array.from(document.images)
  for (const i of images) i.loading = 'eager'
  await Promise.all(images.map((i) => i.decode().catch(() => undefined)))
  await document.fonts.ready
  return f
})()`
const measureScript = `(() => {
  const d = document.documentElement, b = d.getBoundingClientRect(), r = ${o.clip ? `document.querySelector(${JSON.stringify(o.clip)})` : 'null'}
  let box = null
  if (r) { const q = r.getBoundingClientRect(), x = Math.floor(q.left), y = Math.floor(q.top); box = { x, y, width: Math.ceil(q.right) - x, height: Math.ceil(q.bottom) - y } }
  if (box) { box.width = Math.min(box.width, innerWidth - box.x); box.height = Math.min(box.height, innerHeight - box.y) }
  return { width: Math.ceil(Math.max(d.scrollWidth, b.width)), height: Math.ceil(Math.max(d.scrollHeight, b.height)), box }
})()`
// What Playwright's animations: 'disabled' and caret: 'hide' do, for the driver that skips page.screenshot
const freezeScript = `(() => {
  if (!document.getElementById('__vc_caret')) { const s = document.createElement('style'); s.id = '__vc_caret'; s.textContent = '*,*::before,*::after{caret-color:transparent!important}'; document.documentElement.append(s) }
  for (const a of document.getAnimations()) { const t = a.effect && a.effect.getComputedTiming(); if (t && Number.isFinite(t.endTime)) a.finish(); else a.cancel() }
})()`

// ---- SOCKS5 proxy: what Playwright's exposeNetwork does, without Playwright. Connects from this host, so the
// Storybook URL resolves and routes here, as written. CONNECT only, no auth. ----
const socksStats = { connections: 0, refused: 0 }
function startSocks(listen, allow) {
  const i = listen.lastIndexOf(':')
  const allowed = new Set(allow.split(',').filter(Boolean))
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
        if (req[1] !== 1 || (allowed.size && !allowed.has(`${addr}:${port}`))) { socksStats.refused++; reply(2); c.end(); return }
        socksStats.connections++
        const up = net.connect(port, addr)
        up.once('connect', () => { reply(0); if (rest.length) up.write(rest); c.pipe(up); up.pipe(c) })
        up.on('error', () => { if (!up.readyState || up.connecting) reply(4); c.destroy() })
        c.on('close', () => up.destroy())
      })
    })
  })
  return new Promise((r) => server.listen(Number(listen.slice(i + 1)), listen.slice(0, i), () => r(server)))
}
const socksServer = o.socks ? await startSocks(o.socks, o['socks-allow']) : null

// ---- drivers: each returns { slot() -> { setViewport, goto, evaluate, capture }, close } ----
async function playwrightDriver() {
  const pw = await import('playwright-core')
  const type = pw[o.browser]
  const args = o.browser === 'chromium' ? ['--disable-skia-runtime-opts'] : []
  const browser = o.engine === 'pw-connect'
    ? await type.connect(o.endpoint, { exposeNetwork: o.expose, headers: { 'x-playwright-launch-options': JSON.stringify({ args }) } })
    : await type.launch({ args })
  const probe = await browser.newPage()
  const ua = await probe.evaluate(() => navigator.userAgent)
  await probe.context().close()
  return {
    version: browser.version(),
    async slot() {
      mark('page')
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, userAgent: `${ua} StorybookTestRunner`, locale: o.locale, timezoneId: o.tz, colorScheme: 'light', reducedMotion: 'reduce' })
      await ctx.addInitScript(INIT)
      const page = await ctx.newPage()
      return {
        setViewport: (v) => page.setViewportSize(v),
        goto: (u) => page.goto(u, { waitUntil: 'load', timeout: TIMEOUT }),
        evaluate: (s) => page.evaluate(s),
        capture: ({ clip }) => page.screenshot({ animations: 'disabled', caret: 'hide', ...(clip ? { clip } : {}) }),
      }
    },
    close: () => browser.close(),
  }
}

// Minimal CDP client over a pipe or a WebSocket, with flat sessions.
async function connectRaw() {
  let proc = null
  let dir = null
  let write
  let wsUrl
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  const onMessage = (text) => {
    count('received')
    const m = JSON.parse(text)
    if (m.id) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`))
      else p.resolve(m.result)
    } else {
      if (process.env.VC_EVENTS) process.stderr.write(`EV ${(performance.now() / 1000).toFixed(2)} ${m.sessionId?.slice(0, 6)} ${m.method} ${JSON.stringify(m.params).slice(0, 160)}\n`)
      const q = listeners.get(`${m.sessionId ?? ''}:${m.method}`)
      if (q?.length) q.shift()(m.params)
    }
  }
  const readPipe = (stream) => {
    let tail = []
    stream.on('data', (chunk) => {
      let start = 0
      let i
      while ((i = chunk.indexOf(0, start)) !== -1) {
        tail.push(chunk.subarray(start, i))
        onMessage(Buffer.concat(tail).toString('utf8'))
        tail = []
        start = i + 1
      }
      if (start < chunk.length) tail.push(chunk.subarray(start))
    })
  }
  if (o.spawn) {
    // CDP pipe carried by the child's stdin and stdout, e.g. docker run -i with fds 3 and 4 mapped to them
    const cmd = JSON.parse(o.spawn)
    proc = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d) => { err = (err + d).slice(-4096) })
    proc.on('exit', (code) => { if (code) process.stderr.write(`spawned exited ${code}: ${err}\n`) })
    readPipe(proc.stdout)
    write = (s) => { proc.stdin.write(s); proc.stdin.write('\0') }
  } else if (o.endpoint) {
    wsUrl = (await (await fetch(`${o.endpoint}/json/version`)).json()).webSocketDebuggerUrl
  } else {
    dir = mkdtempSync(path.join(tmpdir(), 'vc-raw-'))
    const flags = JSON.parse(readFileSync(o.flags, 'utf8'))
    const pipe = o.transport === 'pipe'
    const args = [...flags, '--disable-skia-runtime-opts', `--user-data-dir=${dir}`, pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0', 'about:blank']
    proc = spawn(o.exe, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    // Chromium blocks once its stderr pipe fills, so it's always drained
    let err = ''
    proc.stderr.on('data', (d) => { err = (err + d).slice(-4096) })
    if (pipe) {
      let tail = []
      proc.stdio[4].on('data', (chunk) => {
        let start = 0
        let i
        while ((i = chunk.indexOf(0, start)) !== -1) {
          tail.push(chunk.subarray(start, i))
          onMessage(Buffer.concat(tail).toString('utf8'))
          tail = []
          start = i + 1
        }
        if (start < chunk.length) tail.push(chunk.subarray(start))
      })
      write = (s) => { proc.stdio[3].write(s); proc.stdio[3].write('\0') }
    } else {
      wsUrl = await new Promise((resolve, reject) => {
        proc.stderr.on('data', () => {
          const m = err.match(/DevTools listening on (ws:\/\/\S+)/)
          if (m) resolve(m[1])
        })
        proc.on('exit', () => reject(new Error(`chrome exited: ${err}`)))
      })
    }
  }
  let sock = null
  if (wsUrl) {
    sock = new WebSocket(wsUrl)
    sock.binaryType = 'arraybuffer'
    await new Promise((r, j) => { sock.addEventListener('open', r, { once: true }); sock.addEventListener('error', j, { once: true }) })
    sock.addEventListener('message', (e) => onMessage(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')))
    write = (s) => sock.send(s)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject, method })
      count('sent')
      write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const once = (sessionId, method) => new Promise((resolve) => { const k = `${sessionId}:${method}`; (listeners.get(k) ?? listeners.set(k, []).get(k)).push(resolve) })
  return {
    send,
    once,
    close: async () => {
      if (!proc) { sock.close(); return }
      const gone = new Promise((r) => proc.once('exit', r))
      send('Browser.close').catch(() => {})
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))])
      if (o.spawn) { proc.stdin.end(); await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]); proc.kill('SIGKILL'); return }
      proc.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function rawDriver() {
  const b = await connectRaw()
  const fonts = o.fonts === 'none' ? null : JSON.parse(readFileSync(o.fonts, 'utf8'))
  const { product, userAgent } = await b.send('Browser.getVersion')
  const contexts = []
  const encoder = o.encoder === 'png-fast' ? { format: 'png', optimizeForSpeed: true } : { format: 'png' }
  return {
    version: product,
    async slot() {
      mark('page')
      const { browserContextId } = await b.send('Target.createBrowserContext', { disposeOnDetach: true })
      contexts.push(browserContextId)
      const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId })
      const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true })
      await Promise.all([
        b.send('Page.enable', {}, sessionId),
        ...(o.network ? [b.send('Network.enable', {}, sessionId)] : []),
        ...(fonts ? [b.send('Page.setFontFamilies', fonts, sessionId)] : []),
        b.send('Emulation.setUserAgentOverride', { userAgent: `${userAgent} StorybookTestRunner`, acceptLanguage: o.locale }, sessionId),
        b.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT }, sessionId),
        b.send('Emulation.setTimezoneOverride', { timezoneId: o.tz }, sessionId),
        b.send('Emulation.setLocaleOverride', { locale: o.locale }, sessionId),
        b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] }, sessionId),
        b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId),
      ])
      const evaluate = async (s) => {
        const r = await b.send('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }, sessionId)
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result.value
      }
      return {
        setViewport: (v) => b.send('Emulation.setDeviceMetricsOverride', { ...v, deviceScaleFactor: 1, mobile: false, screenWidth: v.width, screenHeight: v.height }, sessionId),
        async goto(u) {
          const loaded = b.once(sessionId, 'Page.loadEventFired')
          const r = await b.send('Page.navigate', { url: u }, sessionId)
          if (r.errorText) throw new Error(`navigate: ${r.errorText}`)
          await loaded
        },
        evaluate,
        async capture({ clip }) {
          await evaluate(freezeScript)
          const { data } = await b.send('Page.captureScreenshot', { ...encoder, fromSurface: true, captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId)
          return Buffer.from(data, 'base64')
        },
      }
    },
    close: async () => {
      for (const id of contexts) await b.send('Target.disposeBrowserContext', { browserContextId: id }).catch(() => {})
      await b.close()
    },
  }
}

// ---- run ----
const cpu0 = process.cpuUsage()
const t0 = performance.now()
const driver = await (o.engine === 'raw' ? rawDriver() : playwrightDriver())
const launchMs = performance.now() - t0
const phases = { nav: 0, ready: 0, fit: 0, capture: 0 }
const failures = []
const hashes = {}
let bytes = 0
let next = 0
let firstCapture = null
let done = 0
if (o.save) mkdirSync(o.save, { recursive: true })

const state = {}
const deadline = setTimeout(() => {
  if (o.out) appendFileSync(o.out, `${JSON.stringify({ label: o.label, aborted: true, captures: done, failures: failures.length, state, at: new Date().toISOString() })}\n`)
  console.log(`DEADLINE ${o.label} captures=${done} ${JSON.stringify(state)}`)
  process.exit(3)
}, Number(o.deadline))

async function worker(i) {
  const slot = await driver.slot()
  while (next < cells.length) {
    const cell = cells[next++]
    const key = keyOf(cell)
    state[i] = key
    mark(`capture ${key}`)
    let watchdog
    try {
      await Promise.race([
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('cell watchdog: stuck for 45 s')), 45_000) }),
        (async () => {
          const base = cell.page ? MOBILE : VIEWPORT
          let t = performance.now()
          state[i] = `${key}: nav`
          await slot.setViewport(base)
          await slot.goto(url(cell))
          phases.nav += performance.now() - t
          t = performance.now()
          state[i] = `${key}: ready`
          const status = await slot.evaluate(readyScript(cell.id))
          phases.ready += performance.now() - t
          if (status?.status !== 'success') throw new Error(`story ${status?.status}`)
          t = performance.now()
          let shot = {}
          if (o.area === 'mix') {
            // Grow the viewport for every story, so no capture reaches past it, then clip to the story's box
            let m = await slot.evaluate(measureScript)
            if (m.height > base.height) {
              await slot.setViewport({ width: base.width, height: m.height })
              m = await slot.evaluate(measureScript)
            }
            if (!cell.page && m.box) shot = { clip: m.box }
          }
          phases.fit += performance.now() - t
          t = performance.now()
          state[i] = `${key}: capture`
          const img = await slot.capture(shot)
          phases.capture += performance.now() - t
          if (firstCapture === null) firstCapture = performance.now() - t0
          bytes += img.length
          hashes[key] = createHash('sha1').update(img).digest('hex')
          if (o.save) writeFileSync(path.join(o.save, `${key.replace(/[^a-z0-9@-]/gi, '_')}.png`), img)
          done++
          if (process.env.VC_EVENTS) process.stderr.write(`DONE ${(performance.now() / 1000).toFixed(2)} ${i} ${key}\n`)
        })(),
      ])
    } catch (e) {
      failures.push({ key, error: String(e.message ?? e).slice(0, 200) })
      if (process.env.VC_EVENTS) process.stderr.write(`FAIL ${(performance.now() / 1000).toFixed(2)} ${i} ${key} ${state[i]} ${e.message}\n`)
    }
    clearTimeout(watchdog)
  }
}

const tWork = performance.now()
await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)))
const workMs = performance.now() - tWork
const wall = performance.now() - t0
clearTimeout(deadline)
mark('close')
const cpu = process.cpuUsage(cpu0)
socksServer?.close()
await Promise.race([driver.close(), new Promise((r) => setTimeout(r, 10_000))]).catch(() => {})

const record = {
  label: o.label, engine: o.engine, browserName: o.browser, network: o.network, spawned: !!o.spawn, socks: o.socks ? { ...socksStats } : null, transport: o.engine === 'raw' ? (o.endpoint ? 'ws-external' : o.transport) : o.engine === 'pw-connect' ? 'run-server' : 'pipe',
  encoder: o.engine === 'raw' ? o.encoder : 'png', fonts: o.engine === 'raw' ? (o.fonts === 'none' ? 'none' : 'playwright') : 'playwright',
  workers, cpus: process.env.CPUS ?? null, arch: process.arch, browser: driver.version,
  cells: cells.length, captures: done, failures: failures.length, failureSamples: failures.slice(0, 5),
  wallS: +(wall / 1000).toFixed(2), workS: +(workMs / 1000).toFixed(2), capturesPerS: +(done / (workMs / 1000)).toFixed(2),
  launchMs: Math.round(launchMs), firstCaptureMs: firstCapture === null ? null : Math.round(firstCapture),
  driverCpuS: +((cpu.user + cpu.system) / 1e6).toFixed(1),
  phaseMsPerCapture: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, +(v / Math.max(done, 1)).toFixed(1)])),
  cdpMessages: o.engine === 'raw' ? counts : null,
  bytesMb: +(bytes / 1048576).toFixed(1), at: new Date().toISOString(), hashes,
}
if (o.out) appendFileSync(o.out, `${JSON.stringify(record)}\n`)
const { hashes: _h, failureSamples, ...brief } = record
console.log(JSON.stringify(brief), failureSamples.length ? JSON.stringify(failureSamples) : '')
process.exit(0)
