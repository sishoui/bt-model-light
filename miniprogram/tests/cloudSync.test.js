// Jest 单测：miniprogram/utils/cloudSync.js（ADR-0035）。
//
// 核心断言：未登录完全不发请求；同步是 best-effort（失败不抛给页面）；
// 合并规则以 BLE deviceId 为键；本地是真相源（不覆盖本地已有的名字除非服务端有）。

'use strict'

const { createWxMock } = require('./wx-mock')
const api = require('../utils/apiClient')
const cloudSync = require('../utils/cloudSync')
const {
  listDevices,
  saveDevice,
  resetDeviceStore,
} = require('../utils/deviceStore')

// 简易路由 mock：按 url 后缀分发。
function routeRequest(routes) {
  global.wx.request.mockImplementation((opts) => {
    const url = String(opts.url || '')
    for (const [path, handler] of Object.entries(routes)) {
      if (url.endsWith(path)) {
        const r = handler(opts)
        if (r !== undefined) opts.success(r)
        return
      }
    }
    opts.success({ statusCode: 200, data: {} })
  })
}

describe('cloudSync', () => {
  let wx

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    api.clearAuth()
    cloudSync.resetStatus()
  })

  test('未登录：canSync false，状态 local，syncAll 不发请求', async () => {
    expect(cloudSync.canSync()).toBe(false)
    await expect(cloudSync.syncAll()).resolves.toEqual({ added: 0, pushed: 0, total: 0 })
    expect(wx.request).not.toHaveBeenCalled()
    expect(cloudSync.getStatus().status).toBe('local')
  })

  test('pushDevice：未登录静默跳过（不发请求）', async () => {
    await expect(cloudSync.pushDevice({ deviceId: 'D1', name: 'x' })).resolves.toBe(null)
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('pushDevice：登录后 POST /devices 带 deviceId/name/firmwareVersion', async () => {
    api.setToken('tok')
    let seen = null
    routeRequest({
      '/devices': (opts) => {
        seen = opts
        return { statusCode: 200, data: { device: { id: 3, deviceId: 'D1' } } }
      },
    })
    const r = await cloudSync.pushDevice({ deviceId: 'D1', name: '客厅', firmwareVersion: '0.5' })
    expect(r).toEqual({ id: 3, deviceId: 'D1' })
    expect(seen.method).toBe('POST')
    expect(seen.data).toEqual({ deviceId: 'D1', name: '客厅', firmwareVersion: '0.5' })
  })

  test('pushDevice：后端失败不抛（best-effort），记本地日志', async () => {
    api.setToken('tok')
    wx.request.mockImplementation((opts) =>
      opts.success({ statusCode: 500, data: { error: { code: 'INTERNAL', message: '服务端错误，请稍后重试' } } })
    )
    await expect(cloudSync.pushDevice({ deviceId: 'D1' })).resolves.toBe(null)
    const log = wx.getStorageSync('error_log')
    expect(String(log)).toContain('云端同步设备')
  })

  test('pushDelete：服务端没有该设备时不发 DELETE', async () => {
    api.setToken('tok')
    let deletes = 0
    routeRequest({
      '/devices': () => ({ statusCode: 200, data: { devices: [{ id: 1, deviceId: 'OTHER' }] } }),
      '/devices/1': (opts) => {
        if (opts.method === 'DELETE') deletes += 1
        return { statusCode: 200, data: { ok: true } }
      },
    })
    await expect(cloudSync.pushDelete({ deviceId: 'D1' })).resolves.toBe(false)
    expect(deletes).toBe(0)
  })

  test('pushDelete：按 deviceId 找到服务端 id 后 DELETE', async () => {
    api.setToken('tok')
    const calls = []
    wx.request.mockImplementation((opts) => {
      calls.push(`${opts.method} ${opts.url}`)
      if (opts.method === 'GET') {
        opts.success({ statusCode: 200, data: { devices: [{ id: 42, deviceId: 'D1' }] } })
      } else {
        opts.success({ statusCode: 200, data: { ok: true } })
      }
    })
    await expect(cloudSync.pushDelete({ deviceId: 'D1' })).resolves.toBe(true)
    expect(calls).toEqual([
      `GET ${api.DEFAULT_BASE_URL}/devices`,
      `DELETE ${api.DEFAULT_BASE_URL}/devices/42`,
    ])
  })

  test('syncAll：服务端独有设备补进本地（按 deviceId 去重）', async () => {
    api.setToken('tok')
    const local = saveDevice({ name: '本机已有', deviceId: 'LOCAL-1' })
    routeRequest({
      '/devices': () => ({
        statusCode: 200,
        data: {
          devices: [
            { id: 1, deviceId: 'LOCAL-1', name: '本机已有' },
            { id: 2, deviceId: 'CLOUD-1', name: '云上设备' },
          ],
        },
      }),
    })

    const r = await cloudSync.syncAll()
    expect(r.added).toBe(1)
    expect(r.pushed).toBe(0)

    const devices = listDevices()
    expect(devices.map((d) => d.deviceId).sort()).toEqual(['CLOUD-1', 'LOCAL-1'])
    expect(devices.find((d) => d.deviceId === 'LOCAL-1').id).toBe(local.id)
    expect(cloudSync.getStatus().status).toBe('synced')
  })

  test('syncAll：本地独有设备推到服务端', async () => {
    api.setToken('tok')
    saveDevice({ name: '只有本机', deviceId: 'ONLY-LOCAL' })
    const posts = []
    wx.request.mockImplementation((opts) => {
      if (opts.method === 'GET') opts.success({ statusCode: 200, data: { devices: [] } })
      else {
        posts.push(opts.data)
        opts.success({ statusCode: 200, data: { device: { id: 9 } } })
      }
    })

    const r = await cloudSync.syncAll()
    expect(r.pushed).toBe(1)
    expect(posts).toEqual([{ deviceId: 'ONLY-LOCAL', name: '只有本机', firmwareVersion: '' }])
  })

  test('syncAll：服务端改名同步回本地（同名不写盘）', async () => {
    api.setToken('tok')
    const d = saveDevice({ name: '旧名', deviceId: 'X1' })
    routeRequest({
      '/devices': () => ({ statusCode: 200, data: { devices: [{ id: 1, deviceId: 'X1', name: '新名' }] } }),
    })
    await cloudSync.syncAll()
    expect(listDevices().find((x) => x.id === d.id).name).toBe('新名')
  })

  test('syncAll：服务端失败 → 状态 failed 且抛给调用方（页面可提示）', async () => {
    api.setToken('tok')
    wx.request.mockImplementation((opts) =>
      opts.success({ statusCode: 502, data: { error: { code: 'BAD_GATEWAY', message: '服务不可用' } } })
    )
    await expect(cloudSync.syncAll()).rejects.toMatchObject({ message: '服务不可用' })
    const st = cloudSync.getStatus()
    expect(st.status).toBe('failed')
    expect(st.message).toBe('服务不可用')
  })

  test('401（token 失效）→ 下次 canSync false（本地凭据已清）', async () => {
    api.setToken('tok')
    wx.request.mockImplementation((opts) =>
      opts.success({ statusCode: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } })
    )
    await expect(cloudSync.syncAll()).rejects.toMatchObject({ status: 401 })
    expect(cloudSync.canSync()).toBe(false)
  })
})
