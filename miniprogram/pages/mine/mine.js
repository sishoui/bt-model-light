// 我的页（底部导航第二 Tab）：设置/关于/帮助（ADR-0027 / #25）。
// 版本信息从 codegen 产物取（ADR-0011），避免手写漂移。
// 模拟模式开关：开启后注入模拟 BLE client，便于无硬件环境下测试布局。

const GEN = require('../../utils/protocol_gen')
const { isSimModeEnabled, setSimModeEnabled } = require('../../utils/simMode')
const { setCurrentBleClient, createBleClient } = require('../../utils/bleClient')
const { createSimBleClient, SIM_DEVICE_ID } = require('../../utils/mockBleClient')
const { getErrorLog, clearErrorLog } = require('../../utils/errorHandler')

// 关于/帮助弹层内容（v1 静态文案；后续接 docs/ 链接）。
const HELP_TEXT =
  '使用帮助：\n' +
  '1. 打开设备电源，在设备列表页点"新增设备"扫描周边 BTLight_ 设备\n' +
  '2. 点选设备完成连接，返回首页即可控制\n' +
  '3. 首页展示设备状态与 8 个引脚（硬件固定，不可增删）\n' +
  '4. 遇到问题长按设备删除后重新连接\n' +
  '5. 无硬件环境可在「设置」中开启模拟模式'

Page({
  data: {
    version: GEN.APP_VERSION.string,
    protocolVersion: GEN.PROTOCOL_VERSION.string,
    // 模拟模式开关当前态（onShow 刷新）。
    simModeEnabled: false,
    // 本地日志条数（onShow 刷新）。
    errorLogCount: 0,
  },

  onShow() {
    this.setData({
      simModeEnabled: isSimModeEnabled(),
      errorLogCount: getErrorLog().length,
    })
  },

  // ---- 设置 ------------------------------------------------------------------

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
        const { listDevices, setCurrentDeviceId } = require('../../utils/deviceStore')
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
      content: '将删除已保存设备与配置（不影响设备本身）',
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
          this.setData({ errorLogCount: 0 })
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
    // 取最近 10 条，格式化为可读文本。
    const recent = log.slice(-10).reverse()
    const lines = recent.map((e) => {
      const ts = new Date(e.ts).toLocaleString()
      return `[${ts}] ${e.context || ''}\n  code=${e.code} ${e.message}`
    })
    wx.showModal({
      title: `本地日志（最近 ${recent.length}/${log.length} 条）`,
      content: lines.join('\n\n'),
      showCancel: false,
    })
  },

  // ---- 关于 ------------------------------------------------------------------

  onTapAbout() {
    wx.showModal({
      title: '关于',
      content:
        `bt-model-light v${this.data.version}\n` +
        `协议版本 ${this.data.protocolVersion}\n` +
        'ESP32-C3 八路 WS2812B 灯带灯控（微信小程序端）',
      showCancel: false,
    })
  },

  // ---- 帮助 ------------------------------------------------------------------

  onTapHelp() {
    wx.showModal({
      title: '帮助',
      content: HELP_TEXT,
      showCancel: false,
    })
  },
})