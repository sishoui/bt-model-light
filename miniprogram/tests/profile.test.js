// Jest 单测：miniprogram/pages/profile/profile.js（#25，ADR-0027 + ADR-0035）。
//
// 覆盖：
//   - 版本号来自 codegen 产物（protocol_gen）
//   - 清除本地数据：只删 bt_* / device_config_* 键，不碰其他
//   - 关于/帮助：showModal 弹出且内容含版本
//   - 账号卡：登录/退出/昵称/头像（ADR-0035）
//   - 云端同步：状态文案 + 立即同步

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { saveDevice, saveDeviceFirmwareVersion, resetDeviceStore } = require('../utils/deviceStore')
const { APP_VERSION, PROTOCOL_VERSION } = require('../utils/protocol_gen')
const { setCurrentBleClient } = require('../utils/bleClient')
const api = require('../utils/apiClient')
const userStore = require('../utils/userStore')
const cloudSync = require('../utils/cloudSync')
const ota = require('../utils/otaClient')

const PROFILE = '../pages/profile/profile'

describe('profile 页（#25 / ADR-0035）', () => {
  let wx
  let app

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    api.clearAuth()
    cloudSync.resetStatus()
    delete globalThis[userStore.EVENT_KEY]
    app = makeApp(null)
  })

  test('版本信息来自 codegen 产物（ADR-0011 无手写漂移）', () => {
    const page = loadPage(PROFILE, app)
    expect(page.data.version).toBe(APP_VERSION.string)
    expect(page.data.protocolVersion).toBe(PROTOCOL_VERSION.string)
  })

  test('清除本地数据：删除 bt_devices / bt_current_device / device_config_* / error_log，保留其他键', () => {
    saveDevice({ name: 'A', deviceId: 'dev-1' })
    wx.setStorageSync('bt_current_device', 'x')
    wx.setStorageSync('device_config_d1', '{}')
    wx.setStorageSync('error_log', '[]')
    wx.setStorageSync('user_pref_theme', 'dark') // 无关键：保留

    const page = loadPage(PROFILE, app)
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

    const page = loadPage(PROFILE, app)
    page.onClearStorage()

    expect(wx.getStorageSync('bt_devices')).not.toBe('')
  })

  test('关于：showModal 弹出，内容含应用版本与协议版本', () => {
    const page = loadPage(PROFILE, app)
    page.onTapAbout()
    expect(wx.showModal).toHaveBeenCalled()
    const arg = wx.showModal.mock.calls[0][0]
    expect(arg.title).toBe('关于')
    expect(arg.content).toContain(APP_VERSION.string)
    expect(arg.content).toContain(PROTOCOL_VERSION.string)
    expect(arg.showCancel).toBe(false)
  })

  test('帮助：showModal 弹出，内容非空', () => {
    const page = loadPage(PROFILE, app)
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
    const page = loadPage(PROFILE, app)
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
    const page = loadPage(PROFILE, app)
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
    const page = loadPage(PROFILE, app)
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
    const page = loadPage(PROFILE, app)
    page.onViewErrorLog()
    expect(page.data.logPanelOpen).toBe(false)
    expect(wx.showModal).toHaveBeenCalled()
    expect(wx.showModal.mock.calls[0][0].content).toBe('暂无错误日志')
  })

  // ---- 设备固件（ADR-0034） ----------------------------------------------------

  test('设备固件：无当前设备时不显示版本；有记录时读落库值', () => {
    const page = loadPage(PROFILE, app)
    page.onShow()
    expect(page.data.fwVersion).toBe('')

    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    saveDeviceFirmwareVersion(dev.id, '0.4')
    setCurrentBleClient(null)
    page.onShow()
    expect(page.data.fwVersion).toBe('0.4')
  })

  test('设备固件：已连接时用 client.versionInfo 的实时值并回写', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    setCurrentBleClient({ connected: true, versionInfo: { protocol: '1.2', firmware: '0.5' } })
    const page = loadPage(PROFILE, app)
    page.onShow()
    expect(page.data.fwVersion).toBe('0.5')
    resetDeviceStore()
    expect(require('../utils/deviceStore').getDeviceFirmwareVersion(dev.id)).toBe('0.5')
    setCurrentBleClient(null)
  })

  test('检查更新：未连接 → 提示；已是最新 → 不弹升级确认', async () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    const page = loadPage(PROFILE, app)
    setCurrentBleClient(null)
    page.onCheckFirmware()
    expect(wx.showToast.mock.calls.pop()[0].title).toBe('请先连接设备')

    // 已连接且服务器版本不新 → "已是最新"（没有"升级"按钮）。
    setCurrentBleClient({ connected: true, versionInfo: { protocol: '1.2', firmware: '0.4' } })
    wx.downloadFile.mockImplementation((opts = {}) => {
      wx.__files['wxfile://manifest.json'] = Buffer.from(
        JSON.stringify({ version: '0.4', file: 'fw.bin', size: 100, crc32: 'aabbccdd' }),
        'utf8'
      )
      const res = { statusCode: 200, tempFilePath: 'wxfile://manifest.json' }
      opts.success(res)
      return Promise.resolve(res)
    })
    page.onCheckFirmware()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const modal = wx.showModal.mock.calls.pop()[0]
    expect(modal.title).toBe('已是最新')
    expect(modal.confirmText).toBeUndefined() // 不弹"升级"
  })

  test('关于弹窗：含设备固件版本（已获取时）', () => {
    const dev = saveDevice({ name: 'A', deviceId: 'dev-1' })
    app.globalData.currentDeviceId = dev.id
    saveDeviceFirmwareVersion(dev.id, '0.4')
    setCurrentBleClient(null)
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onTapAbout()
    const arg = wx.showModal.mock.calls.pop()[0]
    expect(arg.content).toContain('设备固件 0.4')
    expect(arg.content).toContain(`v${APP_VERSION.string}`)
  })

  // ---- 账号卡（ADR-0035） ------------------------------------------------------

  test('未登录：账号卡显示未登录，数据卡显示本机设备数与未登录状态', () => {
    saveDevice({ name: 'A', deviceId: 'dev-1' })
    const page = loadPage(PROFILE, app)
    page.onShow()
    expect(page.data.loggedIn).toBe(false)
    expect(page.data.user).toBe(null)
    expect(page.data.deviceCount).toBe(1)
    expect(page.data.cloudStatus).toBe('local')
    expect(page.data.cloudStatusText).toBe('未登录（仅本机）')
  })

  test('已登录：显示昵称与头像，退出登录清空', async () => {
    api.setToken('tok')
    api.setUser({ id: 1, nickname: '阿灯', avatar: 'data:image/png;base64,AA' })
    const page = loadPage(PROFILE, app)
    page.onShow()
    expect(page.data.loggedIn).toBe(true)
    expect(page.data.user.nickname).toBe('阿灯')
    expect(page.data.nicknameDraft).toBe('阿灯')

    wx.request.mockImplementation((opts) => opts.success({ statusCode: 200, data: { ok: true } }))
    page.onLogout()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(page.data.loggedIn).toBe(false)
    expect(page.data.user).toBe(null)
  })

  test('登录：wx.login → 后端发 token → 页面刷新并触发一次云端同步', async () => {
    const urls = []
    wx.request.mockImplementation((opts) => {
      urls.push(`${opts.method} ${opts.url}`)
      if (String(opts.url).endsWith('/auth/wx-login')) {
        opts.success({ statusCode: 200, data: { token: 'tok', user: { id: 2, nickname: '新用户' } } })
      } else if (String(opts.url).endsWith('/devices')) {
        opts.success({ statusCode: 200, data: { devices: [] } })
      } else {
        opts.success({ statusCode: 200, data: {} })
      }
    })
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onLogin()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(page.data.loggedIn).toBe(true)
    expect(page.data.user.nickname).toBe('新用户')
    expect(urls[0]).toContain('POST')
    expect(urls[0]).toContain('/auth/wx-login')
    expect(urls.some((u) => u.endsWith('/devices'))).toBe(true)
  })

  test('登录失败：保持未登录并提示（不写 token）', async () => {
    wx.request.mockImplementation((opts) =>
      opts.success({ statusCode: 400, data: { error: { code: 'INVALID_PARAMETER', message: '登录凭证无效，请重试' } } })
    )
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onLogin()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(page.data.loggedIn).toBe(false)
    expect(api.getToken()).toBe('')
    const toast = wx.showToast.mock.calls.map((c) => c[0].title)
    expect(toast).toContain('登录凭证无效，请重试')
  })

  test('未登录时点头像/昵称保存：提示先登录且不发请求', () => {
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://a.png' } })
    page.onSaveNickname()
    const toast = wx.showToast.mock.calls.map((c) => c[0].title)
    expect(toast.filter((t) => t === '请先登录').length).toBe(2)
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('昵称保存：与现有值相同则不发请求', async () => {
    api.setToken('tok')
    api.setUser({ id: 1, nickname: '同名' })
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onNicknameInput({ detail: { value: '同名' } })
    page.onSaveNickname()
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('昵称保存：PATCH /me 并更新展示', async () => {
    api.setToken('tok')
    api.setUser({ id: 1, nickname: '旧' })
    wx.request.mockImplementation((opts) => {
      opts.success({ statusCode: 200, data: { user: { id: 1, nickname: '新' } } })
    })
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onNicknameInput({ detail: { value: '  新  ' } })
    page.onSaveNickname()
    await new Promise((r) => setImmediate(r))
    expect(page.data.user.nickname).toBe('新')
    expect(page.data.nicknameDraft).toBe('新')
  })

  test('昵称保存：空值被拒（不发请求）', () => {
    api.setToken('tok')
    api.setUser({ id: 1, nickname: '旧' })
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onNicknameInput({ detail: { value: '   ' } })
    page.onSaveNickname()
    expect(wx.showToast.mock.calls.pop()[0].title).toBe('昵称不能为空')
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('头像：超限/读不到 → 提示换图，不发请求', () => {
    api.setToken('tok')
    api.setUser({ id: 1 })
    const page = loadPage(PROFILE, app)
    page.onShow()
    // mock 里 wxfile 未登记 → readFileSync 返回空
    page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://missing.png' } })
    expect(wx.showToast.mock.calls.pop()[0].title).toBe('头像过大或格式不支持，请换一张')
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('头像：读到大图超过 128KB → 拒绝', () => {
    api.setToken('tok')
    api.setUser({ id: 1 })
    wx.__files['wxfile://big.jpg'] = Buffer.alloc(129 * 1024, 1)
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://big.jpg' } })
    expect(wx.showToast.mock.calls.pop()[0].title).toBe('头像过大或格式不支持，请换一张')
    expect(wx.request).not.toHaveBeenCalled()
  })

  test('头像：合法图片 → PATCH /me 带 data URL', async () => {
    api.setToken('tok')
    api.setUser({ id: 1 })
    wx.__files['wxfile://avatar.png'] = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    let patch = null
    wx.request.mockImplementation((opts) => {
      if (opts.method === 'PATCH') {
        patch = opts.data
        opts.success({ statusCode: 200, data: { user: { id: 1, avatar: opts.data.avatar } } })
      } else {
        opts.success({ statusCode: 200, data: {} })
      }
    })
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://avatar.png' } })
    await new Promise((r) => setImmediate(r))
    expect(patch.avatar).toMatch(/^data:image\/png;base64,/)
    expect(page.data.user.avatar).toBe(patch.avatar)
  })

  test('云端同步：未登录点同步 → 提示先登录', () => {
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onSyncNow()
    expect(wx.showToast.mock.calls.pop()[0].title).toBe('请先登录后同步')
  })

  test('云端同步：成功后刷新设备数与状态文案', async () => {
    api.setToken('tok')
    api.setUser({ id: 1, nickname: '甲' })
    wx.request.mockImplementation((opts) => {
      opts.success({
        statusCode: 200,
        data: { devices: [{ id: 5, deviceId: 'CLOUD-1', name: '云上' }] },
      })
    })
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onSyncNow()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(page.data.deviceCount).toBe(1)
    expect(page.data.cloudStatus).toBe('synced')
    expect(page.data.cloudStatusText).toBe('已同步')
    expect(page.data.syncBusy).toBe(false)
  })

  test('云端同步：失败提示可读文案且状态 failed', async () => {
    api.setToken('tok')
    api.setUser({ id: 1 })
    wx.request.mockImplementation((opts) =>
      opts.success({ statusCode: 502, data: { error: { code: 'UPSTREAM', message: '服务不可用' } } })
    )
    const page = loadPage(PROFILE, app)
    page.onShow()
    page.onSyncNow()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(page.data.cloudStatus).toBe('failed')
    expect(wx.showToast.mock.calls.map((c) => c[0].title)).toContain('服务不可用')
  })
})
