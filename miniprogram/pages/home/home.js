// 首页 = 设备 Tab 默认页（ADR-0027 / #25）。
// 结构：左上设备名称（→ 设备列表页）+ 设备卡片（图片/状态/整体开关/整体亮度）
// + 引脚卡片列表（固定 8 个，硬件引脚不可增删；未配置引脚显示占位，点击进入配置）。
// 引脚卡片点击进入引脚配置详情页。
//
// 整机开关/亮度（ADR-0031 / ADR-0032）：两者都是设备级状态（存设备记录、由
// autoSync 断连补发），各下发一条 1 字节命令——开关 = SET_POWER（关 = 设备输出
// 全黑，**各引脚状态不变**；关机时引脚卡片置灰不可操作），亮度 = SET_BRIGHTNESS
// （固件输出级统一缩放，拖动实时下发、松手落盘）。

const { getCurrentBleClient } = require('../../utils/bleClient')
const {
  listDevices,
  getDeviceConfig,
  saveDevice,
  saveDeviceConfig,
  clampBrightness,
  getDevicePower,
  saveDevicePower,
  getDeviceBrightness,
  saveDeviceBrightness,
  BRIGHTNESS_DEFAULT,
  POWER_DEFAULT,
} = require('../../utils/deviceStore')
const { friendlyMessage, logError } = require('../../utils/errorHandler')
const { validateConfig } = require('../../utils/configCodec')
const autoSync = require('../../utils/autoSync')
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
    // 整体开关 = 设备级总开关（ADR-0032）：落盘在设备记录，下发走 SET_POWER。
    // 关 = 设备输出全黑；各引脚自己的开关状态不受影响，开机后按原状态恢复。
    power: POWER_DEFAULT,
    // 整体亮度 0-255（ADR-0031）：落盘在设备记录，下发走 SET_BRIGHTNESS。
    // 255 = 不缩放，与固件默认一致——没设置过的设备显示的就是真实状态。
    brightness: BRIGHTNESS_DEFAULT,
    img: '', // 设备图片（空串显示"暂无图片"占位）
    // 引脚卡片列表（固定 8 个硬件引脚，不可增删；未配置引脚为占位卡）。
    pins: [],
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
    let power = POWER_DEFAULT
    let brightness = this.data.brightness
    if (currentId) {
      const dev = listDevices().find((d) => d.id === currentId)
      deviceName = dev ? dev.name : ''
      img = (dev && dev.img) || ''
      // 整机开关/亮度：设备记录上的值（缺省 开 / 255）。
      // 亮度拖动中不覆盖，避免回弹（见 onBrightnessChanging）。
      power = getDevicePower(currentId)
      if (!this._draggingBrightness) brightness = getDeviceBrightness(currentId)
      // 固定 8 个引脚：硬件引脚不可增删，未配置的显示占位卡（点击进入配置）。
      const cfg = getDeviceConfig(currentId)
      const cfgPins = (cfg && Array.isArray(cfg.pins) ? cfg.pins : []).filter(
        (p) => p && p.configured
      )
      const pinCount = GEN.LIMITS.pinCount
      for (let i = 0; i < pinCount; i++) {
        const p = cfgPins.find((e) => e.pin === i)
        pins.push({
          pin: i,
          configured: !!p,
          name: (p && p.name) || `引脚 ${i + 1}`,
          // 灯带开关：只有显式 power === false 才算关（老配置无该字段 → 开，ADR-0028）。
          power: !(p && p.power === false),
          img: (p && p.img) || '',
          info: p ? `${p.groups.length} 个灯组` : '未配置',
        })
      }
    }
    this.setData({ deviceName, img, connected, pins, power, brightness })
  },

  // 左上设备名称 → 设备列表页（新增/切换）。
  onTapDeviceName() {
    wx.navigateTo({ url: '/pages/device-list/device-list' })
  },

  // 引脚卡片 → 引脚配置详情页（#27 / T7）。未配置引脚同样进入（首次配置）。
  // 设备关机时引脚区整体不可操作（ADR-0032）：卡片置灰且点了没反应。
  onTapPin(e) {
    if (!this.data.power) return
    const pin = e.currentTarget.dataset.pin
    wx.navigateTo({ url: `/pages/pin-detail/pin-detail?pin=${pin}` })
  },

  // 引脚卡片灯带开关（ADR-0028）：写 pin.power 落盘 Storage 后经 autoSync 下发。
  // 关 = 编码时该引脚不下发灯组（group_count=0）→ 固件清空该灯带；开 = 恢复原灯组配置。
  // 与引脚配置详情页顶部开关同一字段，两边状态经 Storage 共享。
  // 设备关机时开关被 disabled（ADR-0032），这里的兜底保证即使被触发也不改状态。
  onPinPowerChange(e) {
    if (!this.data.power) return
    const pin = Number(e.currentTarget.dataset.pin)
    const power = !!(e.detail && e.detail.value)
    const app = getApp()
    const currentId = (app && app.globalData && app.globalData.currentDeviceId) || null
    if (!currentId) return
    const base = getDeviceConfig(currentId)
    const pins = base && Array.isArray(base.pins) ? base.pins.slice() : []
    const idx = pins.findIndex((p) => p && p.pin === pin)
    if (idx < 0) return // 未配置引脚没有开关（WXML 已用 configured 过滤），兜底忽略
    pins[idx] = Object.assign({}, pins[idx], { power })
    const config = { version: (base && base.version) || 1, pins }

    // 与 pin-detail._markDirty 同口径：校验不过就不落盘（下发链路同样会编码失败）。
    const verr = validateConfig(config)
    if (verr) {
      wx.showToast({ title: '引脚配置无效，请进入配置页检查', icon: 'none' })
      this._refresh() // 开关回弹到 Storage 的真实状态
      return
    }
    saveDeviceConfig(currentId, config)
    // 开关是离散动作：跳过 autoSync 的 500ms 防抖，立即下发（ADR-0029）。
    autoSync.schedule(currentId, config, { immediate: true })
    this._refresh()
  },

  // 整体亮度（ADR-0031）：松手落盘 Storage + 下发最终值（bindchange）。
  onBrightnessChange(e) {
    this._draggingBrightness = false
    this.setData({ brightness: clampBrightness(e.detail.value) })
    this._sendBrightness(this.data.brightness, { persist: true })
  },

  // 拖动过程中实时下发（slider bindchanging）：不落盘，松手才写 Storage。
  // autoSync 按"最新值待发"合并，拖动不会把空口塞满。
  onBrightnessChanging(e) {
    this._draggingBrightness = true
    this.setData({ brightness: clampBrightness(e.detail.value) })
    this._sendBrightness(this.data.brightness)
  },

  // 控制按钮“开关”：设备级总开关（ADR-0032），**不改各引脚自己的状态**。
  // 按钮文案是"要做的动作"：power=true（设备开着）→ 显示“关机” → 点一下关机。
  onTogglePower() {
    this._applyMasterPower(!this.data.power)
  },

  // 设备级总开关：关 = 下发 SET_POWER 0（固件输出全黑），各引脚的灯带开关与灯组
  // 配置原样保留（开机后按原状态恢复）；开 = 下发 SET_POWER 1。
  // 落盘在设备记录上，与整机亮度一样由 autoSync 补发。
  _applyMasterPower(on) {
    const currentId = this._currentDeviceId()
    if (!currentId) return
    const value = saveDevicePower(currentId, on)
    autoSync.schedulePower(currentId, value)
    this._refresh()
  },

  _currentDeviceId() {
    const app = getApp()
    return (app && app.globalData && app.globalData.currentDeviceId) || null
  },

  // 整机亮度下发；opts.persist 时先落盘（只有松手那次写 Storage）。
  // 无当前设备时只更新界面：没有可落盘/可控的对象（不凭空造设备记录）。
  _sendBrightness(value, opts) {
    const currentId = this._currentDeviceId()
    if (!currentId) return
    if (opts && opts.persist) saveDeviceBrightness(currentId, value)
    autoSync.scheduleBrightness(currentId, value)
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
  // 开关本身的状态变化走 onPinPowerChange（bindchange），与此无关。
  noop() {},
})