// 只为了在本地用 http 打开 tools/fixture.html（Playwright 不允许 file:// 协议）
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.join(__dirname, '..')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0])
  // 夹具要挂在 /web/geek/jobs 下：插件靠路径判断「这是不是岗位列表页」
  const target = /^\/web\/geek\//.test(pathname) ? 'tools/fixture.html' : pathname.replace(/^\/+/, '')
  const file = path.join(ROOT, target)
  // 用 path.relative 判边界：startsWith 会让兄弟目录（boss-auto-apply-x）混进来
  const rel = path.relative(ROOT, file)
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end('forbidden'); return }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
})
server.listen(8731, '127.0.0.1', () => console.log('fixture server on http://127.0.0.1:8731/web/geek/jobs'))
