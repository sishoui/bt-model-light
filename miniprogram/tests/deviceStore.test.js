// Jest 单测：miniprogram/utils/deviceStore.js（ADR-0023 / ADR-0025 / SPEC 持久化）。
//
// 覆盖：
//   - 设备列表：save（新增/去重）/ list / remove / current 设置
//   - 损坏 Storage 容错（非 JSON / 结构不符 → 空表）
//   - 每设备配置读写：getDeviceConfig / saveDeviceConfig
//   - 整机开关 / 整机亮度（ADR-0031/0032）：缺省值与归一化
//
// bleClient 单例 seam 的注入/读取测试见 bleClient.test.js。

'use strict'

const { installWxMock } = require('./wx-mock')
const {
  resetDeviceStore,
  listDevices,
  saveDevice,
  removeDevice,
  getCurrentDeviceId,
  setCurrentDeviceId,
  getDeviceConfig,
  saveDeviceConfig,
  getDevicePower,
  saveDevicePower,
  getDeviceBrightness,
  saveDeviceBrightness,
  clampBrightness,
  BRIGHTNESS_DEFAULT,
  POWER_DEFAULT,
} = require('../utils/deviceStore')
const { createBleClient, setCurrentBleClient } = require('../utils/bleClient')

const KEY_DEVICES = 'bt_devices'
const KEY_CURRENT = 'bt_current_device'

describe('deviceStore', () => {
  let wx

  beforeEach(() => {
    wx = installWxMock()
    resetDeviceStore()
    setCurrentBleClient(null)
  })

  test('空 Storage：listDevices 返回空表，getCurrentDeviceId 为 null', () => {
    expect(listDevices()).toEqual([])
    expect(getCurrentDeviceId()).toBeNull()
  })

  test('saveDevice 追加设备并赋 id', () => {
    const d1 = saveDevice({ name: 'BTLight_A1B2', deviceId: 'dev-1' })
    expect(d1.id).toBeTruthy()
    expect(d1.name).toBe('BTLight_A1B2')
    expect(d1.deviceId).toBe('dev-1')
    expect(listDevices()).toHaveLength(1)
    expect(listDevices()[0]).toEqual(d1)
  })

  test('saveDevice 已存在（同 id 或同 deviceId）时更新而非重复追加', () => {
    const d1 = saveDevice({ name: 'BTLight_A1B2', deviceId: 'dev-1' })
    const d2 = saveDevice({ name: 'BTLight_A1B2 改名', deviceId: 'dev-1' })
    expect(d2.id).toBe(d1.id)
    expect(listDevices()).toHaveLength(1)
    expect(listDevices()[0].name).toBe('BTLight_A1B2 改名')

    saveDevice({ name: 'BTLight_C3D4', deviceId: 'dev-2' })
    expect(listDevices()).toHaveLength(2)
  })

  test('saveDevice 持久化到 wx Storage（key=bt_devices）', () => {
    saveDevice({ name: 'BTLight_A1B2', deviceId: 'dev-1' })
    const setCall = wx.setStorageSync.mock.calls.find((c) => c[0] === KEY_DEVICES)
    expect(setCall).toBeTruthy()
    const persisted = JSON.parse(setCall[1])
    expect(persisted).toHaveLength(1)
    expect(persisted[0].name).toBe('BTLight_A1B2')
  })

  test('removeDevice 按 id 删除；删除当前设备时清空 current', () => {
    const d1 = saveDevice({ name: 'A', deviceId: 'dev-1' })
    saveDevice({ name: 'B', deviceId: 'dev-2' })
    setCurrentDeviceId(d1.id)
    expect(getCurrentDeviceId()).toBe(d1.id)

    removeDevice(d1.id)
    expect(listDevices()).toHaveLength(1)
    expect(getCurrentDeviceId()).toBeNull()

    removeDevice('missing-id') // 静默忽略
    expect(listDevices()).toHaveLength(1)
  })

  test('setCurrentDeviceId 持久化到 bt_current_device，可清空', () => {
    setCurrentDeviceId('dev-x')
    expect(wx.setStorageSync).toHaveBeenCalledWith(KEY_CURRENT, 'dev-x')
    setCurrentDeviceId(null)
    expect(wx.setStorageSync).toHaveBeenCalledWith(KEY_CURRENT, '')
    expect(getCurrentDeviceId()).toBeNull()
  })

  test('Storage 损坏（非 JSON）时 listDevices 返回空表且不抛异常', () => {
    wx.getStorageSync.mockImplementation((key) => (key === KEY_DEVICES ? 'not-json{' : null))
    expect(listDevices()).toEqual([])
  })

  test('Storage 结构不符（非数组）时 listDevices 返回空表', () => {
    wx.getStorageSync.mockImplementation((key) => (key === KEY_DEVICES ? '{"a":1}' : null))
    expect(listDevices()).toEqual([])
  })

  test('getDeviceConfig 读取每设备配置（device_config_<id>）', () => {
    wx.setStorageSync('device_config_dev-1', JSON.stringify({ pinCount: 2 }))
    expect(getDeviceConfig('dev-1')).toEqual({ pinCount: 2 })
    expect(getDeviceConfig('dev-none')).toBeNull()
  })

  test('saveDeviceConfig 写入并回读；含默认灯组时结构正确', () => {
    const cfg = { pins: [] }
    saveDeviceConfig('dev-1', cfg)
    const raw = wx.getStorageSync('device_config_dev-1')
    expect(JSON.parse(raw)).toEqual({ pins: [] })
    expect(getDeviceConfig('dev-1')).toEqual({ pins: [] })
  })

  // ---- 整机开关 / 整机亮度（ADR-0031 / ADR-0032） ---------------------------

  test('整机开关/亮度缺省值：开 + 255（与固件默认一致），未设置不落字段', () => {
    const d = saveDevice({ name: 'A', deviceId: 'dev-1' })
    expect(POWER_DEFAULT).toBe(true)
    expect(getDevicePower(d.id)).toBe(true)
    expect(getDeviceBrightness(d.id)).toBe(BRIGHTNESS_DEFAULT)
    expect(getDeviceBrightness(d.id)).toBe(255)
    expect(listDevices()[0].power).toBeUndefined()
    expect(listDevices()[0].brightness).toBeUndefined()
  })

  test('saveDevicePower/Brightness 落盘并回读；不影响其他设备', () => {
    const a = saveDevice({ name: 'A', deviceId: 'dev-1' })
    const b = saveDevice({ name: 'B', deviceId: 'dev-2' })
    expect(saveDevicePower(a.id, false)).toBe(false)
    expect(saveDeviceBrightness(a.id, 40)).toBe(40)
    expect(getDevicePower(a.id)).toBe(false)
    expect(getDeviceBrightness(a.id)).toBe(40)
    expect(getDevicePower(b.id)).toBe(true)
    expect(getDeviceBrightness(b.id)).toBe(255)
  })

  test('整机开关写入不碰各引脚的配置（引脚状态不变，ADR-0032）', () => {
    const d = saveDevice({ name: 'A', deviceId: 'dev-1' })
    const cfg = { version: 1, pins: [{ pin: 0, configured: true, groups: [] }] }
    saveDeviceConfig(d.id, cfg)
    saveDevicePower(d.id, false)
    expect(getDeviceConfig(d.id)).toEqual(cfg)
  })

  test('亮度归一化：越界/非数字回落默认，脏 Storage 读回不炸', () => {
    expect(clampBrightness(300)).toBe(BRIGHTNESS_DEFAULT)
    expect(clampBrightness('abc')).toBe(BRIGHTNESS_DEFAULT)
    expect(clampBrightness(12.6)).toBe(13)
    expect(clampBrightness(0)).toBe(0)
    const d = saveDevice({ name: 'A', deviceId: 'dev-1' })
    wx.setStorageSync(KEY_DEVICES, JSON.stringify([{ id: d.id, name: 'A', brightness: -5 }]))
    resetDeviceStore()
    expect(getDeviceBrightness(d.id)).toBe(BRIGHTNESS_DEFAULT)
  })

  // bleClient 单例 seam 的注入/读取测试见 bleClient.test.js
})