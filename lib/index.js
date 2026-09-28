// dsh-pwa host entry: serves the phone-optimized web surface at /m.
// The surface itself talks to the harness's standard /api (same origin, same
// trust fence as the desktop GUI), so this plugin's only job is shipping the
// static assets — with a self-healing mount in case the webServer instance is
// re-created after us (pattern cribbed from dsh-feishu-chat).
import { mountRoutes } from './routes.js'
import { initPush, getVapidPublicKey, addSubscription, removeSubscription, setPrefs, sendTestPush, pushStats, learnTitle, noteAssistantText, notifyApproval, notifyQuestion, notifyDone } from './push.js'

export async function apply(ctx) {
  const TAG = '[dsh-pwa]'
  let disposed = false
  const log = (...a) => { if (!disposed) console.log(TAG, ...a) }
  const logErr = (...a) => { if (!disposed) console.error(TAG, ...a) }

  let routesState = { server: null, dispose: null }
  function serverKey(server) {
    // ctx.get returns a fresh tracing proxy per call, so object identity is
    // never stable; the underlying node http.Server is the per-instance
    // identity and changes only when the webServer is truly re-created.
    try {
      if (server && server.server) return server.server
    } catch (e) { /* fall through */ }
    return server
  }
  function tryMountRoutes() {
    if (disposed) return
    const server = ctx.get('webServer')
    if (!server) return
    const key = serverKey(server)
    if (routesState.server === key && routesState.dispose) return
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    try {
      const dispose = mountRoutes({ webServer: server }, { getVapidPublicKey: () => getVapidPublicKey(), addSubscription, removeSubscription, setPrefs, sendTestPush, pushStats })
      routesState = { server: key, dispose }
      log('🌐 mobile surface mounted at /m')
    } catch (e) {
      logErr('mount routes failed:', String(e))
    }
  }
  tryMountRoutes()
  const routesTimer = setInterval(tryMountRoutes, 5000)

  /* —— Web Push：事件 → 系统通知 ——
   * 完成：turn/end（session/event 流）；审批/提问：瀑布观察者（立即 next()，不挡链路）。*/
  const pushMod = { ready: false }
  initPush().then(() => { pushMod.ready = true }).catch((e) => logErr('push init failed:', String(e)))
  const offEvent = ctx.on('session/event', (session, event) => {
    if (!pushMod.ready) return
    try {
      const sid = session && session.id
      if (!sid) return
      if (event.type === 'assistant/message') {
        const c = (event.data && (event.data.message ? event.data.message.content : event.data.content)) || []
        const text = c.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        noteAssistantText(sid, text)
      } else if (event.type === 'turn/end') {
        notifyDone(sid)
      } else if (event.type === 'session/title' && event.data && event.data.title) {
        learnTitle(sid, event.data.title)
      }
    } catch (e) { /* 通知失败绝不挡事件流 */ }
  })
  const offApproval = ctx.on('approval/request', (request, next) => {
    try {
      if (pushMod.ready) {
        const sid = request && request.agent && request.agent.session && request.agent.session.id
        notifyApproval(sid, request.toolName, request.reason)
      }
    } catch (e) { /* ignore */ }
    return next()
  })
  const offQuestion = ctx.on('user-questions/request', (request, next) => {
    try {
      if (pushMod.ready) {
        const sid = request && request.agent && request.agent.session && request.agent.session.id
        notifyQuestion(sid, request.questions)
      }
    } catch (e) { /* ignore */ }
    return next()
  })
  if (routesTimer.unref) routesTimer.unref()

  log('🚀 dsh-pwa starting')

  ctx.effect(() => () => {
    disposed = true
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    clearInterval(routesTimer)
    try { offEvent() } catch (e) {}
    try { offApproval() } catch (e) {}
    try { offQuestion() } catch (e) {}
    log('🛑 dsh-pwa disposed')
  }, 'dsh-pwa: cleanup')
}
