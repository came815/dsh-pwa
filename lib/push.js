// Web Push（系统通知）：VAPID 密钥、订阅存储、聚合发送、事件→通知。
// 数据文件放 ~/.dsh/dsh-mobile-push/（VAPID 密钥 + 订阅清单 + 偏好），跟随用户配置而非插件目录。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import webpush from 'web-push'

const DIR = path.join(os.homedir(), '.dsh', 'dsh-mobile-push')
const VAPID_FILE = path.join(DIR, 'vapid.json')
const SUBS_FILE = path.join(DIR, 'subscriptions.json')

const AGG_WINDOW_MS = 5 * 60 * 1000   // 同一会话同一类通知 5 分钟内合并

const state = {
  vapid: null,          // { publicKey, privateKey }
  subs: [],             // [{ endpoint, keys: {p256dh, auth}, prefs: { done: boolean }, createdAt }]
  pending: new Map(),   // 聚合窗：key = kind:sessionId → { count, body, sessionId, kind, timer }
  lastText: new Map(),  // sessionId → 最近一条助手文本（做「回答完成」的摘要）
  titles: new Map(),    // sessionId → 标题（session/created 等时机学习）
  log: (...a) => console.log('[dsh-mobile/push]', ...a),
  logErr: (...a) => console.error('[dsh-mobile/push]', ...a),
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) { return fallback }
}
async function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(obj, null, 1))
  await rename(tmp, file)
}

export async function initPush() {
  await mkdir(DIR, { recursive: true })
  state.vapid = await readJson(VAPID_FILE, null)
  if (!state.vapid || !state.vapid.publicKey) {
    state.vapid = webpush.generateVAPIDKeys()
    await writeJsonAtomic(VAPID_FILE, state.vapid)
    state.log('generated new VAPID keypair')
  }
  state.subs = await readJson(SUBS_FILE, [])
  webpush.setVapidDetails('mailto:dsh-mobile@local', state.vapid.publicKey, state.vapid.privateKey)
  state.log('push ready:', state.subs.length, 'subscription(s)')
  return { publicKey: state.vapid.publicKey }
}

export function getVapidPublicKey() { return state.vapid && state.vapid.publicKey }

export async function addSubscription(sub, prefs) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error('invalid subscription')
  state.subs = state.subs.filter((x) => x.endpoint !== sub.endpoint)
  state.subs.push({ endpoint: sub.endpoint, keys: sub.keys, prefs: { done: !!(prefs && prefs.done) }, createdAt: Date.now() })
  await writeJsonAtomic(SUBS_FILE, state.subs)
  return state.subs.length
}

export async function removeSubscription(endpoint) {
  const before = state.subs.length
  state.subs = state.subs.filter((x) => x.endpoint !== endpoint)
  await writeJsonAtomic(SUBS_FILE, state.subs)
  return before - state.subs.length
}

export async function setPrefs(endpoint, prefs) {
  const s = state.subs.find((x) => x.endpoint === endpoint)
  if (!s) return false
  s.prefs = { ...s.prefs, done: !!(prefs && prefs.done) }
  await writeJsonAtomic(SUBS_FILE, state.subs)
  return true
}

/* 发送：失败的订阅（404/410 失效）顺手清理 */
async function sendTo(sub, payload) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 3600 })
    return true
  } catch (e) {
    const code = e && e.statusCode
    if (code === 404 || code === 410) {
      state.subs = state.subs.filter((x) => x.endpoint !== sub.endpoint)
      writeJsonAtomic(SUBS_FILE, state.subs).catch(() => {})
      state.log('pruned dead subscription', code)
    } else {
      state.logErr('send failed:', code || e.message)
    }
    return false
  }
}

/* kind: 'approval' | 'question' | 'done' | 'test' */
async function deliver(key, payload, filter) {
  const subs = state.subs.filter(filter || (() => true))
  if (!subs.length) return 0
  let ok = 0
  for (const sub of subs) if (await sendTo(sub, payload)) ok++
  return ok
}

/* 聚合：同 key 5 分钟内只发一条，数字合并；窗口结束发出最终版（tag 相同，iOS 覆盖前一条） */
function aggregate(key, payload, filter) {
  const cur = state.pending.get(key)
  if (cur) {
    cur.count++
    cur.payload = payload
    clearTimeout(cur.timer)
    cur.timer = setTimeout(() => flushAggregated(key), AGG_WINDOW_MS)
    if (cur.timer.unref) cur.timer.unref()
    return
  }
  const timer = setTimeout(() => flushAggregated(key), AGG_WINDOW_MS)
  if (timer.unref) timer.unref()   // 聚合计时器不阻止宿主进程退出
  state.pending.set(key, { count: 1, payload, filter, timer })
  deliverNow(key)
}
async function deliverNow(key) {
  const cur = state.pending.get(key)
  if (!cur) return
  await deliver(key, cur.payload, cur.filter)
}
async function flushAggregated(key) {
  const cur = state.pending.get(key)
  if (!cur) return
  state.pending.delete(key)
  if (cur.count <= 1) return   // 只有一条：首发已经送了
  const p = { ...cur.payload, body: cur.payload.body, title: cur.payload.title.replace(/。$/, '') + `（共 ${cur.count} 条）` }
  await deliver(key, p, cur.filter)
}

function sessionLabel(sessionId) {
  const t = state.titles.get(sessionId)
  if (t) return t
  return '会话 ' + String(sessionId).slice(-6)
}

/* —— 事件入口 —— */
export function learnTitle(sessionId, title) { if (sessionId && title) state.titles.set(sessionId, title) }

export function noteAssistantText(sessionId, text) {
  if (sessionId && text && text.trim()) state.lastText.set(sessionId, text.replace(/\n+/g, ' ').trim().slice(0, 120))
}

export function notifyApproval(sessionId, toolName, reason) {
  const label = sessionLabel(sessionId)
  const tool = toolName || '工具'
  aggregate('approval:' + sessionId, {
    title: '⚠️ 等你审批',
    body: label + ' · ' + tool + (reason ? '：' + String(reason).slice(0, 60) : ' 需要批准'),
    tag: 'approval-' + sessionId,
    url: '/m/#/s/' + sessionId,
  })
}

export function notifyQuestion(sessionId, questions) {
  const label = sessionLabel(sessionId)
  const first = (questions && questions[0] && questions[0].question) || '有一个问题等你回答'
  aggregate('question:' + sessionId, {
    title: '❓ 向你提问',
    body: label + ' · ' + String(first).slice(0, 60),
    tag: 'question-' + sessionId,
    url: '/m/#/s/' + sessionId,
  })
}

export function notifyDone(sessionId) {
  const label = sessionLabel(sessionId)
  const preview = state.lastText.get(sessionId) || ''
  aggregate('done:' + sessionId, {
    title: '✅ 回答完成',
    body: label + (preview ? ' · ' + preview : ' 已就绪，点击查看'),
    tag: 'done-' + sessionId,
    url: '/m/#/s/' + sessionId,
  }, (sub) => !!(sub.prefs && sub.prefs.done))   // 「完成也提醒」默认关：只发给开了的订阅
}

export async function sendTestPush() {
  return deliver('test', {
    title: '🔔 测试通知',
    body: 'dsh-mobile 推送链路通了：跑完、审批、提问都会这样提醒你',
    tag: 'test',
    url: '/m/',
  })
}

export function pushStats() {
  return { subscriptions: state.subs.length, withDonePref: state.subs.filter((s) => s.prefs && s.prefs.done).length, pendingAgg: state.pending.size }
}
