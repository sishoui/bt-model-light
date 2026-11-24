// 首页 = 设备 Tab 默认页（ADR-0027 / #25）。
// 结构：左上设备名称（→ 设备列表页）+ 设备卡片（图片/状态/整体开关/整体亮度）
// + 引脚卡片列表（仅已配置引脚）。引脚卡片点击进入引脚配置详情页（T7 实现，
// 当前弹提示占位）。

const { getCurrentBleClient } = require('../../utils/bleClient')
const { listDevices, getDeviceConfig, saveDevice } = require('../../utils/deviceStore')
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
    img: '', // 设备图片（空串显示"暂无图片"占位）
    // 引脚卡片列表（仅已配置引脚，SPEC 用户故事 8）
    pins: [],
    // 可新增引脚：0..pinCount-1 中尚未配置的引脚索引（"新增引脚"选择器数据源）。
    availablePins: [],
    pinOptions: [], // 选择器展示文案（"引脚 N"，N 从 1 起）
    // 长按大图卡编辑弹窗
    editing: false, // 弹窗是否显示
    draftName: '', // 弹窗内编辑的设备名草稿
    draftImg: '', // 弹窗内编辑的占位图路径草稿
  },

  onShow() {
    const app = getApp()
    this.setData({ simMode: !!(app && app.globalData && app.globalData.simMode) })
    this._refresh()
    this._subscribeBle()
    // 自动重连：若有已保存的当前设备且未连接，尝试重连（静默，不弹 loading）。
    this._autoReconnect()
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

  // 自动重连：onShow 时若有当前设备且未连接，静默尝试重连。
  // 失败不弹 Toast（避免每次 onShow 骚扰），仅记录日志；下次 onShow 或
  // 用户手动点设备列表仍可重试。sim 模式下跳过（模拟 client 无真机）。
  _autoReconnect() {
    const app = getApp()
    if (app && app.globalData && app.globalData.simMode) return
    const client = getCurrentBleClient()
    if (!client || client.connected) return
    const currentId = (app && app.globalData && app.globalData.currentDeviceId) || null
    if (!currentId) return
    const dev = listDevices().find((d) => d.id === currentId)
    if (!dev || !dev.deviceId) return
    // 防抖：同一设备 5s 内不重复自动重连（onShow 频繁触发时）。
    const now = Date.now()
    if (this._lastAutoReconnect && now - this._lastAutoReconnect < 5000) return
    this._lastAutoReconnect = now
    client.connect(dev.deviceId).catch((err) => {
      logError(err, '自动重连')
    })
  },

  // 从 deviceStore + bleClient 重建页面状态（切设备返回时 onShow 会重跑）。
  _refresh() {
    const app = getApp()
    const currentId = (app && app.globalData && app.globalData.currentDeviceId) || null
    const client = getCurrentBleClient()
    const connected = !!(client && client.connected)

    let deviceName = ''
    let img = ''
    let pins = []
    let availablePins = []
    if (currentId) {
      const dev = listDevices().find((d) => d.id === currentId)
      deviceName = dev ? dev.name : ''
      img = (dev && dev.img) || ''
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
      // 可新增引脚：硬件 8 引脚中尚未配置的（含配置里标 configured:false 的）。
      const configuredSet = new Set(pins.map((p) => p.pin))
      const pinCount = GEN.LIMITS.pinCount
      for (let i = 0; i < pinCount; i++) {
        if (!configuredSet.has(i)) availablePins.push(i)
      }
    }
    const pinOptions = availablePins.map((i) => `引脚 ${i + 1}`)
    this.setData({ deviceName, img, connected, pins, availablePins, pinOptions })
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

  // "新增引脚"选择器：选中一个未配置引脚 → 进入引脚配置详情页（保存后才出现在首页）。
  onAddPin(e) {
    const index = Number(e.detail.value)
    const pin = this.data.availablePins[index]
    if (pin === undefined) return
    wx.navigateTo({ url: `/pages/pin-detail/pin-detail?pin=${pin}` })
  },

  onPowerChange(e) {
    this.setData({ power: e.detail.value })
  },

  onBrightnessChange(e) {
    this.setData({ brightness: e.detail.value })
  },

  // 拖动过程中实时更新（slider bindchanging）。
  onBrightnessChanging(e) {
    this.setData({ brightness: e.detail.value })
  },

  // 控制按钮“开关”：切换整体电源（复用 onPowerChange 写 data）。
  onTogglePower() {
    this.onPowerChange({ detail: { value: !this.data.power } })
  },

  // ---- 长按大图卡 → 编辑设备名 / 占位图 ------------------------------------
  onHeroLongPress() {
    this.setData({
      editing: true,
      draftName: this.data.deviceName,
      draftImg: this.data.img,
    })
  },

  onDraftNameInput(e) {
    this.setData({ draftName: e.detail.value })
  },

  // 从相册选图：chooseImage → saveFile 持久化到本地（临时路径冷启动会失效）。
  onChooseImg() {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempPath = res.tempFilePaths && res.tempFilePaths[0]
        if (!tempPath) return
        wx.saveFile({
          tempFilePath: tempPath,
          success: (saveRes) => {
            if (saveRes.savedFilePath) {
              this.setData({ draftImg: saveRes.savedFilePath })
            }
          },
          fail: () => {
            // saveFile 失败时退回临时路径（当前会话内仍可用）。
            this.setData({ draftImg: tempPath })
          },
        })
      },
    })
  },

  onEditCancel() {
    this.setData({ editing: false })
  },

  // 保存：写回 deviceStore（device.name / device.img），并刷新页面展示。
  onEditSave() {
    const app = getApp()
    const currentId = (app && app.globalData && app.globalData.currentDeviceId) || null
    if (currentId) {
      saveDevice({
        id: currentId,
        name: this.data.draftName,
        img: this.data.draftImg,
      })
    }
    this.setData({
      deviceName: this.data.draftName,
      img: this.data.draftImg,
      editing: false,
    })
  },

  // 引脚卡片内 switch 的 catchtap 占位：阻止点击冒泡到卡片（不触发跳转）。
  noop() {},
})