// 设备持久化（ADR-0023 / ADR-0025 / ADR-0026）。
//
// Storage 布局（小程序 Storage 为真相源，SPEC 持久化节）：
//   bt_devices        已保存设备数组：[{ id, name, deviceId, power?, brightness?,
//                       firmwareVersion?, firmwareVersionAt? }]
//   bt_current_device 当前选中设备 id（'' 表示未选择）
//   device_config_<id> 每设备配置（T7 引脚配置写入，本文件只提供读写通道）
//
// power / brightness 是整机开关与整机亮度（ADR-0031/0032）：可选字段，
// 缺省 开 / 255（与固件默认一致）。存设备记录而非设备配置：它们是设备级
// 展示状态，不进 WRITE_CONFIG 的配置 blob。
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
//
// 存 globalThis 槽而不是模块级变量（与 bleClient 的 __btBleClient、autoSync 的
// __btAutoSync 同一模式）：页面经 jest.isolateModules 加载时与测试各持一份模块
// 副本，模块级缓存会让"测试先写、页面后读"的用例看到旧快照。
const CACHE_KEY = '__btDevicesCache'

function _cacheRoot() {
  return typeof globalThis !== 'undefined' ? globalThis : global
}

function _getCache() {
  return _cacheRoot()[CACHE_KEY] || null
}

function _setCache(devices) {
  _cacheRoot()[CACHE_KEY] = devices
}

function _wx() {
  if (typeof wx === 'undefined') {
    throw new Error('deviceStore requires the wx runtime (call it inside miniprogram or install wx-mock in tests)')
  }
  return wx
}

// 读 bt_devices；损坏（非 JSON / 非数组）按空表处理（ADR-0026 容错）。
function _readDevices() {
  const cached = _getCache()
  if (cached) return cached
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
  _setCache(arr)
  return arr
}

function _writeDevices(devices) {
  _setCache(devices)
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

// ---- 整机开关 / 整机亮度（ADR-0031 / ADR-0032） ------------------------------

const BRIGHTNESS_DEFAULT = 255
const POWER_DEFAULT = true

// 读某设备的整机开关（未设置过 → 开）。
function getDevicePower(id) {
  const dev = _readDevices().find((d) => d.id === id)
  return dev && dev.power !== undefined ? !!dev.power : POWER_DEFAULT
}

// 写某设备的整机开关（返回落盘值）。只动整机状态，不碰各引脚的 power
// （引脚状态不变是 ADR-0032 的核心：开机后各引脚按原状态恢复）。
function saveDevicePower(id, on) {
  const v = !!on
  saveDevice({ id, power: v })
  return v
}

// 归一化：非数字/越界一律回落到默认值，避免脏 Storage 把固件写成黑屏。
// 导出供页面直接用（滑块的原始值也要过这里，保证界面与落盘同口径）。
function clampBrightness(value) {
  const n = Math.round(Number(value))
  if (!isFinite(n) || n < 0 || n > 255) return BRIGHTNESS_DEFAULT
  return n
}

// 读某设备的整机亮度（未设置过 → 255）。
function getDeviceBrightness(id) {
  const dev = _readDevices().find((d) => d.id === id)
  return dev && dev.brightness !== undefined
    ? clampBrightness(dev.brightness)
    : BRIGHTNESS_DEFAULT
}

// 写某设备的整机亮度（返回落盘值）。
function saveDeviceBrightness(id, value) {
  const v = clampBrightness(value)
  saveDevice({ id, brightness: v })
  return v
}

// ---- 固件版本（ADR-0034） ---------------------------------------------------
// 连接时固件主动上报，GET_VERSION 也会补一次。存设备记录：设备列表/首页/
// 我的页都要显示"这台设备跑的是哪个固件"，且 App 重开时先显示上次已知值。
// 这是观测值而非用户配置，读不到（老记录）返回 ''。

function getDeviceFirmwareVersion(id) {
  const dev = _readDevices().find((d) => d.id === id)
  return (dev && dev.firmwareVersion) || ''
}

// 写固件版本（值未变则不落盘，避免每次连接都写 Storage）。
function saveDeviceFirmwareVersion(id, version) {
  const v = String(version || '')
  if (!v) return ''
  const dev = _readDevices().find((d) => d.id === id)
  if (dev && dev.firmwareVersion === v) return v
  saveDevice({ id, firmwareVersion: v, firmwareVersionAt: Date.now() })
  return v
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
  _cacheRoot()[CACHE_KEY] = null
}

module.exports = {
  STORAGE_KEY_DEVICES,
  STORAGE_KEY_CURRENT,
  BRIGHTNESS_DEFAULT,
  POWER_DEFAULT,
  listDevices,
  saveDevice,
  removeDevice,
  getCurrentDeviceId,
  setCurrentDeviceId,
  getDeviceConfig,
  saveDeviceConfig,
  clampBrightness,
  getDevicePower,
  saveDevicePower,
  getDeviceBrightness,
  saveDeviceBrightness,
  getDeviceFirmwareVersion,
  saveDeviceFirmwareVersion,
  resetDeviceStore,
}