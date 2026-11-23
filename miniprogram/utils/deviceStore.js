// 设备持久化（ADR-0023 / ADR-0025 / ADR-0026）。
//
// Storage 布局（小程序 Storage 为真相源，SPEC 持久化节）：
//   bt_devices        已保存设备数组：[{ id, name, deviceId }]
//   bt_current_device 当前选中设备 id（'' 表示未选择）
//   device_config_<id> 每设备配置（T7 引脚配置写入，本文件只提供读写通道）
//
// id 是本地生成的无序唯一键（时间戳 + 随机数），与 BLE deviceId（MAC 地址）
// 解耦：固件 MAC 可能随烧录变化，本地 id 稳定。
//
// 依赖 wx Storage 仅通过全局 wx 访问，不 import wx，便于 Jest 双端运行
// （与 frameParser.js 相同的约束：ES2017+ 标准 API）。

'use strict'

const STORAGE_KEY_DEVICES = 'bt_devices'
const STORAGE_KEY_CURRENT = 'bt_current_device'

// 进程内缓存：listDevices 的写穿缓存（Storage mock 每个测试重建，
// 测试钩子 resetDeviceStore 清掉缓存）。
let _memDevices = null

function _wx() {
  if (typeof wx === 'undefined') {
    throw new Error('deviceStore requires the wx runtime (call it inside miniprogram or install wx-mock in tests)')
  }
  return wx
}

// 读 bt_devices；损坏（非 JSON / 非数组）按空表处理（ADR-0026 容错）。
function _readDevices() {
  if (_memDevices) return _memDevices
  const raw = _wx().getStorageSync(STORAGE_KEY_DEVICES)
  let arr = []
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) arr = parsed
    } catch (e) {
      arr = [] // 损坏存储视为空表，后续 save 覆盖
    }
  }
  _memDevices = arr
  return _memDevices
}

function _writeDevices(devices) {
  _memDevices = devices
  _wx().setStorageSync(STORAGE_KEY_DEVICES, JSON.stringify(devices))
}

// 本地唯一 id：时间戳 + 随机后缀，避免同毫秒碰撞。
function _genId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// ---- 设备列表 --------------------------------------------------------------

function listDevices() {
  return _readDevices().slice()
}

// 新增或更新设备（按本地 id 命中则更新，否则按 BLE deviceId 去重后追加）。
// device: { name, deviceId, id? }
function saveDevice(device) {
  const devices = _readDevices()
  const byId = device.id ? devices.find((d) => d.id === device.id) : null
  if (byId) {
    Object.assign(byId, device)
    _writeDevices(devices)
    return byId
  }
  const byDeviceId = devices.find((d) => d.deviceId === device.deviceId)
  if (byDeviceId) {
    Object.assign(byDeviceId, device)
    _writeDevices(devices)
    return byDeviceId
  }
  const entry = {
    id: _genId(),
    name: device.name || '',
    deviceId: device.deviceId || '',
    addedAt: Date.now(),
  }
  devices.push(entry)
  _writeDevices(devices)
  return entry
}

function removeDevice(id) {
  const devices = _readDevices().filter((d) => d.id !== id)
  _writeDevices(devices)
  if (getCurrentDeviceId() === id) setCurrentDeviceId(null)
}

// ---- 当前设备 ---------------------------------------------------------------

function getCurrentDeviceId() {
  const raw = _wx().getStorageSync(STORAGE_KEY_CURRENT)
  return typeof raw === 'string' && raw ? raw : null
}

function setCurrentDeviceId(id) {
  _wx().setStorageSync(STORAGE_KEY_CURRENT, id || '')
}

// ---- 每设备配置（device_config_<id>） ----------------------------------------

function _configKey(id) {
  return `device_config_${id}`
}

function getDeviceConfig(id) {
  const raw = _wx().getStorageSync(_configKey(id))
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (e) {
    return null
  }
}

// 写每设备配置（T7 保存链路调用；home 页的引脚卡片读它）。
// 本 issue 只提供读写通道，结构校验与灯组 schema 归 T7。
function saveDeviceConfig(id, config) {
  _wx().setStorageSync(_configKey(id), JSON.stringify(config))
}

// 测试钩子：清掉进程内缓存（Storage mock 每个测试重建，缓存必须同步失效）。
function resetDeviceStore() {
  _memDevices = null
}

module.exports = {
  STORAGE_KEY_DEVICES,
  STORAGE_KEY_CURRENT,
  listDevices,
  saveDevice,
  removeDevice,
  getCurrentDeviceId,
  setCurrentDeviceId,
  getDeviceConfig,
  saveDeviceConfig,
  resetDeviceStore,
}