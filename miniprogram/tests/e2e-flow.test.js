// Jest 端到端（全流程打通）：跨真实模块串起
//   device-list（扫描/连接/保存）→ bleClient（GET_VERSION 协商 / 分片下发 / notify 重组）
//   → home（连接态展示）→ pin-detail（编辑/校验/编码/下发）→ errorHandler（错误提示+日志）。
//
// 与单测的区别：这里**不注入 fake client**，而是用真实 bleClient + 真实 deviceStore
// + 真实 configCodec + 真实页面，只把最底层 wx BLE/Storage 用 wx-mock 替身
// （ADR-0012 第 2 层「协议边界端到端」）。覆盖"调用顺序与参数"，不替代真机物理层
// （空口 MTU/notify 时序 → 见 docs/smoke-test.md）。
//
// 验证"端到端全流程打通"（#28 / T8 验收项）：一次完整用户旅程在 JS 逻辑层贯通。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { installWxMock } = require('./wx-mock')
const { createBleClient, setCurrentBleClient, getCurrentBleClient } = require('../utils/bleClient')
const { resetDeviceStore, listDevices, getDeviceConfig, getCurrentDeviceId } = require('../utils/deviceStore')
const { decodeConfigBlob } = require('../utils/configCodec')
const { FrameParser, PARSE_OK, decodeFrame } = require('../utils/frameParser')
const { setupBle, flush, statusFrame, notify } = require('./bleTestUtils')
const { CMD, NOTIFY, ERR } = require('../utils/protocol_gen')

const DEVICE_LIST = '../pages/device-list/device-list'
const HOME = '../pages/home/home'
const PIN_DETAIL = '../pages/pin-detail/pin-detail'

// 把 bleClient 通过 wx.writeBLECharacteristicValue 写出的所有分片按顺序拼接成字节流。
function writtenByteStream(wx) {
  const chunks = wx.writeBLECharacteristicValue.mock.calls.map((c) => new Uint8Array(c[0].value))
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return all
}

// 从写出的字节流里按帧解析出 [{ cmd, seq, payload }]（顺序即发送顺序）。
function writtenFrames(wx) {
  const parser = new FrameParser()
  parser.feed(writtenByteStream(wx))
  const frames = []
  const out = {}
  while (parser.next(out) === PARSE_OK) {
    frames.push({ cmd: out.cmd, seq: out.seq, payload: out.payload })
  }
  return frames
}

describe('端到端全流程（#28 / T8）', () => {
  let wx
  let app

  beforeEach(() => {
    wx = installWxMock()
    setupBle(wx)
    resetDeviceStore()
    setCurrentBleClient(null)
    // 全局单例 client：device-list 连接，home/pin-detail 复用同一连接（ADR-0023）。
    setCurrentBleClient(createBleClient())
    app = makeApp(null)
  })

  test('扫描 → 连接 → 版本协商 → 首页展示 → 引脚配置下发 → notify → 错误提示+日志', async () => {
    // ---- 1. 设备列表：扫描到 BTLight_ 设备 --------------------------------
    const listPage = loadPage(DEVICE_LIST, app)
    listPage.onShow()
    listPage.onTapAdd()
    await flush() // openBluetoothAdapter + startDiscovery

    wx.__trigger('onBluetoothDeviceFound', {
      devices: [
        { name: 'BTLight_A1B2', deviceId: 'dev-e2e', RSSI: -58 },
        { name: '杂项', deviceId: 'dev-junk', RSSI: -40 }, // 前缀不符：应被过滤
      ],
    })
    expect(listPage.data.found).toHaveLength(1)
    expect(listPage.data.found[0].deviceId).toBe('dev-e2e')

    // ---- 2. 点选连接：真实 bleClient 走 createBLEConnection→发现服务/特征→GET_VERSION
    await listPage.onTapFound({
      currentTarget: { dataset: { deviceId: 'dev-e2e', name: 'BTLight_A1B2' } },
    })
    await flush()

    const client = getCurrentBleClient()
    expect(client.connected).toBe(true)
    expect(wx.createBLEConnection).toHaveBeenCalledWith({ deviceId: 'dev-e2e' })
    // 设备已落盘 + 设为当前设备。
    expect(listDevices()).toHaveLength(1)
    expect(listDevices()[0].name).toBe('BTLight_A1B2')
    expect(getCurrentDeviceId()).toBe(listDevices()[0].id)
    expect(app.globalData.currentDeviceId).toBe(listDevices()[0].id)

    // 连接后首发 GET_VERSION（ADR-0009）。
    const afterConnect = writtenFrames(wx)
    expect(afterConnect.map((f) => f.cmd)).toEqual([CMD.GET_VERSION])

    // 固件回 VERSION notify（协议 1.0 兼容）→ 协商成功。
    notify(wx, statusFrame(NOTIFY.VERSION, 0, 0, [1, 0, 0, 1]), 'dev-e2e')
    expect(client.versionKnown).toBe(true)
    expect(client.compatible).toBe(true)

    // ---- 3. 首页：连接态 + 设备名展示 -------------------------------------
    const homePage = loadPage(HOME, app)
    homePage.onShow()
    expect(homePage.data.connected).toBe(true)
    expect(homePage.data.deviceName).toBe('BTLight_A1B2')

    // ---- 4. 引脚配置详情页：编辑默认灯组并保存（真实下发链路）--------------
    wx.writeBLECharacteristicValue.mockClear() // 只看保存链路的写入
    const pinPage = loadPage(PIN_DETAIL, app)
    pinPage.onLoad({ pin: '0' })
    // 改个引脚名 + 把灯珠区间拖选成 [2,4]（touchstart 格 2 → move 格 4 → end）。
    pinPage.onPinNameInput({ detail: { value: '客厅灯带' } })
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    wx.__cancelRect = null
    pinPage.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2
    pinPage.onLedTouchMove({ touches: [{ clientX: 270, clientY: 30 }] }) // 格 4
    pinPage.onLedTouchEnd({ type: 'touchend' })
    pinPage.onSave()
    await flush()

    // Storage 真相源已写入（未断线：connected 为 true，走下发）。
    const cfg = getDeviceConfig(listDevices()[0].id)
    const pin0 = cfg.pins.find((p) => p.pin === 0)
    expect(pin0.configured).toBe(true)
    expect(pin0.name).toBe('客厅灯带')

    // 下发链路：WRITE_CONFIG（blob）紧接 APPLY。
    const saved = writtenFrames(wx)
    expect(saved.map((f) => f.cmd)).toEqual([CMD.WRITE_CONFIG, CMD.APPLY])
    // WRITE_CONFIG 的 payload 解回配置，与 Storage 一致。
    const decoded = decodeConfigBlob(Uint8Array.from(saved[0].payload))
    expect(decoded.pins.find((p) => p.pin === 0).groups[0].ledEnd).toBe(4)
    // 两帧 seq 单调递增（GET_VERSION=0 → WRITE_CONFIG=1 → APPLY=2）。
    expect(saved[0].seq).toBe(1)
    expect(saved[1].seq).toBe(2)

    // 固件回 OK + STATE PLAYING（home 订阅的 notify 不崩溃）。
    notify(wx, statusFrame(NOTIFY.OK, CMD.WRITE_CONFIG, 1), 'dev-e2e')
    notify(wx, statusFrame(NOTIFY.STATE, 3, 2), 'dev-e2e')

    // ---- 5. 固件回 ERROR：友好提示 + 本地日志（不泄露裸码）----------------
    wx.showToast.mockClear()
    notify(wx, statusFrame(NOTIFY.ERROR, ERR.CONFIG_LIMIT_EXCEEDED, 2), 'dev-e2e')
    const toastArg = wx.showToast.mock.calls[wx.showToast.mock.calls.length - 1][0]
    expect(toastArg.icon).toBe('none')
    expect(toastArg.title).toMatch(/超限|上限|超出/)
    expect(toastArg.title).not.toContain('0x')

    const errLog = JSON.parse(wx.getStorageSync('error_log'))
    expect(errLog).toHaveLength(1)
    expect(errLog[0].code).toBe(ERR.CONFIG_LIMIT_EXCEEDED)
    expect(errLog[0].context).toBe('设备回传错误')
  })

  test('未连接时保存：落盘本地但不下发，提示连接后重新保存（真相源语义）', async () => {
    // 扫描到但不连接（直接构造一个未连接场景）：无 current 设备连接。
    setCurrentBleClient(createBleClient()) // connected=false
    app.globalData.currentDeviceId = null

    // 先存一个设备并设为当前，便于 pin-detail 取到 deviceId。
    const { saveDevice, setCurrentDeviceId } = require('../utils/deviceStore')
    const dev = saveDevice({ name: 'BTLight_X', deviceId: 'dev-offline' })
    setCurrentDeviceId(dev.id)
    app.globalData.currentDeviceId = dev.id

    const pinPage = loadPage(PIN_DETAIL, app)
    pinPage.onLoad({ pin: '0' })
    pinPage.onSave() // 未连接

    // 配置已落盘（Storage 真相源），但未写任何 BLE 命令。
    expect(getDeviceConfig(dev.id).pins.find((p) => p.pin === 0).configured).toBe(true)
    expect(wx.writeBLECharacteristicValue).not.toHaveBeenCalled()
    const toastArg = wx.showToast.mock.calls[wx.showToast.mock.calls.length - 1][0]
    expect(toastArg.title).toContain('未连接')
    expect(pinPage.data.dirty).toBe(false)
  })

  // 防御：decodeFrame 对完整帧 sanity（e2e 用的 FrameParser 与 decodeFrame 同源）。
  test('写出字节流里的 GET_VERSION 帧可被 decodeFrame 单独解析', async () => {
    const listPage = loadPage(DEVICE_LIST, app)
    listPage.onShow()
    await listPage.onTapFound({
      currentTarget: { dataset: { deviceId: 'dev-e2e', name: 'BTLight_A1B2' } },
    })
    await flush()
    const frames = writtenFrames(wx)
    const out = {}
    expect(decodeFrame(writtenByteStream(wx), out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.GET_VERSION)
    expect(frames).toHaveLength(1)
  })
})