// Jest 单测：miniprogram/utils/bleClient.js（ADR-0004 / 0009 / 0025 / 0026）。
//
// 覆盖（ADR-0012 第 2 层：BLE 协议边界，调用顺序与参数断言）：
//   - scanDevices：前缀过滤 / RSSI 去重合并 / stop 停止发现 / adapter 关闭
//   - connect：服务+特征发现 / 特征缺失报错 / notify 订阅 / MTU 协商 / GET_VERSION 首发
//   - sendCmd：帧编码 / 按协商 MTU 分包 / 首片被拒降级 20B / seq 递增 / 未连接拒绝
//   - notify：任意分片重组 / STATUS_NOTIFY 解析（版本兼容 / 错误 / 状态）
//   - 版本不兼容：状态机进入 incompatible
//   - disconnect：关闭连接 + 状态复位
//
// 依赖 frameParser 已单测的编解码原语；本文件用独立构造的帧字节（buildFrameBytes）
// 作为输入向量，避免与 encodeFrame 循环验证。

'use strict'

const { installWxMock } = require('./wx-mock')
const { encodeFrame, decodeFrame, PARSE_OK } = require('../utils/frameParser')
const { CMD, ERR, NOTIFY, BLE, PROTOCOL_VERSION, FIRMWARE_VERSION } = require('../utils/protocol_gen')
const { createBleClient, WRITE_CHUNK, CHUNK_IOS } = require('../utils/bleClient')
const { buildFrameBytes, statusFrame, notify, setupBle } = require('./bleTestUtils')

// 把 Uint8Array 切成固定长度分片，模拟 BLE 任意分包。
function fragment(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const SERVICES_OK = [
  { uuid: '00001800-0000-1000-8000-00805F9B34FB' }, // 无关服务（排除项）
  { uuid: BLE.serviceUuid, isPrimary: true },
]
const CHARS_OK = [
  { uuid: '00002A00-0000-1000-8000-00805F9B34FB', properties: { read: true } },
  { uuid: BLE.writeCharUuid, properties: { write: true, writeNoResponse: true } },
  { uuid: BLE.notifyCharUuid, properties: { notify: true } },
]

// 从 writeBLECharacteristicValue 的调用参数取帧字节（value 为 ArrayBuffer，
// 转为 Uint8Array 供 frameParser 解码）。
function writtenFrame(callIndex) {
  const arg = wx.writeBLECharacteristicValue.mock.calls[callIndex][0]
  return new Uint8Array(arg.value)
}

describe('bleClient', () => {
  let wx
  let client

  beforeEach(() => {
    wx = installWxMock()
    client = createBleClient()
    // 默认特征发现结果：写入/通知特征齐备。
    wx.getBLEDeviceServices.mockImplementation(() =>
      Promise.resolve({ services: SERVICES_OK })
    )
    wx.getBLEDeviceCharacteristics.mockImplementation(() =>
      Promise.resolve({ characteristics: CHARS_OK })
    )
  })

  // ---- scanDevices ---------------------------------------------------------

  test('scanDevices 按广播名前缀过滤，RSSI 取多次上报最大值（deviceId 去重）', async () => {
    const found = []
    client.scanDevices({ onFound: (d) => found.push(d) })
    await flush() // 等 startBluetoothDevicesDiscovery 完成

    wx.__trigger('onBluetoothDeviceFound', {
      devices: [
        { name: 'BTLight_A1B2', deviceId: 'dev-1', RSSI: -60 },
        { name: '小米手环', deviceId: 'dev-x', RSSI: -40 },
        { name: 'BTLight_C3D4', deviceId: 'dev-2', RSSI: -70 },
      ],
    })
    wx.__trigger('onBluetoothDeviceFound', {
      devices: [{ name: 'BTLight_A1B2', deviceId: 'dev-1', RSSI: -55 }],
    })

    // onFound 每次上报都会回调（页面用 deviceId 去重合并）；
    // RSSI 取历史最大值（-55 > -60）。
    const byId = new Map(found.map((d) => [d.deviceId, d]))
    expect(byId.size).toBe(2)
    expect(byId.get('dev-1')).toEqual({ name: 'BTLight_A1B2', deviceId: 'dev-1', RSSI: -55 })
    expect(byId.get('dev-2')).toEqual({ name: 'BTLight_C3D4', deviceId: 'dev-2', RSSI: -70 })
  })

  test('scanDevices stop 停止发现并关闭适配器', async () => {
    const handle = client.scanDevices({ onFound: jest.fn() })
    await flush()
    expect(wx.startBluetoothDevicesDiscovery).toHaveBeenCalledTimes(1)
    handle.stop()
    expect(wx.stopBluetoothDevicesDiscovery).toHaveBeenCalledTimes(1)
    expect(wx.closeBluetoothAdapter).toHaveBeenCalledTimes(1)
  })

  test('scanDevices openBluetoothAdapter 失败时回调 onError', async () => {
    wx.openBluetoothAdapter.mockImplementation(() =>
      Promise.reject({ errMsg: 'openBluetoothAdapter:fail not available' })
    )
    const onError = jest.fn()
    client.scanDevices({ onFound: jest.fn(), onError })
    await flush()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  // ---- connect --------------------------------------------------------------

  test('connect 打开适配器→发现服务/特征→订阅 notify→首发 GET_VERSION', async () => {
    const info = await client.connect('dev-1')
    expect(info.deviceId).toBe('dev-1')
    expect(wx.createBLEConnection).toHaveBeenCalledWith({ deviceId: 'dev-1' })
    expect(wx.getBLEDeviceServices).toHaveBeenCalledWith({ deviceId: 'dev-1' })
    expect(wx.getBLEDeviceCharacteristics).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      serviceId: BLE.serviceUuid,
    })
    expect(wx.notifyBLECharacteristicValueChange).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      serviceId: BLE.serviceUuid,
      characteristicId: BLE.notifyCharUuid,
      state: true,
    })
    // 连接后第一件事发 GET_VERSION（ADR-0009）。
    expect(wx.writeBLECharacteristicValue).toHaveBeenCalledTimes(1)
    const out = { cmd: 0, seq: 0, payload: null }
    expect(decodeFrame(writtenFrame(0), out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.GET_VERSION)
  })

  test('connect 找不到自定义服务时报错且不写命令', async () => {
    wx.getBLEDeviceServices.mockImplementation(() =>
      Promise.resolve({ services: [{ uuid: '00001800-0000-1000-8000-00805F9B34FB' }] })
    )
    await expect(client.connect('dev-1')).rejects.toThrow(/服务/)
    expect(wx.writeBLECharacteristicValue).not.toHaveBeenCalled()
  })

  test('connect 写特征缺失时报错', async () => {
    wx.getBLEDeviceCharacteristics.mockImplementation(() =>
      Promise.resolve({ characteristics: [CHARS_OK[0]] })
    )
    await expect(client.connect('dev-1')).rejects.toThrow(/特征/)
  })

  test('connect 成功后 connected=true，失败时保持 false', async () => {
    await client.connect('dev-1')
    expect(client.connected).toBe(true)
    wx.createBLEConnection.mockImplementationOnce(() => Promise.reject(new Error('timeout')))
    const c2 = createBleClient()
    await expect(c2.connect('dev-1')).rejects.toThrow('timeout')
    expect(c2.connected).toBe(false)
  })

  // ---- sendCmd --------------------------------------------------------------

  test('sendCmd 按协商 MTU 分包（setBLEMTU 成功 → 509B/包），seq 从 0 单调递增', async () => {
    await client.connect('dev-1')
    // connect 期协商：请求 512（wx.setBLEMTU 上限）→ 负载 512-3 = 509。
    expect(wx.setBLEMTU).toHaveBeenCalledWith({ deviceId: 'dev-1', mtu: 512 })
    expect(client.chunk).toBe(509)
    wx.writeBLECharacteristicValue.mockClear()

    // 600 字节 payload → 607 字节整帧 → 2 次写入（509 + 98）。
    const payload = new Uint8Array(600).fill(0x5a)
    await client.sendCmd(CMD.WRITE_CONFIG, payload)

    expect(wx.writeBLECharacteristicValue).toHaveBeenCalledTimes(2)
    expect(writtenFrame(0).byteLength).toBe(509)
    expect(writtenFrame(1).byteLength).toBe(98)

    // 重组两次写入 = 一个合法帧。
    const joined = new Uint8Array(607)
    joined.set(new Uint8Array(writtenFrame(0)), 0)
    joined.set(new Uint8Array(writtenFrame(1)), 509)
    const out = { cmd: 0, seq: 0, payload: null }
    expect(decodeFrame(joined, out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.WRITE_CONFIG)
    expect(out.seq).toBe(1) // GET_VERSION 占了 seq 0
    expect(out.payload).toEqual(payload)

    await client.sendCmd(CMD.APPLY, [])
    const out2 = { cmd: 0, seq: 0, payload: null }
    decodeFrame(writtenFrame(2), out2)
    expect(out2.seq).toBe(2)
  })

  test('无 setBLEMTU（iOS）：先用 182 乐观分片', async () => {
    wx.setBLEMTU = undefined // iOS 无该 API
    await client.connect('dev-1')
    expect(client.chunk).toBe(CHUNK_IOS)
    wx.writeBLECharacteristicValue.mockClear()

    // 200 字节 payload → 207 字节整帧 → 2 次写入（182 + 25）。
    await client.sendCmd(CMD.WRITE_CONFIG, new Uint8Array(200).fill(0x7b))
    expect(wx.writeBLECharacteristicValue).toHaveBeenCalledTimes(2)
    expect(writtenFrame(0).byteLength).toBe(CHUNK_IOS)
    expect(writtenFrame(1).byteLength).toBe(207 - CHUNK_IOS)
  })

  test('首片被平台拒（MTU 没到位）：整帧退回 20B 重发，并保持该会话上限', async () => {
    await client.connect('dev-1')
    expect(client.chunk).toBe(509)
    // 平台只收得下 20B（旧固件 local MTU 仍为 23）：大包一律拒绝。
    const write = wx.writeBLECharacteristicValue
    write.mockClear()
    write.mockImplementation((arg) => {
      const n = arg.value.byteLength
      return n > WRITE_CHUNK
        ? Promise.reject(new Error('exceed max data length'))
        : Promise.resolve({})
    })

    // 30 字节 payload → 37 字节整帧：首片 37B 被拒（空口未发）→ 退回 20B 重发。
    const payload = new Uint8Array(30).fill(0x11)
    await client.sendCmd(CMD.WRITE_CONFIG, payload)

    // 首次失败的 37B 尝试 + 降级后的 20 + 17。
    expect(write).toHaveBeenCalledTimes(3)
    expect(writtenFrame(1).byteLength).toBe(WRITE_CHUNK)
    expect(writtenFrame(2).byteLength).toBe(17)
    const joined = new Uint8Array(37)
    joined.set(new Uint8Array(writtenFrame(1)), 0)
    joined.set(new Uint8Array(writtenFrame(2)), 20)
    const out = { cmd: 0, seq: 0, payload: null }
    expect(decodeFrame(joined, out)).toBe(PARSE_OK)
    expect(out.payload).toEqual(payload)
    expect(client.chunk).toBe(WRITE_CHUNK) // 会话内不再试探大包

    // 后续命令直接用 20B，不再有失败尝试。
    write.mockClear()
    await client.sendCmd(CMD.APPLY, [])
    expect(write).toHaveBeenCalledTimes(1)
    expect(writtenFrame(0).byteLength).toBe(7)
  })

  test('中途失败不降级重发（避免半截帧污染固件解析流）', async () => {
    await client.connect('dev-1')
    let call = 0
    const write = wx.writeBLECharacteristicValue
    write.mockClear()
    write.mockImplementation(() => {
      call++
      return call === 2 ? Promise.reject(new Error('GATT busy')) : Promise.resolve({})
    })
    // 600 字节 → 2 片：第 2 片失败 → 直接抛错，不整帧重发。
    await expect(client.sendCmd(CMD.WRITE_CONFIG, new Uint8Array(600))).rejects.toThrow(/GATT busy/)
    expect(write).toHaveBeenCalledTimes(2)
    expect(client.chunk).toBe(509)
  })

  test('sendCmd 未连接时抛错', async () => {
    await expect(client.sendCmd(CMD.APPLY, [])).rejects.toThrow(/未连接/)
    expect(wx.writeBLECharacteristicValue).not.toHaveBeenCalled()
  })

  // ---- notify 重组与 STATUS_NOTIFY 解析 ----------------------------------------

  test('notify 分片任意切分均可重组（逐字节喂）', async () => {
    const onStatus = jest.fn()
    client.onStatus(onStatus)
    await client.connect('dev-1')

    const frame = statusFrame(NOTIFY.STATE, 3, 1) // PLAYING
    for (const chunk of fragment(frame, 1)) notify(wx, chunk)

    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onStatus.mock.calls[0][0]).toEqual({ type: 'state', state: 3 })
  })

  test('notify VERSION：协议版本匹配 → versionKnown，兼容时 compatible=true', async () => {
    const onStatus = jest.fn()
    client.onStatus(onStatus)
    await client.connect('dev-1')

    // data: [protoMajor, protoMinor, fwMajor, fwMinor]，取当前版本（versions.csv）——
    // 协议升版不必改这份 fixture，"兼容/不兼容"的判定仍由下面的期望值锁住。
    notify(wx, statusFrame(NOTIFY.VERSION, 0, 0, [
      PROTOCOL_VERSION.major, PROTOCOL_VERSION.minor,
      FIRMWARE_VERSION.major, FIRMWARE_VERSION.minor,
    ]))
    expect(onStatus.mock.calls[0][0]).toEqual({
      type: 'version',
      protocol: PROTOCOL_VERSION.string,
      firmware: FIRMWARE_VERSION.string,
      compatible: true,
    })
    expect(client.versionKnown).toBe(true)
    expect(client.compatible).toBe(true)
  })

  test('notify VERSION：协议主版本不符 → compatible=false 并回调', async () => {
    const onStatus = jest.fn()
    client.onStatus(onStatus)
    await client.connect('dev-1')

    notify(wx, statusFrame(NOTIFY.VERSION, 0, 0, [2, 0, 0, 1]))
    expect(onStatus.mock.calls[0][0].compatible).toBe(false)
    expect(client.compatible).toBe(false)
  })

  test('notify ERROR：按错误码回传（ADR-0026 文案映射在 errorHandler，T8）', async () => {
    const onStatus = jest.fn()
    client.onStatus(onStatus)
    await client.connect('dev-1')

    notify(wx, statusFrame(NOTIFY.ERROR, ERR.CRC_ERROR, 1))
    expect(onStatus.mock.calls[0][0]).toEqual({ type: 'error', code: ERR.CRC_ERROR })
  })

  test('notify 帧间垃圾字节与坏 CRC 不影响后续帧', async () => {
    const onStatus = jest.fn()
    client.onStatus(onStatus)
    await client.connect('dev-1')

    const good = statusFrame(NOTIFY.STATE, 3, 1)
    notify(wx, new Uint8Array([0x00, 0x11, 0x22])) // 垃圾前缀
    notify(wx, buildFrameBytes(CMD.STATUS_NOTIFY, 0, [0xff, 0xff, 0])) // 坏 CRC 帧
    notify(wx, good)

    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledWith({ type: 'state', state: 3 })
  })

  test('onStatus 返回退订函数；退订后不再接收', async () => {
    const onStatus = jest.fn()
    const off = client.onStatus(onStatus)
    expect(typeof off).toBe('function')
    await client.connect('dev-1')
    notify(wx, statusFrame(NOTIFY.STATE, 1))
    expect(onStatus).toHaveBeenCalledTimes(1)
    off()
    notify(wx, statusFrame(NOTIFY.STATE, 3))
    expect(onStatus).toHaveBeenCalledTimes(1)
  })

  // ---- 连接状态事件 -----------------------------------------------------------

  test('onConnectionStateChange：连接断开事件通知订阅者并复位 connected', async () => {
    const onChange = jest.fn()
    client.onConnectionStateChange(onChange)
    await client.connect('dev-1')
    expect(onChange).toHaveBeenCalledWith({ connected: true })

    wx.__trigger('onBLEConnectionStateChange', { deviceId: 'dev-1', connected: false })
    expect(onChange).toHaveBeenLastCalledWith({ connected: false })
    expect(client.connected).toBe(false)
  })

  // ---- disconnect ---------------------------------------------------------------

  test('disconnect 关闭连接并复位状态', async () => {
    await client.connect('dev-1')
    await client.disconnect()
    expect(wx.closeBLEConnection).toHaveBeenCalledWith({ deviceId: 'dev-1' })
    expect(client.connected).toBe(false)
    expect(client.deviceId).toBeNull()
  })

  // ---- adapter 关闭后防御 --------------------------------------------------------

  test('适配器已关闭时 sendCmd 报错而非崩溃', async () => {
    await client.connect('dev-1')
    await client.closeAdapter()
    await expect(client.sendCmd(CMD.APPLY, [])).rejects.toThrow()
  })

  // ---- 单例 seam（跨页共享同一连接，测试注入 fake） ------------------------------

  test('getCurrentBleClient/setCurrentBleClient：注入与读取', () => {
    const { getCurrentBleClient, setCurrentBleClient } = require('../utils/bleClient')
    expect(getCurrentBleClient()).toBeNull()
    const fake = { connect: jest.fn(), connected: false }
    setCurrentBleClient(fake)
    expect(getCurrentBleClient()).toBe(fake)
    setCurrentBleClient(null)
    expect(getCurrentBleClient()).toBeNull()
  })

  // ---- 序列号回绕 --------------------------------------------------------------

  test('seq 在 256 次发送后回绕（uint8）', async () => {
    await client.connect('dev-1')
    wx.writeBLECharacteristicValue.mockClear()
    for (let i = 0; i < 256; i++) await client.sendCmd(CMD.APPLY, [])
    const out = { cmd: 0, seq: 0, payload: null }
    decodeFrame(writtenFrame(0), out)
    const seq0 = out.seq
    decodeFrame(writtenFrame(255), out)
    expect(out.seq).toBe((seq0 + 255) & 0xff)
  })
})

// 等所有 Promise 微任务 + 假定时器：wx mock 是立即 resolve 的 Promise。
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}