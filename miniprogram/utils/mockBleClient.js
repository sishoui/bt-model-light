// 模拟 BLE 客户端（模拟模式）——在无硬件环境下驱动页面布局与交互测试。
//
// 与真实 bleClient.js 保持接口一致（scanDevices/connect/disconnect/sendCmd/
// onStatus/onConnectionStateChange + 只读属性），但所有方法不发真 BLE 请求，
// 只模拟成功流程、触发合理的 notify 事件。
//
// 设计约束：
//   - 不 import wx：与 bleClient 相同约束，仅依赖 ES2017+。
//   - 模拟设备 ID 含 'sim-' 前缀，name 含 'Simulator'，便于与真机区分。
//   - sendCmd 仅写本地日志并 emit 'ok' notify，不下发真机。
//   - 版本协商强制 compatible=true，避免页面弹版本不兼容 Modal。

'use strict'

const { CMD, NOTIFY, PROTOCOL_VERSION } = require('./protocol_gen')

// ---- 模拟设备常量 ------------------------------------------------------------

const SIM_DEVICE_ID = 'sim-00000000-simulator'
const SIM_DEVICE_NAME = 'BTLight_Simulator_01'
const SIM_RSSI = -55

// 模拟版本：协议与小程序当前版本一致（避免触发不兼容分支），固件标记 dev。
const SIM_PROTOCOL = `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`
const SIM_FIRMWARE = '0.0.0-sim'

function createSimBleClient() {
  // ---- 连接态 ----
  let _connected = false
  let _versionKnown = false
  let _compatible = true
  let _versionInfo = null
  let _seq = 0

  // ---- 订阅者 ----
  const _statusSubs = new Set()
  const _stateSubs = new Set()

  // ---- notify 调度工具（setTimeout 模拟异步） --------------------------------

  function _emitStatus(evt) {
    for (const fn of _statusSubs) {
      try {
        fn(evt)
      } catch (e) {
        /* 订阅者异常隔离 */
      }
    }
  }

  function _emitState(connected) {
    for (const fn of _stateSubs) {
      try {
        fn({ connected })
      } catch (e) {
        /* 同上 */
      }
    }
  }

  // 模拟延迟发送 VERSION notify（连接后 ~50ms）。
  function _scheduleVersionNotify() {
    setTimeout(() => {
      if (!_connected) return
      _versionKnown = true
      _compatible = true
      _versionInfo = { protocol: SIM_PROTOCOL, firmware: SIM_FIRMWARE }
      _emitStatus({
        type: 'version',
        protocol: SIM_PROTOCOL,
        firmware: SIM_FIRMWARE,
        compatible: true,
      })
    }, 50)
  }

  // 模拟命令成功后的 OK notify（~30ms）。
  function _scheduleOkNotify() {
    setTimeout(() => {
      if (!_connected) return
      _emitStatus({ type: 'ok', code: 0 })
    }, 30)
  }

  // ---- 扫描 ------------------------------------------------------------------

  function scanDevices(options) {
    const opts = options || {}
    let stopped = false

    // 模拟发现延迟 ~200ms，避免 UI 闪烁。
    setTimeout(() => {
      if (stopped) return
      const device = {
        name: SIM_DEVICE_NAME,
        deviceId: SIM_DEVICE_ID,
        RSSI: SIM_RSSI,
      }
      if (typeof opts.onFound === 'function') opts.onFound(device)
    }, 200)

    return {
      stop() {
        stopped = true
      },
    }
  }

  // ---- 连接 ------------------------------------------------------------------

  async function connect(deviceId) {
    // 模拟连接延迟。
    await new Promise((r) => setTimeout(r, 150))
    if (deviceId !== SIM_DEVICE_ID) {
      // 非模拟设备：模拟连接失败（用户应断开模拟后再连真机）。
      throw new Error('模拟模式仅支持模拟设备')
    }
    _connected = true
    _versionKnown = false
    _compatible = true
    _versionInfo = null
    _seq = 0
    _emitState(true)
    _scheduleVersionNotify()
    return { deviceId }
  }

  async function disconnect() {
    _connected = false
    _versionKnown = false
    _compatible = true
    _versionInfo = null
    _seq = 0
    _emitState(false)
  }

  async function closeAdapter() {
    if (_connected) await disconnect()
  }

  // ---- 命令发送 --------------------------------------------------------------

  async function sendCmd(cmd, payload) {
    if (!_connected) {
      throw new Error('BLE 未连接（模拟）')
    }
    if (_versionKnown && !_compatible) {
      throw new Error('协议版本不兼容（模拟）')
    }
    // 模拟序列号递增（与真实 client 同构，便于将来加日志）。
    _seq = (_seq + 1) & 0xff
    // 不发真 BLE 写，仅模拟 OK notify。
    _scheduleOkNotify()
  }

  // ---- 订阅 ------------------------------------------------------------------

  function onStatus(fn) {
    _statusSubs.add(fn)
    return () => _statusSubs.delete(fn)
  }

  function onConnectionStateChange(fn) {
    _stateSubs.add(fn)
    return () => _stateSubs.delete(fn)
  }

  // ---- 只读状态 --------------------------------------------------------------

  return {
    scanDevices,
    connect,
    disconnect,
    closeAdapter,
    sendCmd,
    onStatus,
    onConnectionStateChange,
    // 标记：供页面/工具识别当前 client 是否为模拟。
    isSim: true,
    get connected() {
      return _connected
    },
    get deviceId() {
      return _connected ? SIM_DEVICE_ID : null
    },
    get versionKnown() {
      return _versionKnown
    },
    get compatible() {
      return _compatible
    },
    get versionInfo() {
      return _versionInfo
    },
    // 模拟客户端不走真实 BLE：分片上限固定安全下界（与 bleClient.WRITE_CHUNK 同值）。
    get chunk() {
      return 20
    },
  }
}

module.exports = {
  createSimBleClient,
  SIM_DEVICE_ID,
  SIM_DEVICE_NAME,
  SIM_RSSI,
}