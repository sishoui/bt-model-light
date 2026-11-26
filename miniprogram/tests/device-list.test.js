// Jest 单测：miniprogram/pages/device-list/device-list.js（#25，ADR-0025 / 0027）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { saveDevice, resetDeviceStore, getDeviceConfig } = require('../utils/deviceStore')
const { createBleClient, getCurrentBleClient, setCurrentBleClient } = require('../utils/bleClient')
const { createSimBleClient, SIM_DEVICE_ID } = require('../utils/mockBleClient')
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

  test('模拟模式：连接模拟设备后自动落盘默认引脚配置', async () => {
    setCurrentBleClient(createSimBleClient())
    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    await flush()

    // 模拟设备：直接调用 onTapFound。
    const promise = page.onTapFound({
      currentTarget: {
        dataset: {
          deviceId: SIM_DEVICE_ID,
          name: 'BTLight_Simulator_01',
        },
      },
    })
    await new Promise((r) => setTimeout(r, 200))
    await flush()

    // 验证：设备已保存、默认配置已落盘。
    const rawDevices = wx.getStorageSync('bt_devices')
    const devices = typeof rawDevices === 'string' && rawDevices ? JSON.parse(rawDevices) : []
    expect(devices).toHaveLength(1)
    expect(devices[0].deviceId).toBe(SIM_DEVICE_ID)
    const cfg = getDeviceConfig(devices[0].id)
    expect(cfg).not.toBeNull()
    expect(cfg.pins).toHaveLength(1)
    expect(cfg.pins[0].pin).toBe(0)
    expect(cfg.pins[0].configured).toBe(true)
  })

  // ---- RSSI 信号曲线 -----------------------------------------------------------

  test('扫描上报累积 RSSI 采样：每次追加一根柱，按信号强度归一', () => {
    const page = loadPage(DEVICE_LIST, app)
    page.onShow()
    // 直接驱动采样器（扫描会话内部会调它）。
    const s1 = page._sampleRssi('dev-1', -100) // 最弱 → 0%
    expect(s1).toEqual([{ i: 0, h: 0 }])
    const s2 = page._sampleRssi('dev-1', -30) // 最强 → 100%
    expect(s2).toEqual([{ i: 0, h: 0 }, { i: 1, h: 100 }])
    expect(s2).toHaveLength(2)
  })

  test('不同设备的采样相互隔离', () => {
    const page = loadPage(DEVICE_LIST, app)
    page._sampleRssi('dev-1', -50)
    const b = page._sampleRssi('dev-2', -80)
    expect(b).toHaveLength(1) // dev-2 只有自己的 1 个点
    expect(page._sampleRssi('dev-1', -60)).toHaveLength(2) // dev-1 累到 2 个
  })

  test('重新扫描清空采样（新会话从零开始）', () => {
    const page = loadPage(DEVICE_LIST, app)
    page._sampleRssi('dev-1', -50)
    page._sampleRssi('dev-1', -55)
    expect(page._sampleRssi('dev-1', -60)).toHaveLength(3)
    // 触发 _startScan：需要 client；用 sim client 避免真 BLE。
    setCurrentBleClient(createSimBleClient())
    page._startScan()
    expect(page._rssiSamplers).toEqual({})
    page._stopScan()
  })

  test('非数字 RSSI 忽略（不产生 NaN 柱）', () => {
    const page = loadPage(DEVICE_LIST, app)
    expect(page._sampleRssi('dev-1', 'x')).toEqual([])
    expect(page._sampleRssi('dev-1', undefined)).toEqual([])
  })
})