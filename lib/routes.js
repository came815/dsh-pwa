// HTTP routes serving the mobile web surface (a static SPA) under /m.
// All session business goes through the harness's own /api endpoints from the
// browser, so these routes only ship bytes. Files are re-read per request so
// iterating on the UI needs no restart.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

/* 推送相关路由带鉴权：复用宿主浏览器会话 cookie（dsh-auth-*）的 HMAC 校验，
   否则 tailnet 里任何设备都能注册订阅、窃取通知内容。 */
let _authSecret = null
async function authSecret() {
  if (_authSecret) return _authSecret
  const yaml = await readFile(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const m = yaml.match(/browser-session:[\s\S]*?secret:\s*(\S+)/)
  if (!m) throw new Error('auth secret not found')
  _authSecret = m[1]
  return _authSecret
}
const b64u = (buf) => Buffer.from(buf).toString('base64url')
async function authed(req) {
  try {
    const secret = await authSecret()
    const cookie = req.headers.cookie || ''
    for (const part of cookie.split(';')) {
      const i = part.indexOf('=')
      const name = part.slice(0, i).trim(), val = part.slice(i + 1).trim()
      if (!name.startsWith('dsh-auth-')) continue
      const seg = val.split('.')
      if (seg.length !== 3 || seg[0] !== 'v1') continue
      const sig = b64u(crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(seg[1]).digest())
      if (sig !== seg[2]) continue
      const payload = JSON.parse(Buffer.from(seg[1], 'base64url').toString())
      if (payload.expiresAt && payload.expiresAt > Date.now()) return true
    }
    return false
  } catch (e) { return false }
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'cache-control': 'no-cache',
    'content-type': contentType || 'text/plain; charset=utf-8',
  })
  res.end(body)
}

async function serveFile(res, file) {
  const ext = path.extname(file)
  try {
    const body = await readFile(path.join(WEB_DIR, file))
    res.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    })
    res.end(body)
  } catch (e) {
    sendText(res, 404, 'not found: ' + file)
  }
}

/**
 * Mount the mobile surface on the host's webServer.
 * @returns a disposer that unregisters all routes.
 */
export function mountRoutes(host, push) {
  const disposers = []
  const route = (path, handler) => {
    disposers.push(host.webServer.register({ kind: 'exact', path, handler }))
  }

  route('/m', async (req, res) => serveFile(res, 'index.html'))
  route('/m/', async (req, res) => serveFile(res, 'index.html'))
  route('/m/app.js', async (req, res) => serveFile(res, 'app.js'))
  route('/m/style.css', async (req, res) => serveFile(res, 'style.css'))
  route('/m/manifest.webmanifest', async (req, res) => serveFile(res, 'manifest.webmanifest'))
  route('/m/icon.svg', async (req, res) => serveFile(res, 'icon.svg'))
  route('/m/icon-180.png', async (req, res) => serveFile(res, 'icon-180.png'))
  route('/m/icon-512.png', async (req, res) => serveFile(res, 'icon-512.png'))
  route('/m/health', async (req, res) => {
    sendText(res, 200, JSON.stringify({ ok: true, surface: 'dsh-pwa' }), 'application/json; charset=utf-8')
  })
  /* —— Web Push —— */
  route('/m/sw.js', async (req, res) => serveFile(res, 'sw.js'))
  route('/m/push/vapid', async (req, res) => {
    if (!(await authed(req))) return sendText(res, 401, 'unauthorized')
    sendText(res, 200, JSON.stringify({ publicKey: push.getVapidPublicKey() }), 'application/json; charset=utf-8')
  })
  route('/m/push/subscribe', async (req, res) => {
    if (!(await authed(req))) return sendText(res, 401, 'unauthorized')
    try {
      const body = JSON.parse(await readBody(req))
      const n = await push.addSubscription(body.subscription, body.prefs)
      sendText(res, 200, JSON.stringify({ ok: true, subscriptions: n }), 'application/json; charset=utf-8')
    } catch (e) { sendText(res, 400, 'bad request: ' + String(e.message || e)) }
  })
  route('/m/push/unsubscribe', async (req, res) => {
    if (!(await authed(req))) return sendText(res, 401, 'unauthorized')
    try {
      const body = JSON.parse(await readBody(req))
      await push.removeSubscription(body.endpoint)
      sendText(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8')
    } catch (e) { sendText(res, 400, 'bad request') }
  })
  route('/m/push/prefs', async (req, res) => {
    if (!(await authed(req))) return sendText(res, 401, 'unauthorized')
    try {
      const body = JSON.parse(await readBody(req))
      const ok = await push.setPrefs(body.endpoint, body.prefs)
      sendText(res, ok ? 200 : 404, JSON.stringify({ ok }), 'application/json; charset=utf-8')
    } catch (e) { sendText(res, 400, 'bad request') }
  })
  route('/m/push/test', async (req, res) => {
    if (!(await authed(req))) return sendText(res, 401, 'unauthorized')
    const n = await push.sendTestPush()
    sendText(res, 200, JSON.stringify({ ok: true, delivered: n, stats: push.pushStats() }), 'application/json; charset=utf-8')
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch (e) { /* ignore */ }
    }
  }
}
