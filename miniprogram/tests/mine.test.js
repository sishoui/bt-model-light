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

  // ---- 错误分布柱状图 ---------------------------------------------------------

  function seedLog(entries) {
    wx.setStorageSync('error_log', JSON.stringify(entries))
  }

  test('onShow 聚合最近 7 天错误：桶数 7、pct 按峰值归一', () => {
    const now = Date.now()
    const DAY = 86400000
    seedLog([
      { ts: now - 1000, message: 'a' },
      { ts: now - 2000, message: 'b' },
      { ts: now - DAY - 1000, message: 'c' },
    ])
    const page = loadPage(MINE, app)
    page.onShow()
    expect(page.data.errorBuckets).toHaveLength(7)
    expect(page.data.errorChartMax).toBe(2)
    // 今天峰值 → pct=100；昨天 1/2 → 50；其余 0
    expect(page.data.errorBuckets[6].pct).toBe(100)
    expect(page.data.errorBuckets[6].count).toBe(2)
    expect(page.data.errorBuckets[5].pct).toBe(50)
    expect(page.data.errorBuckets[0].pct).toBe(0)
  })

  test('无日志时柱状图全零（不崩、不画假柱）', () => {
    const page = loadPage(MINE, app)
    page.onShow()
    expect(page.data.errorChartMax).toBe(0)
    expect(page.data.errorBuckets.every((b) => b.count === 0 && b.pct === 0)).toBe(true)
  })

  test('打开日志弹层：柱状图 + 最近条目（倒序，最多 10 条）', () => {
    const now = Date.now()
    // 真实日志按时间顺序追加（旧在前）；这里 0 号最旧、11 号最新。
    const entries = []
    for (let i = 0; i < 12; i++) {
      entries.push({ ts: now - (11 - i) * 1000, context: '扫描设备', code: 10001, message: `错误 ${i}` })
    }
    seedLog(entries)
    const page = loadPage(MINE, app)
    page.onShow()
    page.onViewErrorLog()
    expect(page.data.logPanelOpen).toBe(true)
    expect(page.data.logRecent).toHaveLength(10) // 截断到 10 条
    expect(page.data.logRecent[0].message).toBe('错误 11') // 最新在上
    expect(page.data.logRecent[0].context).toBe('扫描设备')
    expect(page.data.logRecent[0].ts).toBeTruthy()
    page.onCloseLogPanel()
    expect(page.data.logPanelOpen).toBe(false)
  })

  test('无日志点「本地日志」：仍是 showModal 提示，不打开空弹层', () => {
    const page = loadPage(MINE, app)
    page.onViewErrorLog()
    expect(page.data.logPanelOpen).toBe(false)
    expect(wx.showModal).toHaveBeenCalled()
    expect(wx.showModal.mock.calls[0][0].content).toBe('暂无错误日志')
  })
})