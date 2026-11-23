// BLE 客户端：扫描 / 连接 / 命令发送 / notify 重组与 STATUS_NOTIFY 解析。
// （ADR-0004 GATT / ADR-0009 版本协商 / ADR-0025 前缀过滤 / ADR-0026 错误回传）
//
// 帧编解码复用 utils/frameParser.js（与固件同构的纯函数层，ADR-0003/0005/0006）。
// 本模块把"字节"提升到"事件"：sendCmd 编帧并按 BLE 写特征的分片上限切片；
// 收到的 notify 按字节流喂 FrameParser，交付解析好的 STATUS_NOTIFY 事件。
//
// 运行环境约束：仅依赖 ES2017+ 标准 API 与全局 wx（不 import wx），
// Jest 通过 wx-mock 注入（ADR-0012 第 2 层）。
//
// BLE 写特征分片上限：默认 ATT MTU 23 → 有效负载 20 字节。空口 MTU 协商在
// 真机 smoke test 验证（frame-spec.md），JS 侧固定 20 字节分片是安全下界。

'use strict'

const { encodeFrame, FrameParser, PARSE_OK } = require('./frameParser')
const { CMD, NOTIFY, BLE, PROTOCOL_VERSION, ERR } = require('./protocol_gen')

// 单次 BLE 写的最大字节数（ATT MTU 23 的安全下界）。
const WRITE_CHUNK = 20

// 连接状态机（本模块内）：idle → scanning / connecting → connected → idle。
// compatible 仅由 VERSION notify 置位（ADR-0009）。

function createBleClient() {
  // ---- 连接态 ----
  let _deviceId = null
  let _serviceId = null
  let _writeCharId = null
  let _notifyCharId = null
  let _connected = false
  let _versionKnown = false
  let _compatible = true // 未协商前不阻断（连接后首发 GET_VERSION 再裁决）
  let _versionInfo = null // { protocol, firmware }
  let _seq = 0
  let _parser = new FrameParser()
  let _adapterOpen = false
  let _listenersRegistered = false // 是否已注册全局 notify/连接监听（与 _ensureAdapter 语义一致）
  let _scanEmit = null // 当前扫描会话的 onFound 回调（null 表示未扫描）

  // ---- 订阅者集合（页面级 on* 注册） ----
  const _statusSubs = new Set()
  const _stateSubs = new Set()

  // ---- 单例 seam（实现见文件底部 getCurrentBleClient/setCurrentBleClient） ----

  function _wx() {
    if (typeof wx === 'undefined') {
      throw new Error('bleClient requires the wx runtime (miniprogram or wx-mock in tests)')
    }
    return wx
  }

  // ---- 内部：notify 帧到达 → STATUS_NOTIFY 事件分发 ----
  function _dispatchFrame(out) {
    if (out.cmd !== CMD.STATUS_NOTIFY) return // 其他命令的 notify（v2）暂忽略
    const p = out.payload
    if (p.length < 3) return // 布局不足 3 字节（status/code/seq），坏帧丢弃
    const status = p[0]
    const code = p[1]
    let evt = null
    if (status === NOTIFY.VERSION) {
      if (p.length < 7) return // data 需要 4 字节
      const protocol = `${p[3]}.${p[4]}`
      const firmware = `${p[5]}.${p[6]}`
      const compatible =
        Number(p[3]) === PROTOCOL_VERSION.major && Number(p[4]) === PROTOCOL_VERSION.minor
      _versionKnown = true
      _compatible = compatible
      _versionInfo = { protocol, firmware }
      evt = { type: 'version', protocol, firmware, compatible }
    } else if (status === NOTIFY.STATE) {
      evt = { type: 'state', state: code }
    } else if (status === NOTIFY.ERROR) {
      evt = { type: 'error', code } // 文案映射见 errorHandler（T8，ADR-0026）
    } else if (status === NOTIFY.OK) {
      evt = { type: 'ok', code }
    }
    if (!evt) return
    for (const fn of _statusSubs) {
      try {
        fn(evt)
      } catch (e) {
        // 单个订阅者异常不影响其他订阅者（页面回调在 wx 环境外抛错会直接崩渲染层）。
      }
    }
  }

  function _onNotify(res) {
    if (!_connected) return
    const value = res && res.value
    if (!value) return
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    const rc = _parser.feed(bytes)
    if (rc !== PARSE_OK) return // BUFFER_OVERFLOW 等：本帧丢弃（frameParser 语义）
    const out = { cmd: 0, seq: 0, payload: null }
    while (_parser.next(out) === PARSE_OK) {
      _dispatchFrame(out)
    }
  }

  function _onConnectionState(res) {
    if (res.deviceId !== _deviceId) return
    if (!res.connected) {
      _connected = false
      _versionKnown = false
      _compatible = true
      _parser.reset()
    }
    for (const fn of _stateSubs) {
      try {
        fn({ connected: res.connected })
      } catch (e) {
        /* 同上：订阅者异常隔离 */
      }
    }
  }

  // 确保适配器打开且全局 notify/连接监听已注册（openBluetoothAdapter 幂等）。
  async function _ensureAdapter() {
    const wx = _wx()
    if (!_adapterOpen) {
      await wx.openBluetoothAdapter()
      _adapterOpen = true
    }
    if (!_listenersRegistered) {
      // 监听注册只做一次，回调内按当前连接态过滤；避免重复扫描时监听器累积。
      wx.onBLECharacteristicValueChange(_onNotify)
      wx.onBLEConnectionStateChange(_onConnectionState)
      _listenersRegistered = true
    }
  }

  // ---- 扫描（ADR-0025 前缀过滤） ----------------------------------------------

  // options: { onFound(device), onError(err) }
  // 返回 { stop() }：停止发现；若未建立 BLE 连接则同时关闭适配器。
  function scanDevices(options) {
    const opts = options || {}
    const found = new Map() // deviceId -> device
    let stopped = false

    const emit = (devices) => {
      for (const d of devices) {
        if (!d || !d.name || d.name.indexOf(BLE.namePrefix) !== 0) continue
        const prev = found.get(d.deviceId)
        const rssi = d.RSSI || 0
        const device = {
          name: d.name,
          deviceId: d.deviceId,
          RSSI: prev ? Math.max(prev.RSSI, rssi) : rssi,
        }
        found.set(d.deviceId, device)
        if (typeof opts.onFound === 'function') opts.onFound(device)
      }
    }

    _ensureAdapter()
      .then(() => _wx().startBluetoothDevicesDiscovery({ allowDuplicatesKey: true }))
      .then(() => {
        _scanEmit = (res) => {
          if (stopped) return
          emit((res && res.devices) || [])
        }
        _wx().onBluetoothDeviceFound((res) => {
          if (_scanEmit) _scanEmit(res)
        })
      })
      .catch((err) => {
        if (typeof opts.onError === 'function') opts.onError(err)
      })

    return {
      stop() {
        if (stopped) return
        stopped = true
        const wx = _wx()
        _scanEmit = null
        wx.stopBluetoothDevicesDiscovery({})
        // 仅在未建立 BLE 连接时关闭适配器：刚连上的设备仍需适配器维持连接
        // （spec #25 评审 Bug 1）。
        if (!_connected) {
          wx.closeBluetoothAdapter({})
          _adapterOpen = false
          _listenersRegistered = false
        }
      },
    }
  }

  // ---- 连接（ADR-0004 / ADR-0009） --------------------------------------------

  // 流程：openBluetoothAdapter → createBLEConnection → 发现服务（按 UUID 匹配
  // ble.csv 的 service_uuid）→ 发现特征（写/通知）→ 订阅 notify → 首发
  // GET_VERSION 协商。返回 { deviceId }。
  async function connect(deviceId) {
    const wx = _wx()
    await _ensureAdapter()
    if (_connected && _deviceId === deviceId) return { deviceId }

    // 切换设备：先断开旧连接，复位协商态。
    if (_connected && _deviceId && _deviceId !== deviceId) {
      await disconnect()
    }
    _parser.reset()
    _seq = 0
    _versionKnown = false
    _compatible = true
    _versionInfo = null

    await wx.createBLEConnection({ deviceId }) // 超时由 wx 层控制，失败 reject
    _deviceId = deviceId

    const { services } = await wx.getBLEDeviceServices({ deviceId })
    const svc = (services || []).find((s) => s.uuid === BLE.serviceUuid)
    if (!svc) {
      _deviceId = null
      throw new Error(`未找到 ${BLE.serviceUuid} 服务（设备可能不是 BTLight 固件）`)
    }
    _serviceId = svc.uuid

    const { characteristics } = await wx.getBLEDeviceCharacteristics({
      deviceId,
      serviceId: _serviceId,
    })
    const chars = characteristics || []
    const write = chars.find((c) => c.properties && c.properties.write)
    const notifyCh = chars.find((c) => c.properties && c.properties.notify)
    if (!write || !notifyCh) {
      _deviceId = null
      throw new Error('服务特征不完整：需要 write + notify 各一个')
    }
    _writeCharId = write.uuid
    _notifyCharId = notifyCh.uuid

    await wx.notifyBLECharacteristicValueChange({
      deviceId,
      serviceId: _serviceId,
      characteristicId: _notifyCharId,
      state: true,
    })

    _connected = true
    for (const fn of _stateSubs) {
      try {
        fn({ connected: true })
      } catch (e) {
        /* 订阅者异常隔离 */
      }
    }

    // 连接后第一件事：GET_VERSION（ADR-0009）。失败不阻塞连接成立
    //（固件可能旧到不认 0x08，后续 APPLY 等命令会被固件回 0x02）。
    await sendCmd(CMD.GET_VERSION, []).catch(() => {})
    return { deviceId }
  }

  async function disconnect() {
    const wx = _wx()
    if (_deviceId && _connected) {
      await wx.closeBLEConnection({ deviceId: _deviceId }).catch(() => {})
    }
    _deviceId = null
    _serviceId = null
    _writeCharId = null
    _notifyCharId = null
    _connected = false
    _versionKnown = false
    _compatible = true
    _versionInfo = null
    _parser.reset()
    _seq = 0
    for (const fn of _stateSubs) {
      try {
        fn({ connected: false })
      } catch (e) {
        /* 订阅者异常隔离 */
      }
    }
  }

  async function closeAdapter() {
    if (_connected) await disconnect()
    const wx = _wx()
    if (_adapterOpen) {
      await wx.closeBluetoothAdapter().catch(() => {})
      _adapterOpen = false
    }
    _scanEmit = null
    _listenersRegistered = false // 监听注册随适配器重置（_ensureAdapter 会重注册）
  }

  // ---- 命令发送 ---------------------------------------------------------------

  // 编帧 → 按 WRITE_CHUNK 切片 → 顺序写入写特征。
  // 未连接 / 协议不兼容时 reject（ADR-0009：不兼容不下发命令）。
  async function sendCmd(cmd, payload) {
    if (!_connected || !_deviceId || !_writeCharId) {
      throw new Error('BLE 未连接')
    }
    if (_versionKnown && !_compatible) {
      throw new Error(`协议版本不兼容（固件 ${_versionInfo ? _versionInfo.protocol : '?'}，需要 ${PROTOCOL_VERSION.string}）`)
    }
    const wx = _wx()
    const frame = encodeFrame(cmd, _seq, payload)
    _seq = (_seq + 1) & 0xff // uint8 回绕
    for (let off = 0; off < frame.length; off += WRITE_CHUNK) {
      const chunk = frame.slice(off, Math.min(off + WRITE_CHUNK, frame.length))
      await wx.writeBLECharacteristicValue({
        deviceId: _deviceId,
        serviceId: _serviceId,
        characteristicId: _writeCharId,
        value: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
      })
    }
  }

  // ---- 订阅 ---------------------------------------------------------------------

  // 订阅 STATUS_NOTIFY 事件：{ type: 'version'|'state'|'error'|'ok', ... }。
  // 返回退订函数。
  function onStatus(fn) {
    _statusSubs.add(fn)
    return () => _statusSubs.delete(fn)
  }

  // 订阅连接状态变化：{ connected: bool }。返回退订函数。
  function onConnectionStateChange(fn) {
    _stateSubs.add(fn)
    return () => _stateSubs.delete(fn)
  }

  // ---- 只读状态（见导出对象的 getter） ------------------------------------------

  return {
    scanDevices,
    connect,
    disconnect,
    closeAdapter,
    sendCmd,
    onStatus,
    onConnectionStateChange,
    get connected() {
      return _connected
    },
    get deviceId() {
      return _deviceId
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
  }
}

// ---- 单例 seam（跨页共享同一连接，测试可注入 fake） ---------------------------

module.exports = { createBleClient, getCurrentBleClient, setCurrentBleClient, WRITE_CHUNK }

// ---- 单例 seam（跨页共享同一连接，ADR-0023 的 getApp 方案；测试可注入 fake）。
// 存全局 slot：loadPage 的 isolateModules 副本也能取到同一实例。

function getCurrentBleClient() {
  const root =
    typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : {}
  return root.__btBleClient || null
}

function setCurrentBleClient(c) {
  const root =
    typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : {}
  root.__btBleClient = c
}