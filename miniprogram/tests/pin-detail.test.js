// Jest 单测：miniprogram/pages/pin-detail/pin-detail.js（#27 / T7）。
//
// 用 pageHarness 装载页面（同 home.test.js），fake bleClient 断言保存链路
// 的命令顺序与参数（SPEC seam 3：BLE 命令边界 Jest + wx mock 覆盖调用顺序与参数）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { flush } = require('./bleTestUtils')
const { saveDevice, saveDeviceConfig, getDeviceConfig, resetDeviceStore } = require('../utils/deviceStore')
const { setCurrentBleClient } = require('../utils/bleClient')
const { decodeConfigBlob } = require('../utils/configCodec')
const { CMD, EFF } = require('../utils/protocol_gen')

const PIN = '../pages/pin-detail/pin-detail'

// fake BLE 客户端：只关心 connected + sendCmd 调用顺序/参数。
function fakeClient(connected) {
  return { connected: !!connected, sendCmd: jest.fn(() => Promise.resolve()) }
}

// 取 activeGroup 当前层的字段（按 name 查）。
function fieldOf(layer, name) {
  return layer.fields.find((f) => f.name === name)
}

// 取 ledCells 中 on 的数量。
function litCount(page) {
  return page.data.ledCells.filter((c) => c.on).length
}

describe('pin-detail 页（#27）', () => {
  let wx
  let app
  let dev

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    setCurrentBleClient(null)
    dev = saveDevice({ name: 'BTLight_Test', deviceId: 'dev-1' })
    app = makeApp(dev.id)
  })

  function load(pin) {
    const page = loadPage(PIN, app)
    page.onLoad({ pin: String(pin === undefined ? 0 : pin) })
    return page
  }

  test('加载已有引脚配置：顶部/灯组/范围/步骤/图层/参数回填', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          name: '客厅灯带',
          power: true,
          configured: true,
          groups: [
            {
              name: '流水',
              ledStart: 2,
              ledEnd: 5,
              steps: [
                {
                  duration: 7,
                  transition: 1,
                  loopMode: 2,
                  layers: [{ effect: EFF.SOLID, params: { color: [1, 2, 3], brightness: 200 } }],
                },
              ],
            },
          ],
        },
      ],
    })

    const page = load(0)
    expect(page.data.pinName).toBe('客厅灯带')
    expect(page.data.power).toBe(true)
    expect(page.data.groups).toHaveLength(1)
    const g = page.data.groups[0]
    expect(g.name).toBe('流水')
    expect(g.ledStart).toBe(2)
    expect(g.ledEnd).toBe(5)
    expect(litCount(page)).toBe(4) // [2,5] 共 4 颗
    const step = g.steps[0]
    expect(step.duration).toBe(7)
    expect(step.transition).toBe(1)
    expect(step.loopMode).toBe(2)
    const layer = step.layers[0]
    expect(layer.effect).toBe(EFF.SOLID)
    expect(fieldOf(layer, 'color').value).toEqual([1, 2, 3])
    expect(fieldOf(layer, 'brightness').value).toBe(200)
    expect(page.data.dirty).toBe(false)
  })

  test('无配置：默认 1 灯组 / 1 步骤 / 1 图层 / 常亮', () => {
    const page = load(0)
    expect(page.data.pinName).toBe('引脚 1')
    expect(page.data.groups).toHaveLength(1)
    expect(page.data.groups[0].steps).toHaveLength(1)
    expect(page.data.groups[0].steps[0].layers).toHaveLength(1)
    expect(page.data.groups[0].steps[0].layers[0].effect).toBe(EFF.SOLID)
    expect(page.data.groups[0].ledStart).toBe(0)
    expect(page.data.groups[0].ledEnd).toBe(9)
    expect(page.data.dirty).toBe(false)
  })

  test('灯组 Tab：新增到上限 5，超出 Toast；点击切换', () => {
    const page = load(0)
    page.onAddGroup()
    expect(page.data.groups).toHaveLength(2)
    expect(page.data.activeGroup).toBe(1)
    page.onAddGroup()
    page.onAddGroup()
    page.onAddGroup() // 共 5
    expect(page.data.groups).toHaveLength(5)
    page.onAddGroup() // 第 6 个：拒绝
    expect(page.data.groups).toHaveLength(5)
    expect(wx.showToast).toHaveBeenCalled()

    page.onTapGroup({ currentTarget: { dataset: { index: 0 } } })
    expect(page.data.activeGroup).toBe(0)
    expect(page.data.dirty).toBe(true)
  })

  test('删除灯组：>1 可删（确认），=1 拒绝', () => {
    const page = load(0)
    page.onAddGroup() // 2 组
    page.onDeleteGroup({ currentTarget: { dataset: { index: 1 } } })
    expect(page.data.groups).toHaveLength(1) // showModal mock 默认 confirm

    page.onDeleteGroup({ currentTarget: { dataset: { index: 0 } } }) // 仅剩 1：拒绝
    expect(page.data.groups).toHaveLength(1)
  })

  test('重命名灯组：输入即改 name 并置 dirty', () => {
    const page = load(0)
    page.onGroupNameInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '彩虹带' } })
    expect(page.data.groups[0].name).toBe('彩虹带')
    expect(page.data.dirty).toBe(true)
  })

  test('灯珠范围点选：先点起点再点终点，高亮区间随之更新', () => {
    const page = load(0)
    // 默认 [0,9]。点起点 3 → [3,9]（终点暂留），picking 转 end。
    page.onTapLed({ currentTarget: { dataset: { i: 3 } } })
    expect(page.data.picking).toBe('end')
    expect(page.data.groups[0].ledStart).toBe(3)
    // 点终点 7 → [3,7]。
    page.onTapLed({ currentTarget: { dataset: { i: 7 } } })
    expect(page.data.groups[0].ledEnd).toBe(7)
    expect(page.data.groups[0].ledStart).toBe(3)
    expect(page.data.picking).toBe('start')
    expect(litCount(page)).toBe(5) // 3,4,5,6,7
  })

  test('灯珠范围点选：终点反向 → 交换起止保证合法', () => {
    const page = load(0)
    page.onTapLed({ currentTarget: { dataset: { i: 5 } } }) // 起点 5 → [5,9]
    page.onTapLed({ currentTarget: { dataset: { i: 2 } } }) // 终点 2 < 5 → 交换
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(5)
  })

  test('步骤：增到上限 5，删到下限 1', () => {
    const page = load(0)
    page.onDeleteStep({ currentTarget: { dataset: { si: 0 } } }) // 仅 1：拒绝
    expect(page.data.groups[0].steps).toHaveLength(1)

    page.onAddStep()
    page.onAddStep()
    page.onAddStep()
    page.onAddStep() // 共 5
    expect(page.data.groups[0].steps).toHaveLength(5)
    page.onAddStep() // 拒绝
    expect(page.data.groups[0].steps).toHaveLength(5)

    page.onDeleteStep({ currentTarget: { dataset: { si: 0 } } })
    expect(page.data.groups[0].steps).toHaveLength(4)
  })

  test('图层：增到上限 2，删到下限 1', () => {
    const page = load(0)
    page.onAddLayer({ currentTarget: { dataset: { si: 0 } } })
    expect(page.data.groups[0].steps[0].layers).toHaveLength(2)
    page.onAddLayer({ currentTarget: { dataset: { si: 0 } } }) // 拒绝
    expect(page.data.groups[0].steps[0].layers).toHaveLength(2)

    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 0 } } })
    expect(page.data.groups[0].steps[0].layers).toHaveLength(1)
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 0 } } }) // 拒绝
    expect(page.data.groups[0].steps[0].layers).toHaveLength(1)
  })

  test('切换灯效：参数表单按 schema 联动（常亮 → 呼吸）', () => {
    const page = load(0)
    // 常亮字段：color + brightness。
    expect(fieldOf(page.data.groups[0].steps[0].layers[0], 'period')).toBeUndefined()
    // 切到 BREATH（EFFECT_OPTIONS 按 id 升序，索引 1 = BREATH）。
    page.onEffectChange({ currentTarget: { dataset: { si: 0, li: 0 } }, detail: { value: 1 } })
    const layer = page.data.groups[0].steps[0].layers[0]
    expect(layer.effect).toBe(EFF.BREATH)
    expect(layer.effectName).toBe('呼吸') // WXML 直接显示，不依赖 id 下标运算
    expect(fieldOf(layer, 'period')).toBeDefined()
    expect(fieldOf(layer, 'waveform')).toBeDefined()
    expect(fieldOf(layer, 'speed')).toBeDefined()
  })

  test('参数输入：标量域与 rgb 通道写入并置 dirty', () => {
    const page = load(0)
    const layer = page.data.groups[0].steps[0].layers[0]
    const brightFi = layer.fields.findIndex((f) => f.name === 'brightness')
    const colorFi = layer.fields.findIndex((f) => f.name === 'color')
    // 亮度 100。
    page.onParamInput({ currentTarget: { dataset: { si: 0, li: 0, fi: brightFi } }, detail: { value: '100' } })
    // 颜色 G 通道 99。
    page.onParamInput({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi, ch: 1 } }, detail: { value: '99' } })
    const after = page.data.groups[0].steps[0].layers[0]
    expect(fieldOf(after, 'brightness').value).toBe(100)
    expect(fieldOf(after, 'color').value).toEqual([255, 99, 255])
    expect(page.data.dirty).toBe(true)
  })

  test('保存：未连接 → 写 Storage + Toast，不发送命令', () => {
    const page = load(0)
    setCurrentBleClient(null)
    page.onSave()
    // Storage 真相源已写入。
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).configured).toBe(true)
    expect(wx.showToast).toHaveBeenCalled()
    const arg = wx.showToast.mock.calls[wx.showToast.mock.calls.length - 1][0]
    expect(arg.title).toContain('未连接')
    expect(page.data.dirty).toBe(false)
  })

  test('保存：已连接 → 先 WRITE_CONFIG 后 APPLY，blob 可解码', async () => {
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    page.onSave()
    await flush()

    expect(client.sendCmd).toHaveBeenCalledTimes(2)
    const [cmd1, blob] = client.sendCmd.mock.calls[0]
    const [cmd2] = client.sendCmd.mock.calls[1]
    expect(cmd1).toBe(CMD.WRITE_CONFIG)
    expect(cmd2).toBe(CMD.APPLY)
    // blob 解回配置，pin 0 存在且灯组数一致。
    const decoded = decodeConfigBlob(Uint8Array.from(blob))
    expect(decoded.pins.find((p) => p.pin === 0).groups).toHaveLength(1)
    expect(page.data.dirty).toBe(false)
  })

  test('保存：校验失败（终点 < 起点）→ Toast，不写 Storage、不下发', () => {
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    page.setData({ 'groups[0].ledStart': 5, 'groups[0].ledEnd': 0 })
    page.onSave()
    expect(wx.showToast).toHaveBeenCalled()
    expect(getDeviceConfig(dev.id)).toBeNull() // 未写
    expect(client.sendCmd).not.toHaveBeenCalled()
  })

  test('保存：保留其他引脚配置', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        { pin: 0, configured: true, name: 'A', groups: [{ name: 'g', ledStart: 0, ledEnd: 3, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] }] },
        { pin: 3, configured: true, name: 'B', groups: [{ name: 'h', ledStart: 0, ledEnd: 4, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [2, 2, 2], brightness: 20 } }] }] }] },
      ],
    })
    const page = load(0)
    page.onSave()
    const pins = getDeviceConfig(dev.id).pins
    expect(pins.map((p) => p.pin)).toEqual([0, 3]) // pin 3 原样保留
  })

  test('dirty 时开启离开拦截，保存后解除', () => {
    const page = load(0)
    expect(wx.disableAlertBeforeUnload).toHaveBeenCalled() // onLoad 时 clean
    page.onPinNameInput({ detail: { value: '新名' } })
    expect(wx.enableAlertBeforeUnload).toHaveBeenCalled()
    page.onSave() // 未连接也能落盘 → clean
    expect(wx.disableAlertBeforeUnload).toHaveBeenCalled()
  })
})