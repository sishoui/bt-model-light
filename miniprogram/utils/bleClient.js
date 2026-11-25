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
// BLE 写特征分片上限：按协商后的 ATT MTU 自适应（ADR-0029）。
// 固件 local MTU 提到 517；Android 由 wx.setBLEMTU(512) 协商 → 509 字节/包，
// iOS 系统自动请求 185 → 182 字节/包，协商不到时退回 20 字节安全下界。
// 空口 MTU/分包的物理正确性仍由真机 smoke test 覆盖（frame-spec.md）。

'use strict'

const { encodeFrame, FrameParser, PARSE_OK } = require('./frameParser')
const { CMD, NOTIFY, BLE, PROTOCOL_VERSION, ERR } = require('./protocol_gen')

// 安全下界：ATT MTU 23 → 20 字节负载（分片降级后的兜底值）。
const WRITE_CHUNK = 20
// Android 主动请求的 ATT MTU（wx.setBLEMTU 上限 512）→ 509 字节负载。
const MTU_REQUEST = 512
// iOS 无 MTU API，系统自动请求 185 → 182 字节负载。乐观使用，
// 平台实际收不下时由 sendCmd 首片降级兜底。
const CHUNK_IOS = 182

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
  // 当前写分片上限（字节）：connect 时按平台 MTU 能力确定一次（ADR-0029），
  // 首片被平台拒时整会话退回 WRITE_CHUNK。
  let _chunk = WRITE_CHUNK
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
        if (!d) continue
        // Android 12+ 在仅授予 SCAN 时可能只回传 localName / serviceUuids，
        // name 为空；优先用 name，其次 localName，避免把真机设备误过滤掉。
        const name = (d.name || d.localName || '').trim()
        const serviceUuids = Array.isArray(d.advertisServiceUUIDs)
          ? d.advertisServiceUUIDs
          : []
        const hasPrefix = name.indexOf(BLE.namePrefix) === 0
        const hasService = serviceUuids.some(
          (u) => String(u).toLowerCase() === String(BLE.serviceUuid).toLowerCase()
        )
        if (!hasPrefix && !hasService) {
          // 诊断：记录被过滤的设备，便于真机排查（不抛错）。
          if (typeof console !== 'undefined' && console.debug) {
            console.debug('[bleClient] filtered device', d.deviceId, name, serviceUuids)
          }
          continue
        }
        const displayName = hasPrefix ? name : `${BLE.namePrefix}${String(d.deviceId || '').slice(-4)}`
        const prev = found.get(d.deviceId)
        const rssi = d.RSSI || d.rssi || 0
        const device = {
          name: displayName,
          deviceId: d.deviceId,
          RSSI: prev ? Math.max(prev.RSSI, rssi) : rssi,
        }
        found.set(d.deviceId, device)
        if (typeof opts.onFound === 'function') opts.onFound(device)
      }
    }

    _ensureAdapter()
      .then(() => {
        const wx = _wx()
        return wx
          .startBluetoothDevicesDiscovery({ allowDuplicatesKey: true, services: [BLE.serviceUuid] })
          .catch(() => wx.startBluetoothDevicesDiscovery({ allowDuplicatesKey: true }))
      })
      .then(() => {
        _scanEmit = (res) => {
          if (stopped) return
          emit((res && res.devices) || [])
        }
        _wx().onBluetoothDeviceFound((res) => {
          if (_scanEmit) _scanEmit(res)
        })
        // 主动拉取一次已发现列表：部分机型 onBluetoothDeviceFound 回调滞后，
        // 扫描启动后立即 getBluetoothDevices 可避免「授权成功但列表为空」。
        const wx = _wx()
        if (typeof wx.getBluetoothDevices === 'function') {
          wx.getBluetoothDevices({
            success: (res) => {
              if (stopped) return
              emit((res && res.devices) || [])
            },
          })
        }
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

    // 先关闭可能残留的连接（Android 部分机型重复点击会累积连接句柄），
    // 仅在当前已连接时才做，避免在测试/首次连接时引入无谓延迟与副作用。
    if (_connected && _deviceId) {
      await wx.closeBLEConnection({ deviceId: _deviceId }).catch(() => {})
      _connected = false
      _parser.reset()
    }

    await wx.createBLEConnection({ deviceId }) // 超时由 wx 层控制，失败 reject
    _deviceId = deviceId

    // UUID 规范化：去掉连字符并转小写，兼容微信不同平台的返回格式。
    function normUuid(u) {
      return String(u || '').replace(/-/g, '').toLowerCase()
    }
    const targetSvc = normUuid(BLE.serviceUuid)

    // Android 微信在 createBLEConnection resolve 后，GATT 服务发现往往尚未完成：
    // 立即 getBLEDeviceServices 会返回空列表或抛错。策略：先立即尝试一次（Windows/macOS
    // 上服务早已就绪，0ms 延迟），若为空再做 500ms/1s/1s/2s 的重试，最多 5 次。
    // 每次打印实际返回的服务 UUID，便于真机排查。
    let services = []
    let svc = null
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, attempt === 1 ? 500 : 1000))
      }
      try {
        const res = await wx.getBLEDeviceServices({ deviceId })
        services = (res && res.services) || []
      } catch (e) {
        services = []
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[bleClient] getBLEDeviceServices threw:', e && e.errMsg)
        }
      }
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[bleClient] services attempt', attempt, services.map((s) => s.uuid))
      }
      // 宽松匹配：完全相等 或 包含关系（兼容 16 位短 UUID / 大小写 / 连字符差异）。
      svc = services.find((s) => {
        const u = normUuid(s.uuid)
        return u === targetSvc || u.indexOf(targetSvc) >= 0 || targetSvc.indexOf(u) >= 0
      })
      if (svc) break
    }
    if (!svc) {
      await wx.closeBLEConnection({ deviceId }).catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
      _deviceId = null
      throw new Error(`未找到 ${BLE.serviceUuid} 服务（设备可能不是 BTLight 固件）`)
    }
    _serviceId = svc.uuid

    // 特征发现同样做重试（部分机型需要 settling）。
    let chars = []
    let write = null
    let notifyCh = null
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 500))
      }
      try {
        const res = await wx.getBLEDeviceCharacteristics({
          deviceId,
          serviceId: _serviceId,
        })
        chars = (res && res.characteristics) || []
      } catch (e) {
        chars = []
      }
      write = chars.find((c) => c.properties && c.properties.write)
      notifyCh = chars.find((c) => c.properties && c.properties.notify)
      if (write && notifyCh) break
    }
    if (!write || !notifyCh) {
      await wx.closeBLEConnection({ deviceId }).catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
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

    // 写分片上限按协商 MTU 定一次（安卓 setBLEMTU / iOS 乐观值 + 首片降级）。
    await _negotiateMtu(deviceId)

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
    _chunk = WRITE_CHUNK // 分片上限随连接作废，下次连接重新协商
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

  // 协商写分片上限（连接期调用一次，ADR-0029）：
  //   - Android：wx.setBLEMTU(512) 成功 → 509 字节/包（协商值权威）；
  //   - iOS / 无该 API / 协商失败：平台自己会把 MTU 谈上去，先用 182 乐观值，
  //     平台实际收不下时（如固件是旧版、local MTU 仍为 23）由 sendCmd 首片降级。
  async function _negotiateMtu(deviceId) {
    const wx = _wx()
    _chunk = CHUNK_IOS
    if (typeof wx.setBLEMTU !== 'function') return
    try {
      await wx.setBLEMTU({ deviceId, mtu: MTU_REQUEST })
      _chunk = MTU_REQUEST - 3
    } catch (e) {
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[bleClient] setBLEMTU 失败，保持乐观分片', _chunk, e && e.errMsg)
      }
    }
  }

  // 编帧 → 按当前分片上限顺序写入写特征（同一时刻不并发，见 autoSync 单飞）。
  // 未连接 / 协议不兼容时 reject（ADR-0009：不兼容不下发命令）。
  // 首片被平台拒（errMsg 多为超出单次写上限）说明实际 MTU 没到乐观值：
  // 整帧退回 20 字节重发，并记住该上限。只在首片失败时降级——此时空口一个字节
  // 都没发出去，整帧重发不会在固件流式解析器里留下半截帧；中途失败交给上层重试。
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
    let sent = 0
    const writeAll = async (size) => {
      sent = 0
      for (let off = 0; off < frame.length; off += size) {
        const chunk = frame.slice(off, Math.min(off + size, frame.length))
        await wx.writeBLECharacteristicValue({
          deviceId: _deviceId,
          serviceId: _serviceId,
          characteristicId: _writeCharId,
          value: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
        })
        sent += chunk.byteLength
      }
    }
    try {
      await writeAll(_chunk)
    } catch (err) {
      if (sent > 0 || _chunk <= WRITE_CHUNK) throw err
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[bleClient] 分片', _chunk, '被平台拒，退回', WRITE_CHUNK, err && err.errMsg)
      }
      _chunk = WRITE_CHUNK
      await writeAll(_chunk)
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
    // 当前写分片上限（字节）：connect 时按 MTU 协商确定，降级后为 WRITE_CHUNK。
    get chunk() {
      return _chunk
    },
  }
}

// ---- 单例 seam（跨页共享同一连接，测试可注入 fake） ---------------------------

module.exports = {
  createBleClient,
  getCurrentBleClient,
  setCurrentBleClient,
  WRITE_CHUNK,
  MTU_REQUEST,
  CHUNK_IOS,
}

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