// 小程序入口（ADR-0027 底部导航 + 页面级 data，ADR-0023）。
// T5 (#25)：全局持有 bleClient 单例与当前设备 id，页面经 getCurrentBleClient() 共享。

// 小程序入口（ADR-0027 底部导航 + 页面级 data，ADR-0023）。
// T5 (#25)：全局持有 bleClient 单例与当前设备 id，页面经 getCurrentBleClient() 共享。
// 模拟模式：onLaunch 检测 simMode 开关，开启时注入模拟 client（mockBleClient），
// 便于无硬件环境下测试页面布局与交互；关闭时恢复真实 BLE client。

const GEN = require('./utils/protocol_gen')
const { createBleClient, setCurrentBleClient } = require('./utils/bleClient')
const { createSimBleClient } = require('./utils/mockBleClient')
const { isSimModeEnabled } = require('./utils/simMode')
const { getCurrentDeviceId } = require('./utils/deviceStore')
const userStore = require('./utils/userStore')
const cloudSync = require('./utils/cloudSync')
const telemetry = require('./utils/telemetry')

App({
  onLaunch(options) {
    console.log('bt-model-light onLaunch', options)
    const sim = isSimModeEnabled()
    setCurrentBleClient(sim ? createSimBleClient() : createBleClient())
    this.globalData.simMode = sim
    this.globalData.currentDeviceId = getCurrentDeviceId()

    // 遥测（ADR-0037）：启动量 + 模拟模式占比（演示数据不能混进真实 DAU）。
    telemetry.track('app.launch', { dim: sim ? 'sim' : 'real', value: 1 })

    // 已登录时静默续一次资料 + 设备清单（ADR-0035）。全部 best-effort：
    // 断网/后端不可用不影响 BLE 主流程，用户也不会看到报错弹窗。
    if (userStore.isLoggedIn()) {
      userStore
        .refreshProfile()
        .catch(() => null)
        .then(() => cloudSync.syncAll().catch(() => null))
        .then(() => {
          this.globalData.currentDeviceId = getCurrentDeviceId()
        })
    }
  },

  // 切后台/退出前把遥测队列发出去（尽力，不保证送达）。
  onHide() {
    telemetry.flushNow()
  },
  globalData: {
    currentDeviceId: null,
    // 模拟模式标志：页面可据此显示"（模拟）"提示。
    simMode: false,
    // 从 codegen 产物取版本，避免手写漂移（ADR-0011）。
    protocolVersion: GEN.PROTOCOL_VERSION.string,
    appVersion: GEN.APP_VERSION.string,
  },
})