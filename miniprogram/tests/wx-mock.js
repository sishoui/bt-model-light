// 自建 global.wx mock（ADR-0012 / arena-feasibility）。
//
// 覆盖微信 BLE/存储/UI 等常用 API 的回调 + Promise 两种调用形态；
// mock 只模拟"调用顺序与参数"，不模拟微信客户端内部队列、MTU 协商、notify 合并。
//
// 用法：
//   const { installWxMock, createWxMock } = require('./wx-mock')
//   // 每个测试文件在 beforeEach 中：
//   installWxMock()
//   // 之后可直接访问 global.wx，或通过 require 拿到 wx = global.wx

'use strict'

// 注意：wx-mock.js 在 utils 目录之外（tests/），所以不需要 utils 下代码的 frameParser 风格。

// 把 jest 全局函数导入（Jest 在 testEnvironment node 下提供 jest 全局）。
// 若在非 Jest 环境被 require，需传入 jest 实例；这里默认使用 global.jest。
function _jest() {
  if (typeof global !== 'undefined' && global.jest) return global.jest
  if (typeof jest !== 'undefined') return jest
  throw new Error('wx-mock requires a Jest environment (jest global not found)')
}

// 通用 Promise/回调双形态 mock：返回 jest.fn()，调用时触发 success/complete 回调并 resolve Promise。
function _asyncMock(successResult) {
  const j = _jest()
  return j.fn((options = {}) => {
    const opts = options || {}
    if (typeof opts.success === 'function') {
      try {
        opts.success(successResult)
      } catch (e) {
        /* ignore */
      }
    }
    if (typeof opts.complete === 'function') {
      try {
        opts.complete()
      } catch (e) {
        /* ignore */
      }
    }
    return Promise.resolve(successResult)
  })
}

function createWxMock() {
  const wx = {}
  const j = _jest()

  // ---- 蓝牙适配器 ----
  wx.openBluetoothAdapter = _asyncMock({})
  wx.closeBluetoothAdapter = _asyncMock({})
  wx.startBluetoothDevicesDiscovery = _asyncMock({})
  wx.stopBluetoothDevicesDiscovery = _asyncMock({})
  wx.getBluetoothDevices = _asyncMock({ devices: [] })
  wx.getConnectedBluetoothDevices = _asyncMock({ devices: [] })

  // ---- BLE 连接 ----
  wx.createBLEConnection = _asyncMock({})
  wx.closeBLEConnection = _asyncMock({})
  wx.getBLEDeviceServices = _asyncMock({ services: [] })
  wx.getBLEDeviceCharacteristics = _asyncMock({ characteristics: [] })
  wx.notifyBLECharacteristicValueChange = _asyncMock({})
  wx.readBLECharacteristicValue = _asyncMock({})
  wx.writeBLECharacteristicValue = _asyncMock({})

  // ---- 事件监听（回调注册，mock 记录注册的回调以便测试触发） ----
  // 每个 on* 保存最后一次注册的回调；测试可通过 wx.__trigger(name, ...args) 触发。
  // 每个 on* 函数自带 .trigger(...args) 作为便捷入口。
  const _listeners = {}
  function _on(name) {
    const fn = j.fn((cb) => {
      _listeners[name] = cb
      return cb
    })
    fn.trigger = function (...args) {
      if (typeof _listeners[name] === 'function') _listeners[name](...args)
    }
    return fn
  }
  wx.onBluetoothDeviceFound = _on('onBluetoothDeviceFound')
  wx.onBLEConnectionStateChange = _on('onBLEConnectionStateChange')
  wx.onBLECharacteristicValueChange = _on('onBLECharacteristicValueChange')

  // 全局触发器：wx.__trigger(name, ...args) 触发对应监听器。
  wx.__trigger = function (name, ...args) {
    if (typeof _listeners[name] === 'function') _listeners[name](...args)
  }

  // ---- 系统/存储 ----
  wx.getSystemInfoSync = j.fn(() => ({
    platform: 'devtools',
    system: 'iOS 17.0',
    version: '8.0.0',
    screenWidth: 375,
    screenHeight: 667,
    pixelRatio: 2,
  }))
  wx.getStorageSync = j.fn((key) => null)
  wx.setStorageSync = j.fn()
  wx.removeStorageSync = j.fn()
  wx.clearStorageSync = j.fn()

  // ---- UI ----
  wx.showToast = j.fn()
  wx.showModal = j.fn((opts = {}) => {
    if (typeof opts.success === 'function') opts.success({ confirm: true, cancel: false })
    if (typeof opts.complete === 'function') opts.complete()
    return Promise.resolve()
  })
  wx.showLoading = j.fn()
  wx.hideLoading = j.fn()
  wx.showActionSheet = j.fn()

  // ---- 导航 ----
  wx.navigateTo = j.fn()
  wx.redirectTo = j.fn()
  wx.switchTab = j.fn()
  wx.navigateBack = j.fn()
  wx.reLaunch = j.fn()

  // ---- 元信息 ----
  wx.__listeners = _listeners
  return wx
}

function installWxMock() {
  const wx = createWxMock()
  global.wx = wx
  return wx
}

module.exports = { createWxMock, installWxMock }