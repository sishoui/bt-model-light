// 我的页（底部导航第二 Tab）：设置/关于/帮助（ADR-0027 / #25）。
// 版本信息从 codegen 产物取（ADR-0011），避免手写漂移。

const GEN = require('../../utils/protocol_gen')

// 关于/帮助弹层内容（v1 静态文案；后续接 docs/ 链接）。
const HELP_TEXT =
  '使用帮助：\n' +
  '1. 打开设备电源，在设备列表页点"新增设备"扫描周边 BTLight_ 设备\n' +
  '2. 点选设备完成连接，返回首页即可控制\n' +
  '3. 首页展示设备状态与已配置引脚\n' +
  '4. 遇到问题长按设备删除后重新连接'

Page({
  data: {
    version: GEN.APP_VERSION.string,
    protocolVersion: GEN.PROTOCOL_VERSION.string,
  },

  // ---- 设置 ------------------------------------------------------------------

  onClearStorage() {
    wx.showModal({
      title: '清除本地数据',
      content: '将删除已保存设备与配置（不影响设备本身）',
      success: (res) => {
        if (!res.confirm) return
        try {
          const keys = wx.getStorageInfoSync().keys
          for (const k of keys) {
            if (k === 'bt_devices' || k === 'bt_current_device' || k.indexOf('device_config_') === 0) {
              wx.removeStorageSync(k)
            }
          }
          const app = getApp()
          if (app && app.globalData) app.globalData.currentDeviceId = null
          wx.showToast({ title: '已清除', icon: 'success' })
        } catch (err) {
          wx.showToast({ title: `清除失败：${err}`, icon: 'none' })
        }
      },
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