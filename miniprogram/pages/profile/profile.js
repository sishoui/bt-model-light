// 用户配置页（底部导航第二 Tab「我的」，ADR-0027 / ADR-0035）。
//
// 相对原「我的」页的改动：顶部新增账号卡（微信登录 / 头像昵称编辑 / 退出），
// 以及数据卡（已保存设备数 + 云端同步状态 + 立即同步）。其余（模拟模式、
// 清除本地数据、本地日志柱状图、固件升级、关于、帮助）保留原样。
//
// 登录是**可选**的：不登录照常连 BLE、改配置，只是没有云端设备归属。
// 版本信息从 codegen 产物取（ADR-0011），避免手写漂移。

const GEN = require('../../utils/protocol_gen')
const { isSimModeEnabled, setSimModeEnabled } = require('../../utils/simMode')
const { setCurrentBleClient, createBleClient, getCurrentBleClient } = require('../../utils/bleClient')
const { createSimBleClient, SIM_DEVICE_ID } = require('../../utils/mockBleClient')
const { getErrorLog, clearErrorLog, friendlyMessage, logError } = require('../../utils/errorHandler')
const charts = require('../../utils/chartHelpers')
const ota = require('../../utils/otaClient')
const autoSync = require('../../utils/autoSync')
const userStore = require('../../utils/userStore')
const cloudSync = require('../../utils/cloudSync')
const telemetry = require('../../utils/telemetry')
const {
  listDevices,
  getDeviceFirmwareVersion,
  saveDeviceFirmwareVersion,
} = require('../../utils/deviceStore')

// 错误分布柱状图窗口：最近 7 天。
const ERROR_CHART_DAYS = 7

// 头像上限：后端 AVATAR_MAX_BYTES 默认 200KB，这里按 128KB 截断，
// 留出 base64 膨胀（约 1.37 倍）的余量，避免上传后 413。
const AVATAR_MAX_BYTES = 128 * 1024

const HELP_TEXT =
  '使用帮助：\n' +
  '1. 打开设备电源，在设备列表页点"新增设备"扫描周边 BTLight_ 设备\n' +
  '2. 点选设备完成连接，返回首页即可控制\n' +
  '3. 首页展示设备状态与 8 个引脚（硬件固定，不可增删）\n' +
  '4. 遇到问题长按设备删除后重新连接\n' + 
  '5. 无硬件环境可在「设置」中开启模拟模式\n' +
  '6. 微信登录后设备清单会同步到云端，换手机不丢'

// 同步状态文案（与引脚详情页的同步状态条同口径，但语义是云端而非 BLE）。
const CLOUD_STATUS_TEXT = {
  idle: '未同步',
  syncing: '同步中',
  synced: '已同步',
  failed: '同步失败',
  local: '未登录（仅本机）',
}

// 文件 → data URL。超过上限返回 null（页面提示换小图）。
function readAvatarAsDataUrl(filePath) {
  try {
    const fs = wx.getFileSystemManager()
    const buf = fs.readFileSync(filePath)
    const size = buf && buf.byteLength ? buf.byteLength : buf && buf.length ? buf.length : 0
    if (!size) return null
    if (size > AVATAR_MAX_BYTES) return null
    const base64 = fs.readFileSync(filePath, 'base64')
    if (!base64) return null
    // 微信 chooseAvatar 返回的是本地临时文件，扩展名可信度不高；
    // 后端只校验 MIME 前缀，这里按 jpeg 兜底（微信侧头像基本都是 jpg/png）。
    const ext = /\.(png|jpe?g|webp)$/i.exec(String(filePath || ''))
    const mime = ext ? (ext[1].toLowerCase() === 'png' ? 'png' : ext[1].toLowerCase() === 'webp' ? 'webp' : 'jpeg') : 'jpeg'
    return `data:image/${mime};base64,${base64}`
  } catch (err) {
    logError(err, '读取头像')
    return null
  }
}

Page({
  data: {
    version: GEN.APP_VERSION.string,
    protocolVersion: GEN.PROTOCOL_VERSION.string,

    // ---- 账号 ----
    loggedIn: false,
    user: null, // { id, nickname, avatar, ... }
    nicknameDraft: '',
    loginBusy: false,
    avatarBusy: false,

    // ---- 数据 / 云端同步 ----
    deviceCount: 0,
    cloudStatus: 'idle',
    cloudStatusText: CLOUD_STATUS_TEXT.idle,
    cloudAt: '',
    syncBusy: false,

    // ---- 设置（原有） ----
    simModeEnabled: false,
    errorLogCount: 0,
    errorBuckets: [],
    errorChartMax: 0,
    logPanelOpen: false,
    logRecent: [],
    fwVersion: '',
    otaOpen: false,
    otaStage: '',
    otaPct: 0,
    otaText: '',
  },

  onLoad() {
    // 登录态变化（其它页面登录/退出/401 清 token）时刷新本页。
    this._unsubscribe = userStore.subscribe(() => this._refreshIdentity())
  },

  onUnload() {
    if (this._unsubscribe) this._unsubscribe()
  },

  onShow() {
    this.setData({
      simModeEnabled: isSimModeEnabled(),
      errorLogCount: getErrorLog().length,
    })
    this._syncTabBar()
    this._refreshIdentity()
    this._refreshCloudStatus()
    this._refreshErrorChart()
    this._refreshFwVersion()
  },

  // 自定义 tabBar（悬浮 Dock）的选中态由页面同步；测试环境无 getTabBar。
  _syncTabBar() {
    if (typeof this.getTabBar !== 'function') return
    const tabBar = this.getTabBar()
    if (tabBar && typeof tabBar.setData === 'function') tabBar.setData({ selected: 1 })
  },

  // ---- 账号 ------------------------------------------------------------------

  _refreshIdentity() {
    const user = userStore.currentUser()
    this.setData({
      loggedIn: userStore.isLoggedIn(),
      user: user || null,
      nicknameDraft: (user && user.nickname) || '',
      deviceCount: listDevices().length,
    })
    // 登录态变化会改变「云端同步」的可用性，状态文案跟着刷新。
    this._refreshCloudStatus()
  },

  // 微信登录（wx.login → 后端换 token）。成功后顺手同步一次设备清单。
  onLogin() {
    if (this.data.loginBusy) return
    this.setData({ loginBusy: true })
    wx.showLoading({ title: '登录中' })
    userStore
      .login()
      .then((user) => {
        wx.hideLoading()
        this._refreshIdentity()
        wx.showToast({ title: (user && user.nickname) || '登录成功', icon: 'success' })
        return cloudSync.syncAll().catch(() => null)
      })
      .then(() => {
        this._refreshIdentity()
        this._refreshCloudStatus()
      })
      .catch((err) => {
        wx.hideLoading()
        wx.showToast({ title: friendlyMessage(err), icon: 'none' })
      })
      .then(() => this.setData({ loginBusy: false }))
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后设备清单仍保存在本机，只是不再同步云端。',
      success: (res) => {
        if (!res.confirm) return
        userStore
          .logout()
          .then(() => {
            this._refreshIdentity()
            this._refreshCloudStatus()
            wx.showToast({ title: '已退出', icon: 'success' })
          })
          .catch((err) => wx.showToast({ title: friendlyMessage(err), icon: 'none' }))
      },
    })
  },

  // 头像：button open-type="chooseAvatar" 的 bindchooseavatar 事件。
  onChooseAvatar(e) {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    const filePath = e && e.detail && e.detail.avatarUrl
    if (!filePath) return
    const dataUrl = readAvatarAsDataUrl(filePath)
    if (!dataUrl) {
      wx.showToast({ title: '头像过大或格式不支持，请换一张', icon: 'none' })
      return
    }
    this.setData({ avatarBusy: true })
    userStore
      .updateProfile({ avatar: dataUrl })
      .then(() => {
        this._refreshIdentity()
        wx.showToast({ title: '头像已更新', icon: 'success' })
      })
      .catch((err) => wx.showToast({ title: friendlyMessage(err), icon: 'none' }))
      .then(() => this.setData({ avatarBusy: false }))
  },

  // 昵称输入：type="nickname" 的 input（微信侧会带昵称候选）。
  onNicknameInput(e) {
    this.setData({ nicknameDraft: (e && e.detail && e.detail.value) || '' })
  },

  onSaveNickname() {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    const nickname = String(this.data.nicknameDraft || '').trim()
    if (!nickname) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    if (nickname === ((this.data.user && this.data.user.nickname) || '')) return
    userStore
      .updateProfile({ nickname })
      .then(() => {
        this._refreshIdentity()
        wx.showToast({ title: '昵称已更新', icon: 'success' })
      })
      .catch((err) => wx.showToast({ title: friendlyMessage(err), icon: 'none' }))
  },

  // ---- 云端同步 --------------------------------------------------------------

  _refreshCloudStatus() {
    // 未登录时状态恒为「仅本机」，不必等一次失败的请求才更新。
    const st = cloudSync.canSync() ? cloudSync.getStatus() : { status: 'local', at: '' }
    this.setData({
      cloudStatus: st.status,
      cloudStatusText: CLOUD_STATUS_TEXT[st.status] || CLOUD_STATUS_TEXT.idle,
      cloudAt: st.at || '',
    })
  },

  onSyncNow() {
    if (this.data.syncBusy) return
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录后同步', icon: 'none' })
      return
    }
    this.setData({ syncBusy: true })
    this._refreshCloudStatus()
    cloudSync
      .syncAll()
      .then((r) => {
        this._refreshIdentity()
        this._refreshCloudStatus()
        const parts = []
        if (r.added) parts.push(`补回 ${r.added} 台`)
        if (r.pushed) parts.push(`上传 ${r.pushed} 台`)
        wx.showToast({ title: parts.length ? `已同步（${parts.join('，')}）` : '已同步', icon: 'success' })
      })
      .catch((err) => {
        this._refreshCloudStatus()
        wx.showToast({ title: friendlyMessage(err), icon: 'none' })
      })
      .then(() => this.setData({ syncBusy: false }))
  },

  // ---- 设置（原有逻辑，未改语义） ----------------------------------------------

  onToggleSimMode(e) {
    const next = !!e.detail.value
    setSimModeEnabled(next)
    this.setData({ simModeEnabled: next })
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.simMode = next
      // 切换模拟模式时，若当前连接的是模拟设备则重置当前设备 id，
      // 避免下次启动时 home 页试图重连一个已不存在的模拟设备。
      if (!next && app.globalData.currentDeviceId) {
        const { setCurrentDeviceId } = require('../../utils/deviceStore')
        const dev = listDevices().find((d) => d.id === app.globalData.currentDeviceId)
        if (dev && dev.deviceId === SIM_DEVICE_ID) {
          setCurrentDeviceId(null)
          app.globalData.currentDeviceId = null
        }
      }
    }
    // 立即替换全局 client 单例，使切换在当前会话生效（无需重启小程序）。
    setCurrentBleClient(next ? createSimBleClient() : createBleClient())
    wx.showToast({ title: next ? '已开启模拟模式（模拟）' : '已关闭模拟模式', icon: 'none' })
  },

  onClearStorage() {
    wx.showModal({
      title: '清除本地数据',
      content: '将删除已保存设备与配置（不影响设备本身与云端记录）',
      success: (res) => {
        if (!res.confirm) return
        try {
          const keys = wx.getStorageInfoSync().keys
          for (const k of keys) {
            if (
              k === 'bt_devices' ||
              k === 'bt_current_device' ||
              k === 'error_log' ||
              k.indexOf('device_config_') === 0
            ) {
              wx.removeStorageSync(k)
            }
          }
          clearErrorLog()
          const app = getApp()
          if (app && app.globalData) app.globalData.currentDeviceId = null
          this.setData({ errorLogCount: 0, deviceCount: 0 })
          this._refreshErrorChart() // 日志清空 → 柱状图归零
          wx.showToast({ title: '已清除', icon: 'success' })
        } catch (err) {
          wx.showToast({ title: `清除失败：${err}`, icon: 'none' })
        }
      },
    })
  },

  // ---- 本地日志 --------------------------------------------------------------

  onViewErrorLog() {
    const log = getErrorLog()
    if (!log.length) {
      wx.showModal({ title: '本地日志', content: '暂无错误日志', showCancel: false })
      return
    }
    const recent = log.slice(-10).reverse().map((e) => ({
      ts: new Date(e.ts).toLocaleString(),
      context: e.context || '',
      code: e.code,
      message: e.message,
    }))
    this._refreshErrorChart()
    this.setData({ logPanelOpen: true, logRecent: recent })
  },

  onCloseLogPanel() {
    this.setData({ logPanelOpen: false })
  },

  noop() {},

  _refreshErrorChart() {
    const buckets = charts.aggregateErrorLog(getErrorLog(), ERROR_CHART_DAYS)
    const max = buckets.reduce((m, b) => Math.max(m, b.count), 0)
    for (const b of buckets) b.pct = max > 0 ? Math.round((b.count / max) * 100) : 0
    this.setData({ errorBuckets: buckets, errorChartMax: max })
  },

  // ---- 设备固件升级（ADR-0034，逻辑未改） --------------------------------------

  _refreshFwVersion() {
    const app = getApp()
    const currentId = (app && app.globalData && app.globalData.currentDeviceId) || null
    if (!currentId) {
      this.setData({ fwVersion: '' })
      return
    }
    const client = getCurrentBleClient()
    const live = client && client.connected && client.versionInfo
    const ver = (live && live.firmware) || getDeviceFirmwareVersion(currentId)
    if (live) saveDeviceFirmwareVersion(currentId, live.firmware)
    this.setData({ fwVersion: ver || '' })
  },

  onCheckFirmware() {
    const currentId = this._currentDeviceId()
    if (!currentId) {
      wx.showToast({ title: '未连接设备', icon: 'none' })
      return
    }
    const client = getCurrentBleClient()
    if (!client || !client.connected) {
      wx.showToast({ title: '请先连接设备', icon: 'none' })
      return
    }
    const local = (client.versionInfo && client.versionInfo.firmware) || this.data.fwVersion
    if (!local) {
      wx.showToast({ title: '尚未获取设备固件版本，请重连', icon: 'none' })
      return
    }

    wx.showLoading({ title: '检查更新' })
    telemetry.track('ota.check')
    ota
      .fetchManifest(ota.getBaseUrl())
      .then((m) => {
        wx.hideLoading()
        if (!ota.isNewerVersion(m.version, local)) {
          wx.showModal({
            title: '已是最新',
            content: `设备固件 ${local}，服务器 ${m.version}。`,
            showCancel: false,
          })
          return
        }
        wx.showModal({
          title: '发现新固件',
          content:
            `设备 ${local} → ${m.version}（${(m.size / 1024).toFixed(0)} KB）\n` +
            `协议 ${m.protocolVersion || '?'}${m.released ? ' · ' + m.released : ''}\n` +
            '升级过程中请保持设备靠近手机、不要切后台。',
          confirmText: '升级',
          success: (res) => {
            if (res.confirm) this._runUpgrade(m)
          },
        })
      })
      .catch((err) => {
        wx.hideLoading()
        telemetry.track('ota.check.fail', { dim: err && err.status ? String(err.status) : '' })
        wx.showToast({ title: `检查更新失败：${err.message || err}`, icon: 'none' })
      })
  },

  _currentDeviceId() {
    const app = getApp()
    return (app && app.globalData && app.globalData.currentDeviceId) || null
  },

  _runUpgrade(manifest) {
    const currentId = this._currentDeviceId()
    if (!currentId) return
    autoSync.setPaused(true)
    const startedAt = Date.now()
    // ota.bytes 用最终成功时的镜像大小；失败也记 start，便于算成功率。
    telemetry.track('ota.start', { dim: (manifest && manifest.version) || '', value: (manifest && manifest.size) || 0 })
    this.setData({ otaOpen: true, otaStage: 'checking', otaPct: 0, otaText: '正在检查…' })
    ota
      .flash({
        baseUrl: ota.getBaseUrl(),
        onProgress: (stage, written, total) => {
          const pct = total > 0 ? Math.round((written / total) * 100) : 0
          const text =
            stage === 'checking'
              ? '正在检查版本…'
              : stage === 'begin'
                ? '正在开始升级…'
                : stage === 'writing'
                  ? `正在写入固件 ${pct}%`
                  : stage === 'verifying'
                    ? '正在校验并切换分区…'
                    : stage === 'done'
                      ? '升级完成，设备正在重启…'
                      : stage
          this.setData({ otaStage: stage, otaPct: pct, otaText: text })
        },
      })
      .then((r) => {
        this.setData({ otaStage: 'done', otaPct: 100, otaText: '升级完成，设备正在重启…' })
        saveDeviceFirmwareVersion(currentId, r.version)
        telemetry.track('ota.done', { dim: r.version || '' })
        telemetry.track('ota.duration', { value: Date.now() - startedAt })
        if (manifest && manifest.size) telemetry.track('ota.bytes', { value: manifest.size })
        setTimeout(() => {
          this.setData({ otaOpen: false, otaStage: '', otaPct: 0, otaText: '', fwVersion: r.version })
          autoSync.setPaused(false)
          wx.showToast({ title: '升级完成，正在重连…', icon: 'success' })
        }, 1500)
      })
      .catch((err) => {
        autoSync.setPaused(false)
        // dim = 失败阶段/错误码：后台能看出是下载失败还是写入中断。
        telemetry.track('ota.fail', { dim: (err && err.status) || (err && err.code) || '' })
        telemetry.trackError((err && err.code) || 'ota', '固件升级')
        this.setData({ otaStage: 'error', otaText: `升级失败：${err.message || err}` })
      })
  },

  onCloseOta() {
    autoSync.setPaused(false)
    this.setData({ otaOpen: false, otaStage: '', otaPct: 0, otaText: '' })
  },

  // ---- 关于 / 帮助 ------------------------------------------------------------

  onTapAbout() {
    wx.showModal({
      title: '关于',
      content:
        `bt-model-light v${this.data.version}\n` +
        `协议版本 ${this.data.protocolVersion}\n` +
        (this.data.fwVersion ? `设备固件 ${this.data.fwVersion}\n` : '') +
        'ESP32-C3 八路 WS2812B 灯带灯控（微信小程序端）',
      showCancel: false,
    })
  },

  onTapHelp() {
    wx.showModal({ title: '帮助', content: HELP_TEXT, showCancel: false })
  },
})
