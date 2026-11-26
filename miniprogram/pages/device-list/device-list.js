// 设备列表页：已保存设备 + 新增（扫描/连接）（ADR-0025 / 0027 / #25）。
// 点击已保存设备 → 连接并切换为当前设备（写 bt_current_device + globalData）；
// "新增设备" → 扫描（广播名前缀过滤 ble.csv namePrefix）→ 点选连接 → 保存。

const {
  listDevices,
  saveDevice,
  removeDevice,
  getCurrentDeviceId,
  setCurrentDeviceId,
  getDeviceConfig,
  saveDeviceConfig,
} = require('../../utils/deviceStore')
const { createBleClient, getCurrentBleClient, setCurrentBleClient } = require('../../utils/bleClient')
const { SIM_DEVICE_ID } = require('../../utils/mockBleClient')
const { friendlyMessage, logError } = require('../../utils/errorHandler')
const charts = require('../../utils/chartHelpers')

// RSSI 曲线采样上限：每个扫描结果设备保留最近 40 次上报（约 40 个点够看趋势）。
const RSSI_SAMPLES_MAX = 40

// 模拟设备默认引脚配置：8 引脚，第 1 引脚已启用（灯组 1，9 灯珠常亮白光）。
// 真实设备由固件/用户在引脚详情页配置；模拟设备无固件，连接后自动落盘以便首页展示。
function ensureSimDefaultConfig(savedDevice) {
  // 参数：savedDevice 是 saveDevice 返回的对象（含本地 id），或 null（切换已存在设备）。
  // 判断是否为模拟设备：deviceId 含 'sim-' 前缀。
  if (!savedDevice || !savedDevice.deviceId || savedDevice.deviceId.indexOf('sim-') !== 0) return
  const deviceId = savedDevice.id // 配置键是本地 id（与 deviceStore 一致）。
  const existing = getDeviceConfig(deviceId)
  if (existing && Array.isArray(existing.pins) && existing.pins.length) return // 已有配置不覆盖
  const config = {
    version: 1,
    pins: [
      {
        pin: 0,
        configured: true,
        name: '引脚 1',
        power: true,
        img: '',
        groups: [
          {
            name: '灯组 1',
            ledStart: 0,
            ledEnd: 9,
            steps: [
              {
                duration: 5,
                transition: 0,
                loopMode: 1,
                layers: [
                  {
                    effect: 1, // EFF.SOLID
                    params: { color: [255, 255, 255], brightness: 128 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
  saveDeviceConfig(deviceId, config)
}

Page({
  data: {
    devices: [], // 已保存设备（含 id/name/deviceId）
    currentId: '', // 当前选中设备 id
    scanning: false, // 是否正在扫描
    found: [], // 扫描到的设备（未保存，按 deviceId 去重）
    // 模拟模式标志（onShow 刷新，用于显示提示）。
    simMode: false,
  },

  onLoad() {
    this._scanSession = null // 当前扫描会话 { stop() }
    // RSSI 采样器：deviceId → sampler（每次扫描会话重建，纯内存不落盘）。
    this._rssiSamplers = {}
  },

  onShow() {
    const app = getApp()
    this.setData({ simMode: !!(app && app.globalData && app.globalData.simMode) })
    this._loadDevices()
  },

  onHide() {
    this._stopScan()
  },

  onUnload() {
    this._stopScan()
  },

  _loadDevices() {
    this.setData({ devices: listDevices(), currentId: getCurrentDeviceId() || '' })
  },

  // ---- 已保存设备：连接切换 / 删除 --------------------------------------------

  onTapDevice(e) {
    this._connectSwitchSave(null, e.currentTarget.dataset.id)
  },

  onLongPressDevice(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除设备',
      content: '删除后需重新扫描连接（设备配置同时清除）',
      success: (res) => {
        if (!res.confirm) return
        removeDevice(id)
        this._loadDevices()
      },
    })
  },

  // 扫描结果点选：连接 → 保存 → 切换 → 返回首页。
  onTapFound(e) {
    this._connectSwitchSave(
      { deviceId: e.currentTarget.dataset.deviceId, name: e.currentTarget.dataset.name },
      null
    )
  },

  // 连接 → 保存（可选）→ 切换当前设备 → 返回上一页。
  // newDevice: { deviceId, name } 非空表示新扫描设备（先 saveDevice）；否则按 id 取已保存设备。
  async _connectSwitchSave(newDevice, id) {
    let client = getCurrentBleClient()
    if (!client) {
      client = createBleClient()
      setCurrentBleClient(client)
    }
    const target = newDevice
      ? newDevice
      : (() => {
          const dev = listDevices().find((d) => d.id === id)
          return dev ? { deviceId: dev.deviceId, name: dev.name } : null
        })()
    if (!target) return

    wx.showLoading({ title: '连接中' })
    try {
      await client.connect(target.deviceId)
      // 新扫描设备：先落盘再切换（saveDevice 按 deviceId 去重，重复扫描安全）。
      const saved = newDevice ? saveDevice({ name: target.name, deviceId: target.deviceId }) : null
      const nextId = saved ? saved.id : id
      setCurrentDeviceId(nextId)
      const app = getApp()
      if (app && app.globalData) app.globalData.currentDeviceId = nextId
      this._stopScan() // 连接成功：停止扫描（stop 不再关适配器，保连接）
      // 模拟设备首次连接：自动落盘默认引脚配置，使首页能展示引脚卡片。
      // 参数：savedDevice（含本地 id）或 null（切换已存在设备）。
      ensureSimDefaultConfig(saved)
      wx.hideLoading()
      wx.showToast({ title: newDevice ? '已添加' : '已切换', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (err) {
      wx.hideLoading()
      logError(err, '连接设备')
      wx.showToast({ title: friendlyMessage(err), icon: 'none' })
    }
  },

  // ---- 新增设备：扫描 + 连接 ---------------------------------------------------

  onTapAdd() {
    if (this.data.scanning) {
      this._stopScan()
      return
    }
    this._startScan()
  },

  _startScan() {
    this.setData({ scanning: true, found: [] })
    // 新扫描会话：RSSI 采样从头开始（旧会话的点与新会话不可比）。
    this._rssiSamplers = {}
    let client = getCurrentBleClient()
    if (!client) {
      client = createBleClient()
      setCurrentBleClient(client)
    }
    this._scanSession = client.scanDevices({
      onFound: (d) => {
        // 扫描结果按 deviceId 去重合并（bleClient 的 RSSI 取最大值）。
        // 同时把每次上报的瞬时 rssi 攒进采样器 → 行内信号曲线。
        const series = this._sampleRssi(d.deviceId, d.rssi !== undefined ? d.rssi : d.RSSI)
        const found = this.data.found.slice()
        const idx = found.findIndex((f) => f.deviceId === d.deviceId)
        const row = Object.assign({}, d, { rssiSeries: series })
        if (idx >= 0) found[idx] = row
        else found.push(row)
        this.setData({ found })
      },
      onError: (err) => {
        this.setData({ scanning: false })
        logError(err, '扫描设备')
        wx.showToast({ title: friendlyMessage(err), icon: 'none' })
      },
    })
  },

  // 采样一次 RSSI → 返回该设备当前曲线（每点 { i, h }，h 为柱高百分比）。
  // 扫描会话内纯内存累积，重扫清空（不同会话的信号不可比）。
  _sampleRssi(deviceId, rssi) {
    const v = Number(rssi)
    if (!isFinite(v)) return []
    if (!this._rssiSamplers) this._rssiSamplers = {}
    if (!this._rssiSamplers[deviceId]) {
      this._rssiSamplers[deviceId] = charts.createRssiSampler(RSSI_SAMPLES_MAX)
    }
    this._rssiSamplers[deviceId].push(v)
    return this._rssiSamplers[deviceId]
      .points()
      .map((p, i) => ({ i, h: Math.round(p.y * 100) }))
  },

  _stopScan() {
    if (this._scanSession) {
      this._scanSession.stop()
      this._scanSession = null
    }
    if (this.data.scanning) this.setData({ scanning: false })
  },
})