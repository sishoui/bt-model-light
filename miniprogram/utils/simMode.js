// 模拟模式开关持久化（与 deviceStore 同约束：仅通过全局 wx 访问，不 import wx）。
//
// Storage 键：bt_sim_mode_enabled（'1' 开启 / 空表示关闭）。
// 开关状态影响 app.js 启动时创建真实 client 还是模拟 client。

'use strict'

const STORAGE_KEY_SIM_ENABLED = 'bt_sim_mode_enabled'

function _wx() {
  if (typeof wx === 'undefined') {
    throw new Error('simMode requires the wx runtime (call it inside miniprogram or install wx-mock in tests)')
  }
  return wx
}

function isSimModeEnabled() {
  const raw = _wx().getStorageSync(STORAGE_KEY_SIM_ENABLED)
  return raw === '1' || raw === 1 || raw === true
}

function setSimModeEnabled(enabled) {
  _wx().setStorageSync(STORAGE_KEY_SIM_ENABLED, enabled ? '1' : '')
}

module.exports = {
  STORAGE_KEY_SIM_ENABLED,
  isSimModeEnabled,
  setSimModeEnabled,
}