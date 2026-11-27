// HTTP 小工具：统一响应体、错误兜底、审计日志、内存限流。
//
// 统一错误体 `{ error: { code, message } }`：小程序端只读 message 直接展示，
// 不解析 code（code 供后台与测试定位）。

'use strict'

const { nowSec } = require('./db')

// ---- 响应 ------------------------------------------------------------------

function json(res, status, body) {
  res.status(status)
  res.set('Cache-Control', 'no-store')
  res.json(body)
}

function ok(res, body) {
  json(res, 200, body === undefined ? { ok: true } : body)
}

function fail(res, status, code, message) {
  json(res, status, { error: { code, message } })
}

// 路由回调里抛出的错误统一在这里转响应：带 status 的按 status 处理，
// 其余按 500 且对外只说"服务端错误"（细节进日志，不泄漏内部结构）。
function handleError(res, err, log) {
  const status = Number(err && err.status) || 500
  if (status >= 500 && log) log.error('request failed', { message: err && err.message })
  const message = status >= 500 ? '服务端错误，请稍后重试' : String((err && err.message) || '请求失败')
  fail(res, status, (err && err.code) || (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'), message)
}

// ---- 日志 ------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function createLogger(level) {
  const min = LEVELS[level] || LEVELS.info
  const emit = (name) => (msg, extra) => {
    if (LEVELS[name] < min) return
    const line = `[${new Date().toISOString()}] ${name} ${msg}`
    // 绝不打印整个请求体/token：extra 只放白名单字段（调用方负责）。
    if (extra === undefined) console[name === 'debug' ? 'log' : name](line)
    else console[name === 'debug' ? 'log' : name](line, JSON.stringify(extra))
  }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}

// ---- 审计日志 ---------------------------------------------------------------

function audit(db, actor, action, target, detail, ip) {
  db.prepare('insert into audit_log (actor, action, target, detail, ip, at) values (?, ?, ?, ?, ?, ?)').run(
    String(actor || ''),
    String(action || ''),
    String(target || ''),
    typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
    String(ip || ''),
    nowSec(),
  )
}

// ---- 限流（单进程内存） ------------------------------------------------------
//
// 只为挡住"有人拿域名狂打登录接口"这种最低级滥用；反向代理层没有限流模块，
// 也不值得为这个量级引入 redis。key 命中计数，窗口结束清零。

function createRateLimiter({ limit, windowMs }) {
  const hits = new Map()
  return function hit(key) {
    const now = Date.now()
    const cur = hits.get(key)
    if (!cur || cur.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    cur.count += 1
    if (cur.count > limit) return false
    return true
  }
}

// ---- 入参校验 ---------------------------------------------------------------

const NICKNAME_MAX = 32
const DEVICE_NAME_MAX = 64
const DEVICE_ID_MAX = 128
const SEARCH_MAX = 64

function strField(value, { max, allowEmpty = false } = {}) {
  if (value === undefined || value === null) return allowEmpty ? '' : null
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!allowEmpty && !v) return null
  if (max && v.length > max) return v.slice(0, max)
  return v
}

function intField(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback
  if (n < min || n > max) return fallback
  return n
}

function pageQuery(query, { defaultSize = 20, maxSize = 100 } = {}) {
  const page = Math.max(1, intField(query.page, { min: 1, fallback: 1 }) || 1)
  const size = Math.min(maxSize, Math.max(1, intField(query.size, { min: 1, fallback: defaultSize }) || defaultSize))
  return { page, size, offset: (page - 1) * size }
}

module.exports = {
  json,
  ok,
  fail,
  handleError,
  createLogger,
  audit,
  createRateLimiter,
  strField,
  intField,
  pageQuery,
  NICKNAME_MAX,
  DEVICE_NAME_MAX,
  DEVICE_ID_MAX,
  SEARCH_MAX,
}
