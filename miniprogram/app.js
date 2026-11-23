// 小程序入口（ADR-0027 底部导航 + 页面级 data，ADR-0023）。
// T4 阶段仅提供工程骨架，页面实现见 T5/T7。

const GEN = require('./utils/protocol_gen')

App({
  onLaunch(options) {
    console.log('bt-model-light onLaunch', options)
  },
  globalData: {
    currentDeviceId: null,
    // 从 codegen 产物取版本，避免手写漂移（ADR-0011）。
    protocolVersion: GEN.PROTOCOL_VERSION.string,
    appVersion: GEN.APP_VERSION.string,
  },
})