// Jest 单测：miniprogram/utils/telemetry.js（ADR-0037）。
//
// 重点：打点绝不阻塞、队列上限、失败回填、批量上限、trackError 的 dim 归一。

'use strict'

const { createWxMock } = require('./wx-mock')
const api = require('../utils/apiClient')
const telemetry = require('../utils/telemetry')

// 让 flush 的 await 生效（request 是 Promise）。
const tick = () => new Promise((r) => setImmediate(r))

describe('telemetry', () => {
  let wx

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    api.clearAuth()
    telemetry.resetTelemetry()
  })

  afterEach(() => {
    telemetry.resetTelemetry()
  })

  test('track 只入队，不立刻发请求（不阻塞业务）', () => {
    telemetry.track('ble.connect.ok')
    telemetry.track('config.bytes', { value: 1500 })
    expect(telemetry.pendingCount()).toBe(2)
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('value 缺省为 1；dim 超长截断到 64；at 为毫秒时间戳', () => {
    telemetry.track('error')
    telemetry.track('error', { dim: 'x'.repeat(100) })
    const q = globalThis.__btTelemetryQueue
    expect(q[0].value).toBe(1)
    expect(q[0].dim).toBe('')
    expect(q[1].dim.length).toBe(64)
    expect(typeof q[0].at).toBe('number')
    expect(q[0].at).toBeGreaterThan(1600000000000)
  })

  test('队列上限 100：超出丢最旧', () => {
    for (let i = 0; i < 130; i++) telemetry.track('app.launch', { value: i })
    expect(telemetry.pendingCount()).toBe(telemetry.QUEUE_MAX)
    const q = globalThis.__btTelemetryQueue
    expect(q[0].value).toBe(30) // 前 30 条被丢
    expect(q.at(-1).value).toBe(129)
  })

  test('flush：一次最多 20 条，POST /telemetry', async () => {
    let posted = null
    wx.request.mockImplementation((opts) => {
      posted = { url: opts.url, method: opts.method, data: opts.data }
      opts.success({ statusCode: 200, data: { accepted: 20, rejected: 0 } })
    })
    for (let i = 0; i < 25; i++) telemetry.track('app.launch')
    expect(telemetry.pendingCount()).toBe(25)

    const r = await telemetry.flush()
    expect(r).toEqual({ accepted: 20, rejected: 0 })
    expect(posted.method).toBe('POST')
    expect(posted.url).toBe(`${api.DEFAULT_BASE_URL}/telemetry`)
    expect(posted.data.events.length).toBe(telemetry.BATCH_MAX)
    expect(telemetry.pendingCount()).toBe(5)
  })

  test('flush：空队列不发请求', async () => {
    await expect(telemetry.flush()).resolves.toEqual({ accepted: 0, rejected: 0 })
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('flush 失败：批次回填队列（保留最新，不无限增长）', async () => {
    wx.request.mockImplementation((opts) => opts.fail({ errMsg: 'offline' }))
    for (let i = 0; i < 25; i++) telemetry.track('app.launch', { value: i })
    const r = await telemetry.flush()
    expect(r.failed).toBe(true)
    // 25 条全部回来（没有丢）
    expect(telemetry.pendingCount()).toBe(25)
    // 回填后按原顺序保留最新
    const q = globalThis.__btTelemetryQueue
    expect(q.at(-1).value).toBe(24)
  })

  test('flush 失败且队列已满：仍不超过上限', async () => {
    wx.request.mockImplementation((opts) => opts.fail({ errMsg: 'offline' }))
    for (let i = 0; i < telemetry.QUEUE_MAX; i++) telemetry.track('app.launch', { value: i })
    await telemetry.flush()
    expect(telemetry.pendingCount()).toBeLessThanOrEqual(telemetry.QUEUE_MAX)
  })

  test('trackError：code 优先做 dim，缺 code 时用 context', () => {
    telemetry.trackError(10001, '扫描设备')
    telemetry.trackError(null, '固件升级')
    telemetry.trackError(undefined, undefined)
    const q = globalThis.__btTelemetryQueue
    expect(q.map((e) => e.metric)).toEqual(['error', 'error', 'error'])
    expect(q[0].dim).toBe('10001')
    expect(q[1].dim).toBe('固件升级')
    expect(q[2].dim).toBe('unknown')
  })

  test('flushNow：清定时器后立即发（onHide 用）', async () => {
    let called = 0
    wx.request.mockImplementation((opts) => {
      called += 1
      opts.success({ statusCode: 200, data: { accepted: 1, rejected: 0 } })
    })
    telemetry.track('app.launch')
    await telemetry.flushNow()
    expect(called).toBe(1)
    expect(telemetry.pendingCount()).toBe(0)
  })

  test('自动 flush：3s 定时器触发（用假定时器验证不阻塞）', () => {
    jest.useFakeTimers()
    try {
      let called = 0
      wx.request.mockImplementation((opts) => {
        called += 1
        opts.success({ statusCode: 200, data: { accepted: 1, rejected: 0 } })
      })
      telemetry.track('app.launch')
      expect(called).toBe(0)
      jest.advanceTimersByTime(telemetry.FLUSH_MS)
      expect(called).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test('重复 track 不会叠加多个定时器', () => {
    jest.useFakeTimers()
    try {
      let called = 0
      wx.request.mockImplementation((opts) => {
        called += 1
        opts.success({ statusCode: 200, data: { accepted: 3, rejected: 0 } })
      })
      for (let i = 0; i < 3; i++) telemetry.track('app.launch')
      jest.advanceTimersByTime(telemetry.FLUSH_MS)
      expect(called).toBe(1) // 只发一次，3 条合批
    } finally {
      jest.useRealTimers()
    }
  })

  test('resetTelemetry 清空队列（测试隔离）', async () => {
    telemetry.track('app.launch')
    telemetry.resetTelemetry()
    expect(telemetry.pendingCount()).toBe(0)
    await tick()
  })
})
