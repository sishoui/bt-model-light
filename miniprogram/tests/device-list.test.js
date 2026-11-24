// Jest 单测：miniprogram/pages/device-list/device-list.js（#25，ADR-0025 / 0027）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const {
  saveDevice,
  resetDeviceStore,
} = require('../utils/deviceStore')
const { createBleClient, getCurrentBleClient, setCurrentBleClient } = require('../utils/bleClient')
const { setupBle, flush } = require('./bleTestUtils')

const DEVICE_LIST = '../pages/device-list/device-list'

describe('device-list 页（#25）', () => {
  let wx
  let app

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    app = makeApp(null)
    setCurrentBleClient(null)
  })

  test('onShow 加载已保存设备并标记当前设备', () => {
    const { saveDevice } = require('../utils/deviceStore')
    const d1 = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDevice({ name: 'B', deviceId: 'dev-2' })
    wx.setStorageSync('bt_current_device', d1.id)

    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    expect(page.data.devices).toHaveLength(2)
    expect(page.data.currentId).toBe(d1.id)
  })

  test('点选已保存设备：连接成功 → currentId 写入 Storage + globalData', async () => {
    setupBle(wx)
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })

    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    await page.onTapDevice({ currentTarget: { dataset: { id: dev.id } } })
    await flush()

    expect(wx.createBLEConnection).toHaveBeenCalledWith({ deviceId: 'dev-1' })
    expect(wx.getStorageSync('bt_current_device')).toBe(dev.id)
    expect(app.globalData.currentDeviceId).toBe(dev.id)
  })

  test('点选已保存设备：连接失败 → 友好文案 Toast + 本地日志，currentId 不变', async () => {
    wx.createBLEConnection.mockImplementation(() => Promise.reject(new Error('timeout')))
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })

    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    await page.onTapDevice({ currentTarget: { dataset: { id: dev.id } } })
    await flush()

    // Error('timeout') 经 errorHandler → 用其 message。
    expect(wx.showToast).toHaveBeenCalledWith({
      title: 'timeout',
      icon: 'none',
    })
    // 本地日志 error_log 记录一条（context = 连接设备）。
    const log = JSON.parse(wx.getStorageSync('error_log'))
    expect(log).toHaveLength(1)
    expect(log[0].context).toBe('连接设备')
    expect(wx.getStorageSync('bt_current_device')).toBe('')
  })

  test('长按已保存设备 → 确认删除（写穿 Storage）', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })

    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    page.onLongPressDevice({ currentTarget: { dataset: { id: dev.id } } })
    expect(wx.showModal).toHaveBeenCalled()
    expect(wx.getStorageSync('bt_devices')).toBe('[]')
  })

  test('新增：扫描 → 前缀过滤 → 点选连接 → 保存并切换', async () => {
    setupBle(wx)
    const page = loadPage(DEVICE_LIST, app)
    page.onShow()

    page.onTapAdd()
    await flush() // startBluetoothDevicesDiscovery
    wx.__trigger('onBluetoothDeviceFound', {
      devices: [
        { name: 'BTLight_X9Y8', deviceId: 'dev-new', RSSI: -50 },
        { name: '杂项设备', deviceId: 'dev-junk', RSSI: -40 },
      ],
    })
    expect(page.data.found).toHaveLength(1)
    expect(page.data.found[0].deviceId).toBe('dev-new')

    await page.onTapFound({
      currentTarget: { dataset: { deviceId: 'dev-new', name: 'BTLight_X9Y8' } },
    })
    await flush()

    const raw = wx.getStorageSync('bt_devices')
    const saved = JSON.parse(raw)
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('BTLight_X9Y8')
    expect(saved[0].deviceId).toBe('dev-new')
    expect(wx.getStorageSync('bt_current_device')).toBe(saved[0].id)
    // 连接成功后 stop() 不再关适配器（spec #25 评审 Bug 1），保连接。
    expect(wx.stopBluetoothDevicesDiscovery).toHaveBeenCalled()
    expect(wx.closeBluetoothAdapter).not.toHaveBeenCalled()
  })

  test('扫描失败 → onError → scanning=false + Toast', async () => {
    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    // openBluetoothAdapter 失败
    wx.openBluetoothAdapter.mockImplementation(() =>
      Promise.reject({ errMsg: 'openBluetoothAdapter:fail' })
    )
    page.onTapAdd()
    await flush()

    expect(page.data.scanning).toBe(false)
    expect(wx.showToast).toHaveBeenCalled()
  })

  test('扫描 stop() 在未连接时关闭适配器', async () => {
    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    page.onTapAdd()
    await flush()
    page.onTapAdd() // toggle off (stop)
    expect(wx.closeBluetoothAdapter).toHaveBeenCalled()
  })
})