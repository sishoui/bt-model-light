// Jest 单测：miniprogram/utils/userStore.js（ADR-0035）。
//
// 覆盖：wx.login → 后端换 token、失败不写凭据、退出先吊销后清本地、
// 资料刷新、事件订阅。

'use strict'

const { createWxMock } = require('./wx-mock')
const api = require('../utils/apiClient')
const userStore = require('../utils/userStore')

function mockLogin(handler) {
  global.wx.request.mockImplementation((opts) => {
    if (handler) return handler(opts)
    opts.success({ statusCode: 200, data: { token: 'tok-1', user: { id: 1, nickname: '甲' } } })
  })
}

describe('userStore', () => {
  let wx

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    const root = globalThis
    delete root[userStore.EVENT_KEY]
  })

  test('未登录：isLoggedIn false / currentUser null', () => {
    expect(userStore.isLoggedIn()).toBe(false)
    expect(userStore.currentUser()).toBe(null)
  })

  test('登录成功：存 token + 用户快照，并通知订阅者', async () => {
    mockLogin()
    const events = []
    const off = userStore.subscribe((u) => events.push(u))

    const user = await userStore.login()

    expect(user).toEqual({ id: 1, nickname: '甲' })
    expect(userStore.isLoggedIn()).toBe(true)
    expect(userStore.currentUser()).toEqual({ id: 1, nickname: '甲' })
    expect(wx.login).toHaveBeenCalled()
    expect(events).toEqual([{ id: 1, nickname: '甲' }])

    off()
    expect(typeof off).toBe('function')
  })

  test('wx.login 没给 code → 失败，不写凭据', async () => {
    wx.login.mockImplementation((opts) => opts.success({ errMsg: 'login:ok' }))
    await expect(userStore.login()).rejects.toThrow('微信登录失败：未获取到 code')
    expect(userStore.isLoggedIn()).toBe(false)
  })

  test('wx.login fail → 可读文案，不写凭据', async () => {
    wx.login.mockImplementation((opts) => opts.fail({ errMsg: 'login:fail' }))
    await expect(userStore.login()).rejects.toThrow('微信登录失败，请稍后重试')
    expect(userStore.isLoggedIn()).toBe(false)
  })

  test('后端拒绝（code 无效）→ 抛后端文案，不写凭据', async () => {
    mockLogin((opts) =>
      opts.success({ statusCode: 400, data: { error: { code: 'INVALID_PARAMETER', message: '登录凭证无效，请重试' } } })
    )
    await expect(userStore.login()).rejects.toMatchObject({ message: '登录凭证无效，请重试', status: 400 })
    expect(userStore.isLoggedIn()).toBe(false)
  })

  test('后端响应缺 token → token 为空，isLoggedIn 仍 false', async () => {
    mockLogin((opts) => opts.success({ statusCode: 200, data: { user: { id: 2 } } }))
    await userStore.login()
    expect(userStore.isLoggedIn()).toBe(false)
  })

  test('退出：即使吊销请求失败也清本地（不把用户锁在已登录态）', async () => {
    api.setToken('tok')
    api.setUser({ id: 1 })
    wx.request.mockImplementation((opts) => opts.fail({ errMsg: 'offline' }))

    await expect(userStore.logout()).resolves.toBe(true)
    expect(userStore.isLoggedIn()).toBe(false)
    expect(userStore.currentUser()).toBe(null)
  })

  test('退出：先打 /auth/logout，再清本地', async () => {
    api.setToken('tok')
    const urls = []
    wx.request.mockImplementation((opts) => {
      urls.push(opts.url)
      opts.success({ statusCode: 200, data: { ok: true } })
    })
    await userStore.logout()
    expect(urls).toEqual([`${api.DEFAULT_BASE_URL}/auth/logout`])
    expect(api.getToken()).toBe('')
  })

  test('refreshProfile：未登录不发请求', async () => {
    await expect(userStore.refreshProfile()).resolves.toBe(null)
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('refreshProfile：刷新本地快照并通知订阅者', async () => {
    api.setToken('tok')
    mockLogin((opts) => opts.success({ statusCode: 200, data: { user: { id: 9, nickname: '新' } } }))
    const events = []
    userStore.subscribe((u) => events.push(u))

    await expect(userStore.refreshProfile()).resolves.toEqual({ id: 9, nickname: '新' })
    expect(userStore.currentUser()).toEqual({ id: 9, nickname: '新' })
    expect(events).toEqual([{ id: 9, nickname: '新' }])
  })

  test('refreshProfile：服务端返回空用户 → 清凭据', async () => {
    api.setToken('tok')
    wx.request.mockImplementation((opts) => opts.success({ statusCode: 200, data: {} }))
    await userStore.refreshProfile()
    expect(api.getToken()).toBe('')
  })

  test('updateProfile：未登录直接拒绝（不发请求）', async () => {
    await expect(userStore.updateProfile({ nickname: 'x' })).rejects.toThrow('请先登录')
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('updateProfile：PATCH /me 并回写快照', async () => {
    api.setToken('tok')
    let seen = null
    wx.request.mockImplementation((opts) => {
      seen = { method: opts.method, url: opts.url, data: opts.data }
      opts.success({ statusCode: 200, data: { user: { id: 1, nickname: '改后' } } })
    })
    await expect(userStore.updateProfile({ nickname: '改后' })).resolves.toEqual({ id: 1, nickname: '改后' })
    expect(seen.method).toBe('PATCH')
    expect(seen.url).toBe(`${api.DEFAULT_BASE_URL}/me`)
    expect(seen.data).toEqual({ nickname: '改后' })
    expect(api.getUser()).toEqual({ id: 1, nickname: '改后' })
  })

  test('订阅回调抛异常不影响其它订阅者与登录结果', async () => {
    mockLogin()
    userStore.subscribe(() => {
      throw new Error('页面崩了')
    })
    const seen = []
    userStore.subscribe((u) => seen.push(u))
    await expect(userStore.login()).resolves.toEqual({ id: 1, nickname: '甲' })
    expect(seen.length).toBe(1)
  })
})
