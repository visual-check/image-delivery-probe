// Static server for a Storybook build, files preloaded into memory, in its own process apart from the driver.
// Like a static host: documents and the index revalidate, everything else stays cached.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const [root, port = '6400', host = '127.0.0.1'] = process.argv.slice(2)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.mp4': 'video/mp4' }
const files = new Map()
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else files.set(`/${path.relative(root, full).split(path.sep).join('/')}`, { body: readFileSync(full), type: types[path.extname(name).toLowerCase()] ?? 'application/octet-stream' })
  }
}
walk(root)
http
  .createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = files.get(pathname)
    if (!file) return res.writeHead(404).end()
    const cache = /\.(html|json)$/.test(pathname) ? 'no-cache' : 'public, max-age=31536000, immutable'
    res.writeHead(200, { 'content-type': file.type, 'content-length': file.body.length, 'cache-control': cache })
    res.end(file.body)
  })
  .listen(Number(port), host, () => console.log(`serving ${files.size} files on ${host}:${port}`))
