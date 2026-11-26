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
//
// Storage 语义与真机一致：getStorageSync 未命中返回 ''（不是 null/undefined）。
// 依赖此行为的被测代码（如 deviceStore）应对 '' 做容错，测试不再全局 mockReset。

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
  // 安卓 MTU 协商（ADR-0029）：默认成功；测试可 mockImplementation 成 reject
  // 模拟 iOS/不支持的分支，或让 writeBLECharacteristicValue 拒绝大包模拟降级。
  wx.setBLEMTU = _asyncMock({ mtu: 512 })

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
  // Storage 为内存 KV，跨调用持久（setStorageSync 写入后 getStorageSync 可读回），
  // 每个测试通过 installWxMock 重建 mock，天然隔离。真机 Storage 上限 10MB，此处不限。
  const _storage = Object.create(null)
  wx.getStorageSync = j.fn((key) =>
    Object.prototype.hasOwnProperty.call(_storage, key) ? _storage[key] : ''
  )
  wx.setStorageSync = j.fn((key, value) => {
    _storage[key] = value
  })
  wx.removeStorageSync = j.fn((key) => {
    delete _storage[key]
  })
  wx.clearStorageSync = j.fn(() => {
    for (const k of Object.keys(_storage)) delete _storage[k]
  })
  wx.getStorageInfoSync = j.fn(() => ({
    keys: Object.keys(_storage),
    currentSize: 0,
    limitSize: 10240,
  }))

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
  wx.vibrateShort = j.fn()
  // 下一帧回调：页面用它等 wx:if 内的 canvas 节点挂载后再取节点/测量。
  // 同真实 API，回调异步执行（永不同步触发），否则调用点的时序假设会在测试里失真。
  wx.nextTick = j.fn((cb) => {
    if (typeof cb === 'function') Promise.resolve().then(cb)
  })

  // ---- 导航 ----
  wx.navigateTo = j.fn()
  wx.redirectTo = j.fn()
  wx.switchTab = j.fn()
  wx.navigateBack = j.fn()
  wx.reLaunch = j.fn()

  // ---- 离开拦截（引脚配置详情页 dirty 时用，#27） ----
  wx.enableAlertBeforeUnload = j.fn()
  wx.disableAlertBeforeUnload = j.fn()

  // ---- 节点查询（引脚详情拖选网格几何，#31 拖选） ----
  // 链able 桩：select() 单节点查询返回 __gridRect；selectAll() 返回 __cellRects
  // （未注入时由 __gridRect 均分 10 列派生 100 格）。
  wx.__gridRect = null
  wx.__cancelRect = null
  wx.__cellRects = null
  // 由网格 rect 派生 10×10 格 rects（测试默认路径）。
  function _deriveCellRects(rect, count) {
    const cols = 10
    const rows = Math.ceil(count / cols)
    const w = rect.width / cols
    const h = rect.height / rows
    const out = []
    for (let i = 0; i < count; i++) {
      const c = i % cols
      const r = Math.floor(i / cols)
      out.push({ left: rect.left + c * w, top: rect.top + r * h, width: w, height: h })
    }
    return out
  }
  wx.createSelectorQuery = j.fn(() => {
    const q = {
      _calls: [],
      in: j.fn(() => q),
      select: j.fn((sel) => {
        q._calls.push({ sel, all: false })
        return q
      }),
      selectAll: j.fn((sel) => {
        q._calls.push({ sel, all: true })
        return q
      }),
      boundingClientRect: j.fn(() => q),
      // canvas 2d 节点查询：页面用 fields({node,size}) 取 canvas 节点后建 2d 上下文。
      // mock 不提供真实 canvas，返回 null 节点（页面据此安全跳过绘制）。
      fields: j.fn(() => q),
      exec: j.fn((cb) => {
        const res = q._calls.map((c) => {
          if (!c.all) return wx.__gridRect
          if (wx.__cellRects) return wx.__cellRects
          return wx.__gridRect ? _deriveCellRects(wx.__gridRect, 100) : []
        })
        if (typeof cb === 'function') cb(res)
        return res
      }),
    }
    return q
  })

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