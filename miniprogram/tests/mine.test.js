// Jest 单测：miniprogram/pages/mine/mine.js（#25，ADR-0027）。
//
// 覆盖：
//   - 版本号来自 codegen 产物（protocol_gen）
//   - 清除本地数据：只删 bt_* / device_config_* 键，不碰其他
//   - 关于/帮助：showModal 弹出且内容含版本

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { saveDevice, resetDeviceStore } = require('../utils/deviceStore')
const { APP_VERSION, PROTOCOL_VERSION } = require('../utils/protocol_gen')

const MINE = '../pages/mine/mine'

describe('mine 页（#25）', () => {
  let wx
  let app

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    app = makeApp(null)
  })

  test('版本信息来自 codegen 产物（ADR-0011 无手写漂移）', () => {
    const page = loadPage(MINE, app)
    expect(page.data.version).toBe(APP_VERSION.string)
    expect(page.data.protocolVersion).toBe(PROTOCOL_VERSION.string)
  })

  test('清除本地数据：删除 bt_devices / bt_current_device / device_config_* / error_log，保留其他键', () => {
    saveDevice({ name: 'A', deviceId: 'dev-1' })
    wx.setStorageSync('bt_current_device', 'x')
    wx.setStorageSync('device_config_d1', '{}')
    wx.setStorageSync('error_log', '[]')
    wx.setStorageSync('user_pref_theme', 'dark') // 无关键：保留

    const page = loadPage(MINE, app)
    page.onClearStorage()

    expect(wx.getStorageSync('bt_devices')).toBe('')
    expect(wx.getStorageSync('bt_current_device')).toBe('')
    expect(wx.getStorageSync('device_config_d1')).toBe('')
    expect(wx.getStorageSync('error_log')).toBe('')
    expect(wx.getStorageSync('user_pref_theme')).toBe('dark')
    expect(wx.showToast).toHaveBeenCalledWith({ title: '已清除', icon: 'success' })
  })

  test('清除本地数据取消时不做任何事', () => {
    saveDevice({ name: 'A', deviceId: 'dev-1' })
    wx.showModal.mockImplementation((opts) => {
      // 模拟用户取消
      opts.success({ confirm: false, cancel: true })
    })

    const page = loadPage(MINE, app)
    page.onClearStorage()

    expect(wx.getStorageSync('bt_devices')).not.toBe('')
  })

  test('关于：showModal 弹出，内容含应用版本与协议版本', () => {
    const page = loadPage(MINE, app)
    page.onTapAbout()
    expect(wx.showModal).toHaveBeenCalled()
    const arg = wx.showModal.mock.calls[0][0]
    expect(arg.title).toBe('关于')
    expect(arg.content).toContain(APP_VERSION.string)
    expect(arg.content).toContain(PROTOCOL_VERSION.string)
    expect(arg.showCancel).toBe(false)
  })

  test('帮助：showModal 弹出，内容非空', () => {
    const page = loadPage(MINE, app)
    page.onTapHelp()
    expect(wx.showModal).toHaveBeenCalled()
    const arg = wx.showModal.mock.calls[0][0]
    expect(arg.title).toBe('帮助')
    expect(arg.content.length).toBeGreaterThan(10)
  })
})