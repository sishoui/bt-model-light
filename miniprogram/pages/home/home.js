// 首页 = 设备 Tab 默认页（ADR-0027 / #25）。
// 结构：左上设备名称（→ 设备列表页）+ 设备卡片（图片/状态/整体开关/整体亮度）
// + 引脚卡片列表（仅已配置引脚）。引脚卡片点击进入引脚配置详情页（T7 实现，
// 当前弹提示占位）。

const { getCurrentBleClient } = require('../../utils/bleClient')
const { listDevices, getDeviceConfig } = require('../../utils/deviceStore')
const { friendlyMessage, logError } = require('../../utils/errorHandler')
const GEN = require('../../utils/protocol_gen')

Page({
  data: {
    // 协议版本（版本不兼容提示用，ADR-0009 / ADR-0011）
    protocolVersion: GEN.PROTOCOL_VERSION.string,
    // 模拟模式标志（onShow 刷新，用于显示提示）。
    simMode: false,
    // 设备卡片
    deviceName: '', // 左上标题；空串显示"未连接设备"
    connected: false, // BLE 连接状态
    power: false, // 整体开关（本地态；固件联动随 T7 保存链路接入）
    brightness: 128, // 整体亮度 0-255（本地态，同上）
    img: '', // 设备图片（v1 占位，真机图片后续）
    // 引脚卡片列表（仅已配置引脚，SPEC 用户故事 8）
    pins: [],
  },

  onShow() {
    const app = getApp()
    this.setData({ simMode: !!(app && app.globalData && app.globalData.simMode) })
    this._refresh()
    this._subscribeBle()
  },

  onHide() {
    this._unsubscribeBle()
  },

  onUnload() {
    this._unsubscribeBle()
  },

  _subscribeBle() {
    this._unsubscribeBle()
    const client = getCurrentBleClient()
    if (!client) return
    // STATUS_NOTIFY 事件：错误 Toast（文案映射 + 本地日志 errorHandler，ADR-0026）；
    // 版本不兼容 → Modal 提示升级（ADR-0009）。
    this._offStatus = client.onStatus((evt) => {
      if (evt.type === 'error') {
        logError(evt.code, '设备回传错误')
        wx.showToast({ title: friendlyMessage(evt.code), icon: 'none' })
      } else if (evt.type === 'version' && !evt.compatible) {
        logError({ errMsg: `版本不兼容 固件${evt.protocol}/需要${this.data.protocolVersion}` }, '版本不兼容')
        wx.showModal({
          title: '版本不兼容',
          content: `固件协议 ${evt.protocol}，小程序需要 ${this.data.protocolVersion}。请升级小程序或固件。`,
          showCancel: false,
        })
      }
    })
    // 连接/断开 → 刷新状态。
    this._offState = client.onConnectionStateChange(() => this._refresh())
  },

  _unsubscribeBle() {
    if (this._offStatus) this._offStatus()
    if (this._offState) this._offState()
    this._offStatus = null
    this._offState = null
  },

  // 从 deviceStore + bleClient 重建页面状态（切设备返回时 onShow 会重跑）。
  _refresh() {
    const app = getApp()
    const currentId = (app && app.globalData && app.globalData.currentDeviceId) || null
    const client = getCurrentBleClient()
    const connected = !!(client && client.connected)

    let deviceName = ''
    let pins = []
    if (currentId) {
      const dev = listDevices().find((d) => d.id === currentId)
      deviceName = dev ? dev.name : ''
      // 只展示已配置引脚：未配置（getDeviceConfig 为 null / pins 为空）时列表为空。
      const cfg = getDeviceConfig(currentId)
      const cfgPins = (cfg && Array.isArray(cfg.pins) ? cfg.pins : []).filter(
        (p) => p && p.configured
      )
      pins = cfgPins.map((p) => ({
        pin: p.pin,
        name: p.name || `引脚 ${p.pin + 1}`,
        power: !!p.power,
        img: p.img || '',
        info: `${p.groups.length} 个灯组`,
      }))
    }
    this.setData({ deviceName, connected, pins })
  },

  // 左上设备名称 → 设备列表页（新增/切换）。
  onTapDeviceName() {
    wx.navigateTo({ url: '/pages/device-list/device-list' })
  },

  // 引脚卡片 → 引脚配置详情页（#27 / T7）。
  onTapPin(e) {
    const pin = e.currentTarget.dataset.pin
    wx.navigateTo({ url: `/pages/pin-detail/pin-detail?pin=${pin}` })
  },

  onPowerChange(e) {
    this.setData({ power: e.detail.value })
  },

  onBrightnessChange(e) {
    this.setData({ brightness: e.detail.value })
  },

  // 引脚卡片内 switch 的 catchtap 占位：阻止点击冒泡到卡片（不触发跳转）。
  noop() {},
})