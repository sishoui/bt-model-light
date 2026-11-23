// 设备列表页：已保存设备 + 新增（扫描/连接）（ADR-0025 / 0027 / #25）。
// 点击已保存设备 → 连接并切换为当前设备（写 bt_current_device + globalData）；
// "新增设备" → 扫描（广播名前缀过滤 ble.csv namePrefix）→ 点选连接 → 保存。

const {
  listDevices,
  saveDevice,
  removeDevice,
  getCurrentDeviceId,
  setCurrentDeviceId,
} = require('../../utils/deviceStore')
const { createBleClient, getCurrentBleClient, setCurrentBleClient } = require('../../utils/bleClient')

Page({
  data: {
    devices: [], // 已保存设备（含 id/name/deviceId）
    currentId: '', // 当前选中设备 id
    scanning: false, // 是否正在扫描
    found: [], // 扫描到的设备（未保存，按 deviceId 去重）
  },

  onLoad() {
    this._scanSession = null // 当前扫描会话 { stop() }
  },

  onShow() {
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
      wx.hideLoading()
      wx.showToast({ title: newDevice ? '已添加' : '已切换', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: `连接失败：${(err && err.message) || err}`, icon: 'none' })
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
    let client = getCurrentBleClient()
    if (!client) {
      client = createBleClient()
      setCurrentBleClient(client)
    }
    this._scanSession = client.scanDevices({
      onFound: (d) => {
        // 扫描结果按 deviceId 去重合并（bleClient 的 RSSI 取最大值）。
        const found = this.data.found.slice()
        const idx = found.findIndex((f) => f.deviceId === d.deviceId)
        if (idx >= 0) found[idx] = d
        else found.push(d)
        this.setData({ found })
      },
      onError: (err) => {
        this.setData({ scanning: false })
        wx.showToast({ title: `扫描失败：${(err && err.errMsg) || err}`, icon: 'none' })
      },
    })
  },

  _stopScan() {
    if (this._scanSession) {
      this._scanSession.stop()
      this._scanSession = null
    }
    if (this.data.scanning) this.setData({ scanning: false })
  },
})