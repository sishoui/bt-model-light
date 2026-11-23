// 小程序入口（ADR-0027 底部导航 + 页面级 data，ADR-0023）。
// T5 (#25)：全局持有 bleClient 单例与当前设备 id，页面经 getCurrentBleClient() 共享。

const GEN = require('./utils/protocol_gen')
const { createBleClient, setCurrentBleClient } = require('./utils/bleClient')
const { getCurrentDeviceId } = require('./utils/deviceStore')

App({
  onLaunch(options) {
    console.log('bt-model-light onLaunch', options)
    // BLE 客户端全局单例：device-list 页连接，home/mine 页共用同一连接。
    setCurrentBleClient(createBleClient())
    this.globalData.currentDeviceId = getCurrentDeviceId()
  },
  globalData: {
    currentDeviceId: null,
    // 从 codegen 产物取版本，避免手写漂移（ADR-0011）。
    protocolVersion: GEN.PROTOCOL_VERSION.string,
    appVersion: GEN.APP_VERSION.string,
  },
})