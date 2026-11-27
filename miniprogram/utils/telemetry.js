// 遥测打点（ADR-0037）：小程序 → 后端 /telemetry 的批量上报。
//
// 设计要点：
//   1. **绝不阻塞业务**：track() 只入内存队列立即返回，网络请求异步触发；
//   2. **合并上报**：攒 3s 或满 20 条发一次，减少空口/流量消耗（弱网更明显）；
//   3. **上限保护**：队列最多 100 条，超出丢最旧（宁可少数据，不可涨内存）；
//   4. 指标名必须与后端白名单一致（server/src/telemetry.js 的 METRICS）；
//      本地不重复维护白名单——写错了后端会静默丢弃（rejected 计数）。
//
// 隐私：只发指标名/数值/维度（deviceId、错误码），不发配置内容、不发昵称头像。

'use strict'

const api = require('./apiClient')

const FLUSH_MS = 3000
const BATCH_MAX = 20
const QUEUE_MAX = 100

// 进程级队列（页面/工具各自 require 也是同一份）。
const QUEUE_KEY = '__btTelemetryQueue'
const TIMER_KEY = '__btTelemetryTimer'

function _root() {
  return typeof globalThis !== 'undefined' ? globalThis : global
}

function _queue() {
  const root = _root()
  if (!root[QUEUE_KEY]) root[QUEUE_KEY] = []
  return root[QUEUE_KEY]
}

function _clearTimer() {
  const root = _root()
  if (root[TIMER_KEY]) {
    clearTimeout(root[TIMER_KEY])
    root[TIMER_KEY] = null
  }
}

// 入队一条。value 默认 1（计数型指标）。
function track(metric, opts) {
  const o = opts || {}
  const q = _queue()
  q.push({
    metric: String(metric),
    dim: o.dim === undefined || o.dim === null ? '' : String(o.dim).slice(0, 64),
    value: o.value === undefined ? 1 : Number(o.value),
    at: Date.now(),
  })
  while (q.length > QUEUE_MAX) q.shift()
  _schedule()
}

// 便捷：错误打点（dim = 错误码，便于后台按码看分布）。
function trackError(code, context) {
  const dim = code === undefined || code === null || code === '' ? String(context || 'unknown') : String(code)
  track('error', { dim })
}

function _schedule() {
  const root = _root()
  if (root[TIMER_KEY]) return
  root[TIMER_KEY] = setTimeout(() => {
    root[TIMER_KEY] = null
    flush()
  }, FLUSH_MS)
}

// 立即发一批（最多 BATCH_MAX 条）。返回 Promise<{accepted,rejected}>；
// 失败时把条目放回队首（不无限重试，下次 flush 再试）。
function flush() {
  const q = _queue()
  if (!q.length) return Promise.resolve({ accepted: 0, rejected: 0 })
  const batch = q.splice(0, BATCH_MAX)
  return api
    .request('/telemetry', { method: 'POST', data: { events: batch } })
    .then((r) => r || { accepted: 0, rejected: 0 })
    .catch(() => {
      // 网络失败：放回去（保留最新，避免队列被旧数据占满）。
      const merged = batch.concat(_queue())
      const root = _root()
      root[QUEUE_KEY] = merged.slice(-QUEUE_MAX)
      return { accepted: 0, rejected: 0, failed: true }
    })
}

// 应用退出/切后台前调用：把剩余条目发出去（尽力，不保证送达）。
function flushNow() {
  _clearTimer()
  return flush()
}

// 测试钩子：重置队列与定时器（模块级状态，跨用例必须清）。
function resetTelemetry() {
  _clearTimer()
  const root = _root()
  root[QUEUE_KEY] = []
}

function pendingCount() {
  return _queue().length
}

module.exports = {
  FLUSH_MS,
  BATCH_MAX,
  QUEUE_MAX,
  track,
  trackError,
  flush,
  flushNow,
  resetTelemetry,
  pendingCount,
}
