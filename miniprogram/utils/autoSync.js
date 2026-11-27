// 自动同步协调器（全局单例）：修改即推送的中枢。
//
// 页面每次有效改动 → 落盘 Storage（页面做）→ schedule(deviceId, config)：
//   1. 500ms 防抖合并，同一时刻只允许一个在途请求，新改动排队发最新快照；
//      离散动作（引脚开关等，opts.immediate）跳过防抖立即下发——开关点一下
//      就不该再等合并窗口；
//   2. 未连接时状态置 local（仅本机），pending 保留，连接建立后补发；
//   3. 下发失败静默重试 2 次（1s / 2s），仍失败置 failed 等用户点重试；
//   4. hash 去重：与上次成功下发的快照相同则跳过（固件 WRITE_CONFIG 幂等，
//      去重只为省空口流量）。
//
// 整机开关/整机亮度（ADR-0031 / ADR-0032）走同一个出口：schedulePower /
// scheduleBrightness 各只发一条 1 字节命令（SET_POWER / SET_BRIGHTNESS），不重发
// 整份配置、不碰 Storage。它们与配置下发共用 in-flight 串行：同一时刻只有一条命令
// 在写空口，避免分片交错写坏字节流（同 GET_VERSION 与配置下发的关系）。
//
// 单例状态挂 globalThis slot（与 bleClient 的 __btBleClient 同模式）：
// jest.isolateModules 下页面副本与测试副本共享同一协调器。
// 状态订阅供页面顶部状态条使用：syncing / synced / failed / local（idle 不显示）。

'use strict'

const { getCurrentBleClient } = require('./bleClient')
const { CMD } = require('./protocol_gen')
const { encodeConfigBlob } = require('./configCodec')
const { logError } = require('./errorHandler')
const telemetry = require('./telemetry')

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
      pendingPower: null, // { deviceId, on } 待下发/补发的整机开关（ADR-0032）
      lastSentPower: {}, // deviceId -> on
      pendingBrightness: null, // { deviceId, value } 待下发/补发的整机亮度（ADR-0031）
      lastSentBrightness: {}, // deviceId -> value（与配置同样的去重）
      timer: null,
      retryTimer: null,
      retryCount: 0,
      inFlight: false,
      queued: false, // 在途期间到达的新快照
      paused: false, // OTA 升级期间暂停（ADR-0034）：只收 pending 不发空口
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

// 页面每次有效改动后调用：config 已由页面落盘，这里安排下发。
// opts.immediate：离散动作（开关等）跳过 500ms 防抖立即下发；连续编辑保持防抖合并。
function schedule(deviceId, config, opts) {
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
  if (opts && opts.immediate) {
    if (S.timer) {
      clearTimeout(S.timer) // 丢掉还在等的防抖窗口，立即发最新快照
      S.timer = null
    }
    _flush()
    return
  }
  _armDebounce(S)
}

// 整机亮度（ADR-0031）：落盘由页面做，这里只安排 SET_BRIGHTNESS 下发。
// 拖动中每个事件都调一次：与上次成功下发的值相同则跳过，在途则合并为
// "最新值待发"——不节流也能自然限速（发多快取决于空口）。
function scheduleBrightness(deviceId, value) {
  const S = _store()
  const v = Math.round(Number(value))
  if (!isFinite(v) || v < 0 || v > 255) return // 脏值静默（页面已归一化，这里是双保险）
  S.deviceId = deviceId
  if (S.lastSentBrightness[deviceId] === v) return // 已下发同值：无空口流量
  if (S.pendingBrightness && S.pendingBrightness.value === v) return // 已在待发队列
  S.pendingBrightness = { deviceId, value: v }
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
  _flush()
}

// 整机开关（ADR-0032）：落盘由页面做，这里只安排 SET_POWER 下发。
// 关 = 设备输出全黑，但**不改各引脚自己的开关状态**——开机后各引脚按原状态恢复。
function schedulePower(deviceId, on) {
  const S = _store()
  const v = !!on
  S.deviceId = deviceId
  if (S.lastSentPower[deviceId] === v) return // 已下发同值：无空口流量
  if (S.pendingPower && S.pendingPower.on === v) return // 已在待发队列
  S.pendingPower = { deviceId, on: v }
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
  _flush()
}

// 连接建立：补发未同步的快照与整机状态（未变则跳过）。
// 补发走防抖定时器而非立即 flush：connect() 在 GET_VERSION 发出前就会触发
// 连接事件，立即下发会与 GET_VERSION 分片交错写坏空口字节流（CRC 全乱）。
function onConnected() {
  const S = _store()
  attach()
  if (S.pending && S.pending.hash === S.lastSyncedHash[S.pending.deviceId]) {
    S.pending = null
  }
  if (S.pendingPower && S.lastSentPower[S.pendingPower.deviceId] === S.pendingPower.on) {
    S.pendingPower = null
  }
  if (
    S.pendingBrightness &&
    S.lastSentBrightness[S.pendingBrightness.deviceId] === S.pendingBrightness.value
  ) {
    S.pendingBrightness = null
  }
  if (!S.pending && !S.pendingPower && !S.pendingBrightness) return
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

// 下一个待发 job：整机开关 > 整机亮度 > 配置。
// 整机命令都是 1 字节、用户正盯着灯看，先发；配置放最后（它最重且会触发重渲染）。
// 返回 null 表示无待发。
function _nextJob(S) {
  if (S.pendingPower) {
    return { kind: 'power', deviceId: S.pendingPower.deviceId, on: S.pendingPower.on }
  }
  if (S.pendingBrightness) {
    return { kind: 'brightness', deviceId: S.pendingBrightness.deviceId, value: S.pendingBrightness.value }
  }
  if (S.pending) {
    return { kind: 'config', deviceId: S.pending.deviceId, blob: S.pending.blob, hash: S.pending.hash }
  }
  return null
}

async function _flush() {
  const S = _store()
  if (S.paused) return // OTA 升级中：保留 pending，升级结束后 unpause 再发
  if (S.inFlight) {
    S.queued = true // 在途：等当前完成发最新 job
    return
  }
  const job = _nextJob(S)
  if (!job) return
  const client = getCurrentBleClient()
  if (!client || !client.connected) {
    _setState(S, 'local')
    return
  }
  S.inFlight = true
  _setState(S, 'syncing')
  try {
    if (job.kind === 'power') {
      await client.sendCmd(CMD.SET_POWER, [job.on ? 1 : 0])
      S.lastSentPower[job.deviceId] = job.on
      if (S.pendingPower && S.pendingPower.on === job.on) S.pendingPower = null
    } else if (job.kind === 'brightness') {
      await client.sendCmd(CMD.SET_BRIGHTNESS, [job.value])
      S.lastSentBrightness[job.deviceId] = job.value
      // 按值清 pending（拖动中同值重复入队已被 scheduleBrightness 挡掉）。
      if (S.pendingBrightness && S.pendingBrightness.value === job.value) {
        S.pendingBrightness = null
      }
    } else {
      await client.sendCmd(CMD.WRITE_CONFIG, Array.from(job.blob))
      await client.sendCmd(CMD.APPLY, [])
      S.lastSyncedHash[job.deviceId] = job.hash
      if (S.pending && S.pending.hash === job.hash) S.pending = null
      // 遥测（ADR-0037）：配置下发量与频次，后台看"谁在改灯"的趋势。
      telemetry.track('config.write', { dim: job.deviceId })
      telemetry.track('config.bytes', { value: job.blob.length })
    }
    S.inFlight = false
    _setState(S, 'synced', _now())
  } catch (err) {
    S.inFlight = false
    S.queued = false // 重试定时器会发最新 pending
    logError(err, '自动同步下发')
    telemetry.track('config.write.fail', { dim: job.kind })
    telemetry.trackError(typeof err === 'number' ? err : (err && err.code) || job.kind, '配置下发')
    _scheduleRetry(S)
    return
  }
  if (S.queued || _nextJob(S)) {
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

// 状态条「失败·重试」点击：立即重发待发的 job（整机状态或配置）。
function retry() {
  const S = _store()
  if (!S.pending && !S.pendingPower && !S.pendingBrightness) return
  S.retryCount = 0
  if (S.retryTimer) {
    clearTimeout(S.retryTimer)
    S.retryTimer = null
  }
  _flush()
}

// OTA 期间暂停/恢复自动下发（ADR-0034）。暂停只挡住"写空口"这一步：
// 页面改动照常落 Storage 并排进 pending，恢复到连接后再补发最新快照，
// 因此升级前后的用户操作不会丢。
function setPaused(paused) {
  const S = _store()
  const next = !!paused
  if (S.paused === next) return
  S.paused = next
  if (!next && (_nextJob(S) || S.queued)) {
    S.retryCount = 0
    _flush()
  }
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
  S.pendingPower = null
  S.lastSentPower = {}
  S.pendingBrightness = null
  S.lastSentBrightness = {}
  S.timer = null
  S.retryTimer = null
  S.retryCount = 0
  S.inFlight = false
  S.queued = false
  S.paused = false
  S.client = null
  S.offState = null
  S.subs.clear()
}

module.exports = { schedule, schedulePower, scheduleBrightness, onConnected, subscribe, retry, setPaused, reset }