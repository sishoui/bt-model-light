// Jest 单测：miniprogram/pages/home/home.js（#25 首页 = 设备 Tab 默认页，ADR-0027）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const {
  saveDevice,
  saveDeviceConfig,
  getDeviceConfig,
  getDeviceBrightness,
  getDevicePower,
  listDevices,
  resetDeviceStore,
} = require('../utils/deviceStore')
const { createBleClient, setCurrentBleClient } = require('../utils/bleClient')
const { setupBle, flush } = require('./bleTestUtils')
const { statusFrame, notify } = require('./bleTestUtils')
const { decodeConfigBlob } = require('../utils/configCodec')
const autoSync = require('../utils/autoSync')
const { CMD, NOTIFY, BLE } = require('../utils/protocol_gen')

const HOME = '../pages/home/home'

// fake BLE 客户端（同 pin-detail.test.js）：只看 connected + sendCmd 顺序/参数。
// home 还会订阅 onStatus/onConnectionStateChange 并在未连接时自动重连（connect）。
function fakeClient(connected) {
  return {
    connected: !!connected,
    sendCmd: jest.fn(() => Promise.resolve()),
    connect: jest.fn(() => Promise.resolve()),
    onStatus: jest.fn(() => () => {}),
    onConnectionStateChange: jest.fn(() => () => {}),
  }
}

// 已配置引脚的最小合法灯组（[0,9] 常亮）。
function samplePin(extra) {
  return Object.assign(
    {
      pin: 0,
      configured: true,
      name: 'P',
      groups: [
        {
          ledStart: 0,
          ledEnd: 9,
          steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: 1, params: { color: [1, 2, 3], brightness: 200 } }] }],
        },
      ],
    },
    extra || {}
  )
}

describe('home 页（#25）', () => {
  let wx
  let app

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    autoSync.reset()
    app = makeApp(null)
    setCurrentBleClient(null)
  })

  test('未选中设备：标题空、无引脚卡片', () => {
    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.deviceName).toBe('')
    expect(page.data.connected).toBe(false)
    expect(page.data.pins).toEqual([])
  })

  test('已保存设备：固定展示 8 个引脚卡片（含未配置占位）', () => {
    const dev = saveDevice({ name: 'BTLight_A1B2', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, {
      pins: [
        { pin: 0, configured: true, groups: [{}, {}] },
        { pin: 3, configured: false, groups: [] }, // 未配置：占位卡
        { pin: 5, configured: true, groups: [{}] },
      ],
    })
    app.globalData.currentDeviceId = dev.id

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.deviceName).toBe('BTLight_A1B2')
    // 8 个引脚一个不少，按 0..7 排列。
    expect(page.data.pins).toHaveLength(8)
    expect(page.data.pins.map((p) => p.pin)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // 已配置：名称/灯组数；未配置：占位文案。
    expect(page.data.pins[0].configured).toBe(true)
    expect(page.data.pins[0].info).toBe('2 个灯组')
    expect(page.data.pins[0].name).toBe('引脚 1') // 默认名：pin + 1
    expect(page.data.pins[1].configured).toBe(false)
    expect(page.data.pins[1].info).toBe('未配置')
    expect(page.data.pins[5].configured).toBe(true)
    expect(page.data.pins[7].configured).toBe(false)
  })

  test('无设备配置：8 个引脚全部为未配置占位', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.pins).toHaveLength(8)
    expect(page.data.pins.every((p) => !p.configured)).toBe(true)
  })

  test('引脚卡片数据带上自定义名称', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, {
      pins: [{ pin: 0, configured: true, name: '客厅灯带', groups: [{}] }],
    })
    app.globalData.currentDeviceId = dev.id

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.pins[0].name).toBe('客厅灯带')
  })

  test('左上设备名称点击 → navigateTo 设备列表页', () => {
    const page = loadPage(HOME, app)
    page.onTapDeviceName()
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/device-list/device-list' })
  })

  test('BLE 连接成功 → 页面 connected=true 且标题显示设备名', async () => {
    setupBle(wx)
    const dev = saveDevice({ name: 'BTLight_A1B2', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, { pins: [{ pin: 0, configured: true, groups: [{}] }] })
    app.globalData.currentDeviceId = dev.id

    const client = createBleClient()
    setCurrentBleClient(client)
    await client.connect('dev-1')

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.connected).toBe(true)
    expect(page.data.deviceName).toBe('BTLight_A1B2')
  })

  test('连接状态事件 → 页面 connected 翻转', async () => {
    setupBle(wx)
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id

    const client = createBleClient()
    setCurrentBleClient(client)
    await client.connect('dev-1')

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.connected).toBe(true)

    wx.__trigger('onBLEConnectionStateChange', { deviceId: 'dev-1', connected: false })
    expect(page.data.connected).toBe(false)
  })

  test('STATUS_NOTIFY error → 友好文案 Toast + 写本地日志（T8 / ADR-0026）', async () => {
    setupBle(wx)

    const client = createBleClient()
    setCurrentBleClient(client)
    await client.connect('dev-1')

    const page = loadPage(HOME, app)
    page.onShow()

    // 0x01 = CRC_ERROR → 文案表（errorHandler），不泄露裸码。
    notify(wx, statusFrame(NOTIFY.ERROR, 0x01, 1))
    const arg = wx.showToast.mock.calls[wx.showToast.mock.calls.length - 1][0]
    expect(arg.icon).toBe('none')
    expect(arg.title).toMatch(/校验|数据/)
    expect(arg.title).not.toContain('0x') // 不泄露协议码
    // 本地日志 error_log 记录一条。
    const log = JSON.parse(wx.getStorageSync('error_log'))
    expect(log).toHaveLength(1)
    expect(log[0].code).toBe(0x01)
  })

  test('STATUS_NOTIFY version 不兼容 → Modal 提示升级 + 写本地日志（ADR-0009 / 0026）', async () => {
    setupBle(wx)

    const client = createBleClient()
    setCurrentBleClient(client)
    await client.connect('dev-1')

    const page = loadPage(HOME, app)
    page.onShow()

    notify(wx, statusFrame(NOTIFY.VERSION, 0, 0, [2, 0, 0, 1]))
    expect(wx.showModal).toHaveBeenCalled()
    const arg = wx.showModal.mock.calls[wx.showModal.mock.calls.length - 1][0]
    expect(arg.title).toBe('版本不兼容')
    // 版本不兼容属关键错误，写本地日志便于排障（ADR-0026）。
    const log = JSON.parse(wx.getStorageSync('error_log'))
    expect(log).toHaveLength(1)
    expect(log[0].context).toBe('版本不兼容')
  })

  // ---- 整机开关：设备级总开关（ADR-0032） -------------------------------------

  test('整机关机 → 只发 SET_POWER 0；各引脚开关状态原样保留（不改写、不下发配置）', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    // pin 0 开着（无 power 字段），pin 3 之前被单独关掉（power=false）。
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [samplePin({ pin: 0 }), samplePin({ pin: 3, power: false })],
    })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(true)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.power).toBe(true) // 设备默认开着 → 按钮显示“关机”

    page.onTogglePower()
    expect(page.data.power).toBe(false)

    // 引擎状态不变：pin 0 仍开、pin 3 仍关；设备级开关落在设备记录上。
    const saved = getDeviceConfig(dev.id).pins
    expect(saved.find((p) => p.pin === 0).power).not.toBe(false)
    expect(saved.find((p) => p.pin === 3).power).toBe(false)
    resetDeviceStore() // 页面副本写的是同一份 Storage，清缓存才能读回（同 brightness）
    expect(getDevicePower(dev.id)).toBe(false)

    await flush()
    expect(client.sendCmd.mock.calls).toEqual([[CMD.SET_POWER, [0]]]) // 没有 WRITE_CONFIG/APPLY
  })

  test('整机开机 → 只发 SET_POWER 1；之前手动关掉的引脚仍是关', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [samplePin({ pin: 0 }), samplePin({ pin: 3, power: false })],
    })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(true)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    page.onTogglePower() // 关
    await flush()
    client.sendCmd.mockClear()

    page.onTogglePower() // 开
    expect(page.data.power).toBe(true)
    await flush()
    expect(client.sendCmd.mock.calls).toEqual([[CMD.SET_POWER, [1]]])
    // 引脚状态全程未被改写：pin 3 仍是关（开机不等于全开）。
    const saved = getDeviceConfig(dev.id).pins
    expect(saved.find((p) => p.pin === 3).power).toBe(false)
  })

  test('设备关机：引脚卡片不可点、开关不可切换，点了也不落盘', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, { version: 1, pins: [samplePin({ pin: 0 })] })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(true)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    page.onTogglePower() // 关机
    await flush()
    client.sendCmd.mockClear()

    page.onTapPin({ currentTarget: { dataset: { pin: 0 } } })
    expect(wx.navigateTo).not.toHaveBeenCalled() // 灰卡不可进配置页
    page.onPinPowerChange({ currentTarget: { dataset: { pin: 0 } }, detail: { value: false } })
    expect(page.data.pins[0].power).toBe(true) // 开关状态不动
    expect(getDeviceConfig(dev.id).pins[0].power).not.toBe(false)
    expect(client.sendCmd).not.toHaveBeenCalled()
  })

  test('整机开关落盘在设备记录：切页/重建页面后仍是关机；默认开着', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.power).toBe(true) // 缺省 = 开（与固件默认一致）

    page.onTogglePower()
    resetDeviceStore()
    expect(getDevicePower(dev.id)).toBe(false)
    const page2 = loadPage(HOME, app) // 模拟重进页面
    page2.onShow()
    expect(page2.data.power).toBe(false)
  })

  // ---- 整体亮度（ADR-0031） --------------------------------------------------

  test('亮度松手：落盘设备记录 + 下发 SET_BRIGHTNESS 最终值', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(true)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    page.onBrightnessChange({ detail: { value: 40 } })
    expect(page.data.brightness).toBe(40)
    resetDeviceStore() // 页面副本写的是同一份 Storage，清缓存才能读回（同 pin-detail.test.js）
    expect(getDeviceBrightness(dev.id)).toBe(40) // Storage 落盘（页面重建不丢）

    await flush()
    expect(client.sendCmd.mock.calls).toEqual([[CMD.SET_BRIGHTNESS, [40]]])
  })

  test('拖动中实时下发但不落盘；在途合并为最新值', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(true)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    page.onBrightnessChanging({ detail: { value: 200 } })
    page.onBrightnessChanging({ detail: { value: 100 } }) // 在途 → 合并
    page.onBrightnessChanging({ detail: { value: 60 } })
    expect(page.data.brightness).toBe(60)
    resetDeviceStore()
    expect(getDeviceBrightness(dev.id)).toBe(255) // 拖动中不落盘

    await flush()
    // 首个已发出；后面两次合并成最新值再发一次（不逐帧塞满空口）。
    expect(client.sendCmd.mock.calls).toEqual([
      [CMD.SET_BRIGHTNESS, [200]],
      [CMD.SET_BRIGHTNESS, [60]],
    ])
  })

  test('没设置过亮度的设备：滑块显示 255（与固件默认一致），无空口流量', () => {    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(true)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.brightness).toBe(255)
    expect(client.sendCmd).not.toHaveBeenCalled()
  })

  test('无当前设备：拖动/松手亮度只动界面，不落盘、不产生垃圾设备记录', () => {
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = loadPage(HOME, app) // app.globalData.currentDeviceId 为空
    page.onShow()

    expect(() => {
      page.onBrightnessChanging({ detail: { value: 90 } })
      page.onBrightnessChange({ detail: { value: 90 } })
      page.onTogglePower()
    }).not.toThrow()
    expect(page.data.brightness).toBe(90)
    expect(client.sendCmd).not.toHaveBeenCalled()
    expect(listDevices()).toEqual([]) // 不得凭空造设备条目
  })

  test('未连接：亮度只落盘 + 状态 local，不写空口；连接后补发', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(false)
    setCurrentBleClient(client)

    const snaps = []
    const off = autoSync.subscribe((s) => snaps.push(s.state))

    const page = loadPage(HOME, app)
    page.onShow()
    page.onBrightnessChange({ detail: { value: 30 } })
    resetDeviceStore()
    expect(getDeviceBrightness(dev.id)).toBe(30)
    expect(client.sendCmd).not.toHaveBeenCalled()
    expect(snaps[snaps.length - 1]).toBe('local')

    // 连接建立 → 防抖窗口后补发一次（避开 connect 内 GET_VERSION 的分片交错）。
    client.connected = true
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    autoSync.onConnected()
    jest.advanceTimersByTime(500)
    await flush()
    jest.useRealTimers()

    expect(client.sendCmd.mock.calls).toEqual([[CMD.SET_BRIGHTNESS, [30]]])
    off()
  })

  test('重连补发顺序：整机开关先于整机亮度（1 字节命令优先，配置最后）', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, { version: 1, pins: [samplePin({ pin: 0 })] })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(false)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    page.onBrightnessChange({ detail: { value: 30 } }) // 未连接 → 仅落盘 + pending
    page.onTogglePower() // 未连接 → 仅落盘 + pending

    client.connected = true
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    autoSync.onConnected()
    jest.advanceTimersByTime(500)
    await flush()
    jest.useRealTimers()

    expect(client.sendCmd.mock.calls).toEqual([
      [CMD.SET_POWER, [0]],
      [CMD.SET_BRIGHTNESS, [30]],
    ])
  })

  test('引脚卡片点击 → navigateTo 引脚配置详情页（带 pin）', () => {
    const page = loadPage(HOME, app)
    page.onTapPin({ currentTarget: { dataset: { pin: 2 } } })
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/pin-detail/pin-detail?pin=2' })
  })

  test('未配置引脚卡片点击同样进入配置详情页（固定 8 引脚，无新增入口）', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    const page = loadPage(HOME, app)
    page.onShow()
    // 未配置引脚（如 pin 7）点击 → 直接进配置页。
    page.onTapPin({ currentTarget: { dataset: { pin: 7 } } })
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/pin-detail/pin-detail?pin=7' })
    // 不再有"新增引脚"选择器入口。
    expect(page.onAddPin).toBeUndefined()
  })

  test('引脚卡片带出 power/img（#27 接入）', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, {
      pins: [{ pin: 0, configured: true, name: 'P', power: true, img: 'x.png', groups: [{}] }],
    })
    app.globalData.currentDeviceId = dev.id
    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.pins[0].power).toBe(true)
    expect(page.data.pins[0].img).toBe('x.png')
  })

  // ---- 引脚卡片灯带开关（ADR-0028） ------------------------------------------

  test('开关关闭 → 落盘 + 立即下发（不等防抖）blob 该引脚无灯组（真灭），打开恢复', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, { version: 1, pins: [samplePin({ power: true })] })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(true)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.pins[0].power).toBe(true)

    page.onPinPowerChange({ currentTarget: { dataset: { pin: 0 } }, detail: { value: false } })
    // 卡片开关即时反映；Storage 落盘 false，且灯组配置完整保留（真相源不丢配置）。
    expect(page.data.pins[0].power).toBe(false)
    const savedOff = getDeviceConfig(dev.id).pins.find((p) => p.pin === 0)
    expect(savedOff.power).toBe(false)
    expect(savedOff.groups).toHaveLength(1)

    // 离散动作跳过 500ms 防抖（ADR-0029）：不推进任何定时器，微任务走完就已下发。
    await flush()
    expect(client.sendCmd.mock.calls.map((c) => c[0])).toEqual([CMD.WRITE_CONFIG, CMD.APPLY])
    expect(decodeConfigBlob(Uint8Array.from(client.sendCmd.mock.calls[0][1])).pins).toEqual([])

    // 打开：同一份 Storage 配置立即恢复下发，灯组回来。
    client.sendCmd.mockClear()
    page.onPinPowerChange({ currentTarget: { dataset: { pin: 0 } }, detail: { value: true } })
    expect(page.data.pins[0].power).toBe(true)
    expect(getDeviceConfig(dev.id).pins.find((p) => p.pin === 0).power).toBe(true)
    await flush()
    const onPin = decodeConfigBlob(Uint8Array.from(client.sendCmd.mock.calls[0][1])).pins.find((p) => p.pin === 0)
    expect(onPin.groups[0].ledEnd).toBe(9)
  })

  test('未连接：开关落盘 + 状态 local（不写空口），不崩', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, { version: 1, pins: [samplePin({ power: true })] })
    app.globalData.currentDeviceId = dev.id
    const client = fakeClient(false)
    setCurrentBleClient(client)

    const page = loadPage(HOME, app)
    page.onShow()
    page.onPinPowerChange({ currentTarget: { dataset: { pin: 0 } }, detail: { value: false } })
    expect(getDeviceConfig(dev.id).pins.find((p) => p.pin === 0).power).toBe(false)
    expect(client.sendCmd).not.toHaveBeenCalled()
  })

  test('老配置无 power 字段 → 卡片开关默认开（配好就亮）', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, { version: 1, pins: [samplePin()] })
    app.globalData.currentDeviceId = dev.id
    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.pins[0].power).toBe(true)
  })

  test('无当前设备 / 未配置引脚：开关回调安全返回（不落盘、不抛错）', () => {
    const page = loadPage(HOME, app)
    page.onShow() // 无当前设备
    expect(() =>
      page.onPinPowerChange({ currentTarget: { dataset: { pin: 0 } }, detail: { value: false } })
    ).not.toThrow()

    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, { version: 1, pins: [samplePin()] })
    app.globalData.currentDeviceId = dev.id
    const page2 = loadPage(HOME, app)
    page2.onShow()
    // pin 3 无配置条目（WXML 不渲染其开关）：忽略，不动已配置的 pin 0。
    page2.onPinPowerChange({ currentTarget: { dataset: { pin: 3 } }, detail: { value: false } })
    expect(getDeviceConfig(dev.id).pins.map((p) => p.pin)).toEqual([0])
  })

  test('存量配置非法：开关不落盘、Toast 提示并回弹（不写成半截配置）', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    const bad = samplePin({ power: true })
    bad.groups[0].steps[0].duration = 0 // 越界：validateConfig 拒绝
    saveDeviceConfig(dev.id, { version: 1, pins: [bad] })
    app.globalData.currentDeviceId = dev.id

    const page = loadPage(HOME, app)
    page.onShow()
    page.onPinPowerChange({ currentTarget: { dataset: { pin: 0 } }, detail: { value: false } })
    expect(getDeviceConfig(dev.id).pins[0].power).toBe(true) // 未落盘
    expect(page.data.pins[0].power).toBe(true) // 开关回弹到真实状态
    const arg = wx.showToast.mock.calls[wx.showToast.mock.calls.length - 1][0]
    expect(arg.icon).toBe('none')
    expect(arg.title).toMatch(/无效/)
  })

  // ---- 亮度历史 sparkline ------------------------------------------------------

  test('亮度松手写入历史：落盘 Storage 且页面 data 同步', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    setCurrentBleClient(fakeClient(true))

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.brightnessHist).toEqual([]) // 初始无历史
    page.onBrightnessChange({ detail: { value: 30 } })
    expect(page.data.brightnessHist).toHaveLength(1)
    expect(page.data.brightnessHist[0].v).toBe(30)
    // Storage 里也有一份（页面重建可读回）。
    const raw = wx.getStorageSync(`brightness_hist_${dev.id}`)
    expect(JSON.parse(raw)).toHaveLength(1)
  })

  test('切设备后亮度历史按设备隔离（不串台）', () => {
    const a = saveDevice({ name: 'A', deviceId: 'dev-a' })
    setCurrentBleClient(fakeClient(true))
    app.globalData.currentDeviceId = a.id
    const page = loadPage(HOME, app)
    page.onShow()
    page.onBrightnessChange({ detail: { value: 10 } })
    expect(page.data.brightnessHist).toHaveLength(1)

    // 切到设备 B：历史应为空（各设备独立键）。
    const b = saveDevice({ name: 'B', deviceId: 'dev-b' })
    app.globalData.currentDeviceId = b.id
    page._refresh()
    expect(page.data.brightnessHist).toEqual([])
  })

  test('无当前设备：亮度回调不写历史（不凭空造 Storage 键）', () => {
    setCurrentBleClient(fakeClient(true))
    app.globalData.currentDeviceId = null
    const page = loadPage(HOME, app)
    page.onShow()
    page.onBrightnessChange({ detail: { value: 88 } })
    expect(page.data.brightnessHist).toEqual([])
  })
})