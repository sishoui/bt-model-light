// 自动同步协调器（全局单例）：修改即推送的中枢。
//
// 页面每次有效改动 → 落盘 Storage（页面做）→ schedule(deviceId, config)：
//   1. 500ms 防抖合并，同一时刻只允许一个在途请求，新改动排队发最新快照；
//   2. 未连接时状态置 local（仅本机），pending 保留，连接建立后补发；
//   3. 下发失败静默重试 2 次（1s / 2s），仍失败置 failed 等用户点重试；
//   4. hash 去重：与上次成功下发的快照相同则跳过（固件 WRITE_CONFIG 幂等，
//      去重只为省空口流量）。
//
// 单例状态挂 globalThis slot（与 bleClient 的 __btBleClient 同模式）：
// jest.isolateModules 下页面副本与测试副本共享同一协调器。
// 状态订阅供页面顶部状态条使用：syncing / synced / failed / local（idle 不显示）。

'use strict'

const { getCurrentBleClient } = require('./bleClient')
const { CMD } = require('./protocol_gen')
const { encodeConfigBlob } = require('./configCodec')
const { logError } = require('./errorHandler')

const DEBOUNCE_MS = 500
const RETRY_DELAYS = [1000, 2000] // 静默重试间隔；用尽后置 failed

// FNV-1a 32bit：blob → hash 字符串（去重键）。
function _hash(blob) {
  let h = 0x811c9dc5
  for (let i = 0; i < blob.length; i++) {
    h ^= blob[i]
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16)
}

function _now() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 全局单例 slot：isolateModules 副本共享。
function _store() {
  const root =
    typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : {}
  if (!root.__btAutoSync) {
    root.__btAutoSync = {
      state: 'idle', // idle | syncing | synced | failed | local
      at: '',
      deviceId: null,
      pending: null, // { deviceId, blob, hash } 待下发/补发的最新快照
      lastSyncedHash: {}, // deviceId -> hash（跨设备）
      timer: null,
      retryTimer: null,
      retryCount: 0,
      inFlight: false,
      queued: false, // 在途期间到达的新快照
      client: null,
      offState: null,
      subs: new Set(),
    }
  }
  return root.__btAutoSync
}

function _emit(S) {
  const snap = { state: S.state, at: S.at, deviceId: S.deviceId }
  for (const fn of S.subs) {
    try {
      fn(snap)
    } catch (e) {
      /* 订阅者异常隔离（同 bleClient） */
    }
  }
}

function _setState(S, state, at) {
  S.state = state
  if (at !== undefined) S.at = at
  _emit(S)
}

// 订阅状态变化（页面状态条）；返回退订函数。
function subscribe(fn) {
  const S = _store()
  S.subs.add(fn)
  return () => S.subs.delete(fn)
}

// 订阅当前 client 的连接翻转（client 单例可能被 device-list/mine 替换）。
function attach() {
  const S = _store()
  const client = getCurrentBleClient()
  if (!client || client === S.client) return
  if (S.offState) S.offState()
  S.client = client
  S.offState = null
  if (typeof client.onConnectionStateChange === 'function') {
    S.offState = client.onConnectionStateChange((res) => {
      if (res.connected) onConnected()
      else if (S.state === 'syncing' || S.state === 'synced') _setState(S, 'local')
    })
  }
}

// 页面每次有效改动后调用：config 已由页面落盘，这里安排防抖下发。
function schedule(deviceId, config) {
  const S = _store()
  S.deviceId = deviceId
  let blob
  try {
    blob = encodeConfigBlob(config)
  } catch (e) {
    return // 编码失败静默（页面已校验过，这里是双保险）
  }
  const hash = _hash(blob)
  if (S.lastSyncedHash[deviceId] === hash) return // 与已同步快照相同：无空口流量
  S.pending = { deviceId, blob, hash }
  S.retryCount = 0
  if (S.retryTimer) {
    clearTimeout(S.retryTimer)
    S.retryTimer = null
  }
  attach()
  const client = getCurrentBleClient()
  if (!client || !client.connected) {
    _setState(S, 'local') // 仅本机；pending 保留，连接后补发
    return
  }
  _armDebounce(S)
}

// 连接建立：补发未同步快照（hash 未变则跳过）。
// 补发走防抖定时器而非立即 flush：connect() 在 GET_VERSION 发出前就会触发
// 连接事件，立即下发会与 GET_VERSION 分片交错写坏空口字节流（CRC 全乱）。
function onConnected() {
  const S = _store()
  attach()
  if (!S.pending) return
  if (S.pending.hash === S.lastSyncedHash[S.pending.deviceId]) {
    S.pending = null
    return
  }
  _armDebounce(S)
}

// 安排防抖下发（500ms 后 flush）；重复调用重置窗口。
function _armDebounce(S) {
  if (S.timer) clearTimeout(S.timer)
  S.timer = setTimeout(() => {
    S.timer = null
    _flush()
  }, DEBOUNCE_MS)
  _setState(S, 'syncing')
}

async function _flush() {
  const S = _store()
  if (S.inFlight) {
    S.queued = true // 在途：等当前完成发最新快照
    return
  }
  if (!S.pending) return
  const client = getCurrentBleClient()
  if (!client || !client.connected) {
    _setState(S, 'local')
    return
  }
  S.inFlight = true
  _setState(S, 'syncing')
  const job = S.pending
  try {
    await client.sendCmd(CMD.WRITE_CONFIG, Array.from(job.blob))
    await client.sendCmd(CMD.APPLY, [])
    S.lastSyncedHash[job.deviceId] = job.hash
    S.pending = null
    S.inFlight = false
    _setState(S, 'synced', _now())
  } catch (err) {
    S.inFlight = false
    S.queued = false // 重试定时器会发最新 pending
    logError(err, '自动同步下发')
    _scheduleRetry(S)
    return
  }
  if (S.queued) {
    S.queued = false
    _flush()
  }
}

function _scheduleRetry(S) {
  if (S.retryCount >= RETRY_DELAYS.length) {
    _setState(S, 'failed')
    return
  }
  const delay = RETRY_DELAYS[S.retryCount]
  S.retryCount++
  _setState(S, 'syncing')
  S.retryTimer = setTimeout(() => {
    S.retryTimer = null
    _flush()
  }, delay)
}

// 状态条「失败·重试」点击：立即重发 pending。
function retry() {
  const S = _store()
  if (!S.pending) return
  S.retryCount = 0
  if (S.retryTimer) {
    clearTimeout(S.retryTimer)
    S.retryTimer = null
  }
  _flush()
}

// 测试重置：清定时器/订阅/单例状态。
function reset() {
  const S = _store()
  if (S.timer) clearTimeout(S.timer)
  if (S.retryTimer) clearTimeout(S.retryTimer)
  if (S.offState) S.offState()
  S.state = 'idle'
  S.at = ''
  S.deviceId = null
  S.pending = null
  S.lastSyncedHash = {}
  S.timer = null
  S.retryTimer = null
  S.retryCount = 0
  S.inFlight = false
  S.queued = false
  S.client = null
  S.offState = null
  S.subs.clear()
}

module.exports = { schedule, onConnected, subscribe, retry, reset }