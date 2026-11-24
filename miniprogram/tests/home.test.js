// Jest 单测：miniprogram/pages/home/home.js（#25 首页 = 设备 Tab 默认页，ADR-0027）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { saveDevice, saveDeviceConfig, resetDeviceStore } = require('../utils/deviceStore')
const { createBleClient, setCurrentBleClient } = require('../utils/bleClient')
const { setupBle } = require('./bleTestUtils')
const { statusFrame, notify } = require('./bleTestUtils')
const { CMD, NOTIFY, BLE } = require('../utils/protocol_gen')

const HOME = '../pages/home/home'

describe('home 页（#25）', () => {
  let wx
  let app

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
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

  test('已保存设备 + 已配置引脚：只展示 configured 引脚', () => {
    const dev = saveDevice({ name: 'BTLight_A1B2', deviceId: 'dev-1' })
    saveDeviceConfig(dev.id, {
      pins: [
        { pin: 0, configured: true, groups: [{}, {}] },
        { pin: 3, configured: false, groups: [] }, // 未配置：不展示
        { pin: 5, configured: true, groups: [{}] },
      ],
    })
    app.globalData.currentDeviceId = dev.id

    const page = loadPage(HOME, app)
    page.onShow()
    expect(page.data.deviceName).toBe('BTLight_A1B2')
    expect(page.data.pins).toHaveLength(2)
    expect(page.data.pins.map((p) => p.pin)).toEqual([0, 5])
    expect(page.data.pins[0].info).toBe('2 个灯组')
    expect(page.data.pins[0].name).toBe('引脚 1') // 默认名：pin + 1
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
})