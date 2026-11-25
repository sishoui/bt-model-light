// Jest 单测：miniprogram/pages/home/home.js（#25 首页 = 设备 Tab 默认页，ADR-0027）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { saveDevice, saveDeviceConfig, getDeviceConfig, resetDeviceStore } = require('../utils/deviceStore')
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

  test('整体开关/亮度滑块更新本地 data', () => {
    const page = loadPage(HOME, app)
    page.onPowerChange({ detail: { value: true } })
    expect(page.data.power).toBe(true)
    page.onBrightnessChange({ detail: { value: 200 } })
    expect(page.data.brightness).toBe(200)
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
})