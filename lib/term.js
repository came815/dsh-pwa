// 手机遥控 Mac 终端：单例 PTY（login shell）+ 环形缓冲回放 + SSE 广播。
// 设计：一个共享 shell（手机遥控场景够用），断线重连自动回放缓冲；输入/resize/控制走 POST。
import os from 'node:os'
import pty from 'node-pty'

const BUF_MAX = 256 * 1024   // 256KB 回放缓冲
let term = null              // 当前 PTY 实例
let buf = ''                 // 回放缓冲（ANSI 原文）
const subs = new Set()       // SSE 响应对象
const log = (...a) => console.log('[dsh-pwa/term]', ...a)
const logErr = (...a) => console.error('[dsh-pwa/term]', ...a)

function ensureTerm(cols, rows) {
  if (term && !term._dead) return term
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  term = pty.spawn('/bin/zsh', ['-l'], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env,
  })
  term._dead = false
  term.onData((data) => {
    buf = (buf + data).slice(-BUF_MAX)
    const msg = 'data: ' + Buffer.from(data, 'utf8').toString('base64') + '\n\n'
    for (const res of subs) { try { res.write(msg) } catch (e) { subs.delete(res) } }
  })
  term.onExit(() => { if (term) term._dead = true; log('shell exited') })
  log('shell spawned')
  return term
}

export function termStream(req, res, cols, rows) {
  ensureTerm(cols, rows)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(':ok\n\n')
  if (buf) res.write('data: ' + Buffer.from(buf, 'utf8').toString('base64') + '\n\n')   // 回放
  subs.add(res)
  const hb = setInterval(() => { try { res.write(':hb\n\n') } catch (e) {} }, 25000)
  if (hb.unref) hb.unref()
  req.on('close', () => { clearInterval(hb); subs.delete(res) })
}

export function termInput(data) {
  if (typeof data !== 'string' || !data.length) return false
  ensureTerm().write(data)
  return true
}

export function termResize(cols, rows) {
  const c = Math.max(20, Math.min(300, +cols || 80))
  const r = Math.max(4, Math.min(100, +rows || 24))
  try { ensureTerm(c, r).resize(c, r) } catch (e) { logErr('resize failed:', String(e)) }
  return { cols: c, rows: r }
}

export function termKill() {
  try { if (term) term.kill() } catch (e) {}
  term = null
  buf = ''
  return true
}

export function termAlive() { return !!(term && !term._dead) }
