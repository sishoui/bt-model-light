// Jest 单测：miniprogram/utils/apiClient.js（ADR-0035）。
//
// 覆盖基地址覆盖优先级、token 读写、成功/失败响应、401 清凭据、网络失败文案。

'use strict'

const { createWxMock } = require('./wx-mock')
const api = require('../utils/apiClient')

describe('apiClient', () => {
  let wx

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
  })

  test('基地址默认值 + Storage 覆盖优先（末尾斜杠被去掉）', () => {
    expect(api.getBaseUrl()).toBe(api.DEFAULT_BASE_URL)
    wx.setStorageSync(api.BASE_URL_KEY, 'https://example.com/api/')
    expect(api.getBaseUrl()).toBe('https://example.com/api')
    api.setBaseUrl('')
    expect(api.getBaseUrl()).toBe(api.DEFAULT_BASE_URL)
  })

  test('token / user 快照读写，损坏 JSON 容错为 null', () => {
    expect(api.getToken()).toBe('')
    api.setToken('t1')
    expect(api.getToken()).toBe('t1')
    expect(api.getUser()).toBe(null)

    api.setUser({ id: 7, nickname: '甲' })
    expect(api.getUser()).toEqual({ id: 7, nickname: '甲' })

    wx.setStorageSync(api.USER_KEY, '{not json')
    expect(api.getUser()).toBe(null)
    wx.setStorageSync(api.USER_KEY, JSON.stringify({ nickname: '无 id' }))
    expect(api.getUser()).toBe(null)

    api.clearAuth()
    expect(api.getToken()).toBe('')
    expect(api.getUser()).toBe(null)
  })

  test('请求成功：带 token 时加 Bearer 头，返回解析后的对象', async () => {
    api.setToken('abc')
    wx.request.mockImplementation((opts) => {
      expect(opts.url).toBe(`${api.DEFAULT_BASE_URL}/me`)
      expect(opts.method).toBe('GET')
      expect(opts.header.authorization).toBe('Bearer abc')
      expect(opts.header['content-type']).toBe('application/json')
      opts.success({ statusCode: 200, data: { user: { id: 1 } } })
    })
    await expect(api.request('/me')).resolves.toEqual({ user: { id: 1 } })
  })

  test('无 token 时不加 authorization 头', async () => {
    wx.request.mockImplementation((opts) => {
      expect(opts.header.authorization).toBeUndefined()
      opts.success({ statusCode: 200, data: {} })
    })
    await api.request('/health')
  })

  test('POST 透传 data', async () => {
    wx.request.mockImplementation((opts) => {
      expect(opts.method).toBe('POST')
      expect(opts.data).toEqual({ code: 'x' })
      opts.success({ statusCode: 200, data: { token: 't' } })
    })
    await expect(api.request('/auth/wx-login', { method: 'POST', data: { code: 'x' } })).resolves.toEqual({
      token: 't',
    })
  })

  test('业务错误：抛 Error(message) 并挂 status/code', async () => {
    wx.request.mockImplementation((opts) => {
      opts.success({
        statusCode: 400,
        data: { error: { code: 'INVALID_PARAMETER', message: '缺少登录凭证 code' } },
      })
    })
    await expect(api.request('/auth/wx-login', { method: 'POST', data: {} })).rejects.toMatchObject({
      message: '缺少登录凭证 code',
      status: 400,
      code: 'INVALID_PARAMETER',
    })
  })

  test('401 清掉本地凭据（页面据此显示未登录）', async () => {
    api.setToken('stale')
    api.setUser({ id: 3 })
    wx.request.mockImplementation((opts) => {
      opts.success({ statusCode: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } })
    })
    await expect(api.request('/me')).rejects.toMatchObject({ status: 401, message: '请先登录' })
    expect(api.getToken()).toBe('')
    expect(api.getUser()).toBe(null)
  })

  test('非 JSON 响应的错误仍有可读文案', async () => {
    wx.request.mockImplementation((opts) => {
      opts.success({ statusCode: 500, data: '<html>oops</html>' })
    })
    await expect(api.request('/me')).rejects.toMatchObject({
      message: '请求失败（HTTP 500）',
      status: 500,
    })
  })

  test('网络层 fail → 中文文案（不把 errMsg 丢给用户）；超时单独文案', async () => {
    wx.request.mockImplementation((opts) => opts.fail({ errMsg: 'request:fail foo' }))
    await expect(api.request('/me')).rejects.toMatchObject({
      message: '网络不可用，请检查手机网络后重试',
      status: 0,
    })

    wx.request.mockImplementation((opts) => opts.fail({ errMsg: 'request:fail timeout' }))
    await expect(api.request('/me')).rejects.toMatchObject({ message: '网络超时，请稍后重试' })

    wx.request.mockImplementation((opts) => opts.fail({ errMsg: 'url not in domain list' }))
    await expect(api.request('/me')).rejects.toMatchObject({
      message: '服务器域名未配置，请在微信后台添加 request 合法域名',
    })
  })
})
