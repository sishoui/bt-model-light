// 云端设备归属同步（ADR-0035）：best-effort 镜像，**不阻塞 BLE**。
//
// 真相源仍是本地 Storage（deviceStore）：BLE 是离线设备，配置必须在断网时也能改。
// 这里只做两件事：
//   1. 本地设备增/改/删后推服务端（失败仅记日志，静默，下次 syncAll 补齐）；
//   2. 登录后拉服务端设备清单，与本地按 BLE deviceId 合并（服务端独有的补进来）。
//
// 因此任何调用都不返回"必须处理"的错误：页面不需要 await/兜错。

'use strict'

const api = require('./apiClient')
const userStore = require('./userStore')
const deviceStore = require('./deviceStore')
const { logError } = require('./errorHandler')

// 同步状态快照（「我的」页展示）：idle | syncing | synced | failed | local(未登录) | pending
let _state = { status: 'idle', at: '', message: '' }

function getStatus() {
  return Object.assign({}, _state)
}

function _setStatus(status, message) {
  const d = new Date()
  const at = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  _state = { status, at, message: message || '' }
  return getStatus()
}

function canSync() {
  return userStore.isLoggedIn()
}

// ---- 推送单条 --------------------------------------------------------------

// 本地新增/改名设备后调用。device: deviceStore 里的记录（含 deviceId/name）。
function pushDevice(device) {
  if (!canSync() || !device || !device.deviceId) return Promise.resolve(null)
  return api
    .request('/devices', {
      method: 'POST',
      data: {
        deviceId: device.deviceId,
        name: device.name || '',
        firmwareVersion: device.firmwareVersion || '',
      },
    })
    .then((body) => (body && body.device) || null)
    .catch((err) => {
      logError(err, '云端同步设备')
      return null
    })
}

// 本地删除设备后调用：按 BLE deviceId 找到服务端那条再删；找不到就不请求。
function pushDelete(device) {
  if (!canSync() || !device || !device.deviceId) return Promise.resolve(false)
  return api
    .request('/devices')
    .then((body) => {
      const list = (body && body.devices) || []
      const hit = list.find((d) => d.deviceId === device.deviceId)
      if (!hit) return false
      return api.request(`/devices/${hit.id}`, { method: 'DELETE' }).then(() => true)
    })
    .catch((err) => {
      logError(err, '云端删除设备')
      return false
    })
}

// ---- 全量同步 --------------------------------------------------------------

// 登录后（或用户点「立即同步」）调用：
//   - 拉服务端清单；
//   - 服务端有、本地没有（按 deviceId）→ 补进本地；
//   - 本地有、服务端没有 → 推上去。
// 返回 { added, pushed, total }。
function syncAll() {
  if (!canSync()) {
    _setStatus('local')
    return Promise.resolve({ added: 0, pushed: 0, total: 0 })
  }
  _setStatus('syncing')
  return api
    .request('/devices')
    .then((body) => {
      const serverList = (body && body.devices) || []
      const local = deviceStore.listDevices()
      const localByDeviceId = new Map()
      for (const d of local) localByDeviceId.set(d.deviceId, d)
      const serverByDeviceId = new Map()
      for (const d of serverList) serverByDeviceId.set(d.deviceId, d)

      // 1. 服务端 → 本地：补缺失设备（本地 id 由 deviceStore 生成，deviceId 相同即同一台）。
      let added = 0
      for (const s of serverList) {
        if (!localByDeviceId.has(s.deviceId)) {
          deviceStore.saveDevice({ name: s.name, deviceId: s.deviceId })
          added += 1
        } else if (s.name) {
          // 服务端名字更新（例如在另一台手机上改过）：以服务端为准合并进本地。
          const cur = localByDeviceId.get(s.deviceId)
          if (cur.name !== s.name) deviceStore.saveDevice({ id: cur.id, name: s.name })
        }
      }

      // 2. 本地 → 服务端：推缺失设备。
      const missing = local.filter((d) => d.deviceId && !serverByDeviceId.has(d.deviceId))
      const pushes = missing.map((d) =>
        api
          .request('/devices', {
            method: 'POST',
            data: { deviceId: d.deviceId, name: d.name || '', firmwareVersion: d.firmwareVersion || '' },
          })
          .catch((err) => {
            logError(err, '云端同步设备')
            return null
          })
      )
      return Promise.all(pushes).then(() => {
        const result = { added, pushed: missing.length, total: serverList.length + missing.length }
        _setStatus('synced')
        return result
      })
    })
    .catch((err) => {
      logError(err, '云端同步')
      _setStatus('failed', err.message || String(err))
      throw err
    })
}

// 测试钩子：清掉状态（模块级单例，跨用例需要重置）。
function resetStatus() {
  _state = { status: 'idle', at: '', message: '' }
}

module.exports = {
  getStatus,
  canSync,
  pushDevice,
  pushDelete,
  syncAll,
  resetStatus,
}
