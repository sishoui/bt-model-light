// Jest 单测：miniprogram/pages/pin-detail/pin-detail.js（#27 / T7）。
//
// 用 pageHarness 装载页面（同 home.test.js），fake bleClient 断言保存链路
// 的命令顺序与参数（SPEC seam 3：BLE 命令边界 Jest + wx mock 覆盖调用顺序与参数）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { flush } = require('./bleTestUtils')
const { saveDevice, saveDeviceConfig, saveDevicePower, getDeviceConfig, resetDeviceStore } = require('../utils/deviceStore')
const { getRecentColors, resetRecentColors } = require('../utils/recentColors')
const { setCurrentBleClient } = require('../utils/bleClient')
const autoSync = require('../utils/autoSync')
const { decodeConfigBlob } = require('../utils/configCodec')
const { CMD, EFF } = require('../utils/protocol_gen')
const { effectColor } = require('../utils/chartHelpers')

const PIN = '../pages/pin-detail/pin-detail'

// fake BLE 客户端：只关心 connected + sendCmd 调用顺序/参数。
function fakeClient(connected) {
  return { connected: !!connected, sendCmd: jest.fn(() => Promise.resolve()) }
}

// 取 activeGroup 当前层的字段（按 name 查）。
function fieldOf(layer, name) {
  return layer.fields.find((f) => f.name === name)
}

// 用刻度轴把某段时长设成指定值（时长 UI 已无 slider/输入框，只有刻度轴）。
// 做法：展开该段时长轴 → 量好轴宽 → 按目标值反算比例拖到该点 → 松手落盘。
function setDuration(page, si, seconds) {
  page.onToggleGauge({ currentTarget: { dataset: { si, kind: 'duration' } } })
  page._gaugeRect = { left: 0, width: 1000 }
  const ratio = (seconds - 1) / (60 - 1)
  page.onGaugeTouchMove({ touches: [{ clientX: ratio * 1000 }] })
  page.onGaugeTouchEnd()
}

// 取 ledCells 中 state==='selected' 的数量。
function litCount(page) {
  return page.data.ledCells.filter((c) => c.state === 'selected').length
}

describe('pin-detail 页（#27）', () => {
  let wx
  let app
  let dev

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    resetRecentColors()
    setCurrentBleClient(null)
    autoSync.reset()
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
    // 已存 1 个灯组：原样保留为第 1 个，其余补默认灯组，共 5 个。
    expect(page.data.groups).toHaveLength(5)
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
    // 补齐的默认灯组：灯组 2..5 为默认空态（255 哨兵）。
    expect(page.data.groups[1].name).toBe('灯组 2')
    expect(page.data.groups[4].name).toBe('灯组 5')
    expect(page.data.groups[1].ledStart).toBe(0xff)
    expect(page.data.groups[1].ledEnd).toBe(0xff)
    expect(page.data.syncState).toBe('idle')
  })

  test('无配置：默认 5 灯组 / 1 步骤 / 背景槽常亮 + 动效槽空', () => {
    const page = load(0)
    expect(page.data.pinName).toBe('引脚 1')
    expect(page.data.groups).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(page.data.groups[i].name).toBe(`灯组 ${i + 1}`)
      expect(page.data.groups[i].steps).toHaveLength(1)
      // 固定两格：背景槽默认常亮，动效槽留空。
      const layers = page.data.groups[i].steps[0].layers
      expect(layers).toHaveLength(2)
      expect(layers[0].empty).toBe(false)
      expect(layers[0].effect).toBe(EFF.SOLID)
      expect(layers[0].role).toBe('背景')
      expect(layers[1].empty).toBe(true)
      expect(layers[1].role).toBe('动效')
      // 默认空态：255 哨兵（未选灯珠）。
      expect(page.data.groups[i].ledStart).toBe(0xff)
      expect(page.data.groups[i].ledEnd).toBe(0xff)
    }
    expect(page.data.activeGroup).toBe(0)
    expect(litCount(page)).toBe(0) // 默认全空
    // 首次配置的引脚灯带开关默认开（ADR-0028：只有显式关才不下发灯组）。
    expect(page.data.power).toBe(true)
    expect(page.data.syncState).toBe('idle')
  })

  test('老配置无 power 字段：顶部灯带开关默认开（切页不误灭灯，ADR-0028）', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          name: '客厅灯带',
          configured: true,
          groups: [
            { name: '流水', ledStart: 0, ledEnd: 3, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] },
          ],
        },
      ],
    })
    const page = load(0)
    expect(page.data.power).toBe(true)
  })

  test('顶部灯带开关：立即下发（不等防抖）WRITE_CONFIG + APPLY（ADR-0029）', async () => {
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    page.onPowerChange({ detail: { value: false } })
    // 不推进任何定时器：微任务走完即已下发（离散动作跳过 500ms 防抖）。
    await flush()
    expect(client.sendCmd.mock.calls.map((c) => c[0])).toEqual([CMD.WRITE_CONFIG, CMD.APPLY])
    // 关灯：blob 里该引脚不下发灯组 → 固件清空灯带。
    expect(decodeConfigBlob(Uint8Array.from(client.sendCmd.mock.calls[0][1])).pins).toEqual([])
  })

  test('设备关机（整机关 off）：顶部灯带开关置灰不可切换，点了不落盘不崩（ADR-0032）', async () => {
    const client = fakeClient(true)
    setCurrentBleClient(client)
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          name: '客厅灯带',
          configured: true,
          groups: [
            { name: '流水', ledStart: 0, ledEnd: 3, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] },
          ],
        },
      ],
    })
    saveDevicePower(dev.id, false) // 设备关机

    const page = load(0)
    expect(page.data.masterPower).toBe(false) // WXML 据此 disabled
    page.onPowerChange({ detail: { value: false } }) // 兜底：即使被触发也不改状态
    expect(page.data.power).toBe(true) // 灯带开关状态照旧（pin 未显式关）
    expect(getDeviceConfig(dev.id).pins[0].power).not.toBe(false)
    await flush()
    expect(client.sendCmd).not.toHaveBeenCalled()
  })

  test('灯组下拉：onGroupPick 切换 activeGroup 并重建灯珠网格', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          name: '客厅灯带',
          power: false,
          configured: true,
          groups: [
            { name: '流水', ledStart: 0, ledEnd: 3, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] },
            { name: '彩虹', ledStart: 4, ledEnd: 9, steps: [{ duration: 9, transition: 2, loopMode: 2, layers: [{ effect: EFF.BREATH, params: { period: 3000 } }] }] },
          ],
        },
      ],
    })
    const page = load(0)
    page.onGroupPick({ detail: { value: 1 } })
    expect(page.data.activeGroup).toBe(1)
    expect(page.data.groups[1].name).toBe('彩虹')
    // 灯珠网格按新灯组范围重建：[4,9] 共 6 颗。
    expect(litCount(page)).toBe(6)
    // 步骤/图层属于新灯组（呼吸灯效、周期 3000）。
    const layer = page.data.groups[1].steps[0].layers[0]
    expect(layer.effect).toBe(EFF.BREATH)
    expect(fieldOf(layer, 'period').value).toBe(3000)
    // 切换不动 groups VM、不触发同步。
    expect(page.data.syncState).toBe('idle')
    // 越界 index 忽略。
    page.onGroupPick({ detail: { value: 9 } })
    expect(page.data.activeGroup).toBe(1)
  })

  test('重命名灯组：输入即改 name 并落盘（修改即推送）', () => {
    const page = load(0)
    page.onGroupNameInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '彩虹带' } })
    expect(page.data.groups[0].name).toBe('彩虹带')
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).groups[0].name).toBe('彩虹带')
  })

  test('「配置」按钮：打开当前组配置弹窗，关闭后复位', () => {
    const page = load(0)
    expect(page.data.groupConfigOpen).toBe(false)
    page.onGroupPick({ detail: { value: 2 } })
    page.onOpenGroupConfig()
    expect(page.data.groupConfigOpen).toBe(true)
    expect(page.data.activeGroup).toBe(2)
    // 弹窗内灯珠网格内嵌：打开时已按 activeGroup 构建，拖选态复位。
    expect(page.data.ledCells.length).toBe(page.data.ledCount)
    expect(page.data.dragging).toBe(false)
    // 弹窗内改名复用 activeGroup 链路：输入即落盘。
    page.onGroupNameInput({ currentTarget: { dataset: { index: 2 } }, detail: { value: '氛围组' } })
    expect(page.data.groups[2].name).toBe('氛围组')
    page.onCloseGroupConfig()
    expect(page.data.groupConfigOpen).toBe(false)
  })

  test('灯珠拖选：长按 1s 激活→move→end 写回区间 + 落盘 + 蓝框/浅蓝条渲染', () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const page = load(0)
    // 注入网格几何：rect 600x600，10 列派生 100 格 rects（每格 60x60）。
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    // touchstart 在格 2（clientX=150, clientY=30）：仅记录起点，不激活（防误触）。
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] })
    expect(page.data.dragging).toBe(false)
    // 长按 1s 激活（唯一激活路径）。
    jest.advanceTimersByTime(1000)
    expect(page.data.dragging).toBe(true)
    expect(page.data.dragRange).toEqual([2, 2])
    // move 到格 5：区间 [2,5]。
    page.onLedTouchMove({ touches: [{ clientX: 330, clientY: 30 }] })
    expect(page.data.dragRange).toEqual([2, 5])
    const states = page.data.ledCells.map((c) => c.state)
    expect(states[2]).toBe('drag-start')
    expect(states[5]).toBe('drag-end')
    expect(states[3]).toBe('drag-mid')
    expect(states[4]).toBe('drag-mid')
    // 松手：写回 [2,5] + 落盘 + 拖选态清零。
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.dragging).toBe(false)
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(5)
    expect(litCount(page)).toBe(4) // [2,5] 共 4 颗 selected
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).groups[0].ledStart).toBe(2)
    jest.useRealTimers()
  })

  test('灯珠拖选：短触（无移动松手）不触发拖选、不改配置', () => {
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] })
    // 立即松手（无 move、无长按）：dragActive 一直 false，配置不变。
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.dragging).toBe(false)
    expect(page.data.groups[0].ledStart).toBe(0xff) // 仍是空态
    expect(page.data.groups[0].ledEnd).toBe(0xff)
    expect(page.data.syncState).toBe('idle') // 未改配置不触发同步
  })

  test('灯珠拖选：长按 1s 激活（即使没移动）', () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] })
    expect(page.data.dragging).toBe(false) // 长按前不激活
    jest.advanceTimersByTime(999)
    expect(page.data.dragging).toBe(false) // 999ms 仍未激活
    jest.advanceTimersByTime(1) // 满 1s 激活
    expect(page.data.dragging).toBe(true)
    expect(page.data.groups[0].ledStart).toBe(0xff) // 未写回
    page.onLedTouchEnd({ type: 'touchend' })
    jest.useRealTimers()
  })

  test('灯珠拖选：长按后松手（不移动）→ 选中单颗', () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2
    jest.advanceTimersByTime(1000) // 长按激活
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(2) // 单颗
    expect(litCount(page)).toBe(1)
    jest.useRealTimers()
  })

  test('灯珠拖选：未长按（<1s）拖动不触发拖选，松手不改配置', () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] })
    // 500ms 时快速拖到格 5：未达 1s 长按，move 不触发拖选。
    jest.advanceTimersByTime(500)
    page.onLedTouchMove({ touches: [{ clientX: 330, clientY: 30 }] })
    expect(page.data.dragging).toBe(false)
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.groups[0].ledStart).toBe(0xff) // 配置不变
    expect(page.data.groups[0].ledEnd).toBe(0xff)
    jest.useRealTimers()
  })

  test('灯珠拖选：按每格真实 rect 反查（无列数假设，不偏移）', () => {
    const page = load(0)
    // 非对称 rect：格宽 50、高 80，起点 x=100（格 2 中心 225）。
    const rects = []
    for (let i = 0; i < 100; i++) {
      const c = i % 10
      const r = Math.floor(i / 10)
      rects.push({ left: 100 + c * 50, top: r * 80, width: 50, height: 80 })
    }
    wx.__cellRects = rects
    wx.__gridRect = { left: 100, top: 0, width: 500, height: 800 }
    // touchstart 格 2 中心 (225, 40)：仅记录起点（长按激活路径见上方专门用例）。
    page.onLedTouchStart({ touches: [{ clientX: 225, clientY: 40 }] })
    page._longPressTimer && clearTimeout(page._longPressTimer)
    // 直接调内部激活（确定性验证纯几何反查，不依赖计时器）。
    page._activateDrag(225, 40)
    expect(page.data.dragging).toBe(true)
    expect(page.data.dragRange).toEqual([2, 2]) // 精确锚定格 2
    // 拖到格 7 中心 (475, 40)。
    page.onLedTouchMove({ touches: [{ clientX: 475, clientY: 40 }] })
    expect(page.data.dragRange).toEqual([2, 7]) // 精确命中，不偏移
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(7)
  })

  test('灯珠拖选：反向拖 [5→2] 同样区间 [2,5]', () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    wx.getSystemInfoSync = jest.fn(() => ({ windowHeight: 700 }))
    page.onLedTouchStart({ touches: [{ clientX: 330, clientY: 30 }] }) // 格 5
    jest.advanceTimersByTime(1000) // 长按激活
    page.onLedTouchMove({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(5)
    jest.useRealTimers()
  })

  test('灯珠拖选：经过其他组占用格（灰）停止扩展', () => {
    // 灯组 0 选 [0,3]，灯组 1 选 [4,9] 占用 4..9。
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          configured: true,
          name: 'A',
          groups: [
            { name: 'g0', ledStart: 0, ledEnd: 3, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] },
            { name: 'g1', ledStart: 4, ledEnd: 9, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [2, 2, 2], brightness: 20 } }] }] },
          ],
        },
      ],
    })
    const page = load(0) // activeGroup=0
    expect(page.data.ledCells[4].state).toBe('occupied') // 4 是其他组占用
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    // 从格 2 拖向格 5（4..5 被占用）→ 遇占用停止，区间保留 [2,3]。
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2
    jest.advanceTimersByTime(1000) // 长按激活
    page.onLedTouchMove({ touches: [{ clientX: 210, clientY: 30 }] }) // 格 3（可扩）
    page.onLedTouchMove({ touches: [{ clientX: 330, clientY: 30 }] }) // 格 5（占用，停止）
    page.onLedTouchEnd({ type: 'touchend' })
    jest.useRealTimers()
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(3) // 没扩到 5
  })

  test('灯珠拖选：拖入红色取消区松手回滚保留上次选择', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          configured: true,
          name: 'A',
          groups: [
            { name: 'g0', ledStart: 2, ledEnd: 5, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] },
          ],
        },
      ],
    })
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    // 模拟窗口高度 700（覆盖层取消区 = y > 700 - 40 = 660）。
    wx.getSystemInfoSync = jest.fn(() => ({ windowHeight: 700 }))
    const page = load(0) // 上次选中 [2,5]
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2 起
    jest.advanceTimersByTime(1000) // 长按激活
    page.onLedTouchMove({ touches: [{ clientX: 330, clientY: 30 }] }) // 格 5
    // 拖到取消区（clientY=680 > 660）。
    page.onLedTouchMove({ touches: [{ clientX: 300, clientY: 680 }] })
    expect(page.data.inCancelZone).toBe(true)
    page.onLedTouchEnd({ type: 'touchend' })
    // 回滚：保留上次 [2,5]，不落盘、不触发同步。
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(5)
    expect(page.data.syncState).toBe('idle')
    jest.useRealTimers()
  })

  test('灯珠拖选：touchstart 落在占用格不启动拖选', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          configured: true,
          name: 'A',
          groups: [
            { name: 'g0', ledStart: 0, ledEnd: 1, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] },
            { name: 'g1', ledStart: 4, ledEnd: 9, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [2, 2, 2], brightness: 20 } }] }] },
          ],
        },
      ],
    })
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    wx.getSystemInfoSync = jest.fn(() => ({ windowHeight: 700 }))
    // 起点落在格 5（被 g1 占用）→ 长按后不进入 dragging。
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    page.onLedTouchStart({ touches: [{ clientX: 330, clientY: 30 }] })
    jest.advanceTimersByTime(1000)
    expect(page.data.dragging).toBe(false)
    jest.useRealTimers()
  })

  test('清除本组灯珠：onClearLeds 设 255 空哨兵 + 落盘', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          configured: true,
          name: 'A',
          groups: [
            { name: 'g0', ledStart: 2, ledEnd: 5, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] },
          ],
        },
      ],
    })
    const page = load(0)
    expect(litCount(page)).toBe(4)
    page.onClearLeds()
    expect(page.data.groups[0].ledStart).toBe(0xff)
    expect(page.data.groups[0].ledEnd).toBe(0xff)
    expect(litCount(page)).toBe(0)
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).groups[0].ledStart).toBe(0xff)
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

  test('图层：两格固定槽位，空槽可填，填满后拒绝再添加', () => {
    const page = load(0)
    // 默认只有背景槽有图层，动效槽是空占位。
    expect(page.data.groups[0].steps[0].layers).toHaveLength(2)
    expect(page.data.groups[0].steps[0].layers[0].empty).toBe(false)
    expect(page.data.groups[0].steps[0].layers[1].empty).toBe(true)

    page.onAddLayer({ currentTarget: { dataset: { si: 0, slot: 1 } } })
    expect(page.data.groups[0].steps[0].layers[1].empty).toBe(false)
    page.onAddLayer({ currentTarget: { dataset: { si: 0 } } }) // 无空槽 → 拒绝
    expect(page.data.groups[0].steps[0].layers.filter((l) => !l.empty)).toHaveLength(2)
  })

  test('删除图层：清空该槽，另一格原位不动，两格都空则不亮', () => {
    const page = load(0)
    page.onAddLayer({ currentTarget: { dataset: { si: 0, slot: 1 } } })
    const bgLid = page.data.groups[0].steps[0].layers[0].lid

    // 删背景：动效仍在第二格
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 0 } } })
    expect(page.data.groups[0].steps[0].layers[0].empty).toBe(true)
    expect(page.data.groups[0].steps[0].layers[1].empty).toBe(false)
    expect(page.data.groups[0].steps[0].layers[1].role).toBe('动效')
    expect(page.data.stepAxis[0].allEmpty).toBe(false)

    // 再删动效：两格都空 → 提示不亮
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 1 } } })
    expect(page.data.groups[0].steps[0].layers[0].empty).toBe(true)
    expect(page.data.groups[0].steps[0].layers[1].empty).toBe(true)
    expect(page.data.stepAxis[0].allEmpty).toBe(true)
    expect(bgLid).toBeDefined()
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

  test('刻度轴调参数：拖动写回亮度并落盘，圆环进度同步', () => {
    const page = load(0)
    // 点亮度圆环 → 展开该参数的刻度轴。
    page.onToggleGauge({ currentTarget: { dataset: { si: 0, li: 0, name: 'brightness', kind: 'param' } } })
    expect(page.data.gauge).toBeTruthy()
    expect(page.data.gauge.name).toBe('brightness')
    // 拖动到 40% 位置：亮度量程 0~255，拖动值按档量化。
    page._gaugeRect = { left: 0, width: 100 }
    page.onGaugeTouchMove({ touches: [{ clientX: 40 }] })
    const after = page.data.groups[0].steps[0].layers[0]
    const expectVal = Math.round(0.4 * 255)
    expect(fieldOf(after, 'brightness').value).toBe(expectVal)
    // 圆环进度 = 值占量程比例，必须跟着变。
    expect(fieldOf(after, 'brightness').ring).toBe(Math.round((expectVal / 255) * 100))
    // 拖动中不下发，松手才落盘。
    expect(getDeviceConfig(dev.id)).toBeNull()
    page.onGaugeTouchEnd()
    const saved = getDeviceConfig(dev.id)
    const savedLayer = saved.pins.find((p) => p.pin === 0).groups[0].steps[0].layers[0]
    expect(savedLayer.params.brightness).toBe(expectVal)
  })

  // 竖向时间轴：所有阶段同屏可编辑，不再有"选中阶段"这层视图态。
  test('竖向时间轴：每个阶段各自独立编辑，互不影响', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          configured: true,
          name: 'A',
          groups: [
            {
              name: 'g0',
              ledStart: 0,
              ledEnd: 3,
              steps: [
                { duration: 5, transition: 0, loopMode: 1, layers: [
                  { effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } },
                  { effect: EFF.BREATH, params: { period: 3000 } },
                ] },
                { duration: 6, transition: 1, loopMode: 2, layers: [{ effect: EFF.BLINK, params: {} }] },
              ],
            },
          ],
        },
      ],
    })
    const page = load(0)
    expect(page.data.activeStepSi).toBeUndefined() // 选中态已随阶段条移除
    // 两个阶段同时在时间轴上：改第 2 段名称不影响第 1 段。
    page.onStageNameInput({ currentTarget: { dataset: { si: 1 } }, detail: { value: '收尾' } })
    expect(page.data.groups[0].steps[1].name).toBe('收尾')
    expect(page.data.groups[0].steps[1].duration).toBe(6)
    expect(page.data.groups[0].steps[0].name).toBe('阶段一')
    // 改名即落盘下发（未连接 → local），与其余输入框同口径。
    expect(page.data.syncState).toBe('local')
  })

  test('图层卡片摘要：rgb 参数出色块，亮度/速度拼摘要文案', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        {
          pin: 0,
          configured: true,
          name: 'A',
          groups: [
            {
              name: 'g0',
              ledStart: 0,
              ledEnd: 3,
              steps: [
                { duration: 5, transition: 0, loopMode: 1, layers: [
                  { effect: EFF.SOLID, params: { color: [255, 136, 0], brightness: 200 } },
                  { effect: EFF.RAINBOW, params: { brightness: 128, speed: 40 } },
                ] },
              ],
            },
          ],
        },
      ],
    })
    const page = load(0)
    const [l0, l1] = page.data.groups[0].steps[0].layers
    // 常亮：有 color → 色块 + 亮度摘要（常亮无 speed/spread，只有一项）。
    expect(l0.swatch).toBe('#ff8800')
    expect(l0.summary).toBe('亮度 200')
    // 彩虹渐变：无 rgb 参数 → 无色块 + 亮度/速度/扩散三项摘要。
    expect(l1.swatch).toBeNull()
    expect(l1.summary).toBe('亮度 128 · 速度 40 · 扩散 1')
  })

  test('点圆环展开刻度轴：再点同一圆环收起，点别的圆环直接换过去', () => {
    const page = load(0)
    expect(page.data.gauge).toBeNull()
    const ds = { si: 0, li: 0, name: 'brightness', kind: 'param' }
    page.onToggleGauge({ currentTarget: { dataset: ds } })
    expect(page.data.gauge.name).toBe('brightness')
    expect(page.data.gauge.kind).toBe('param')
    // 同一圆环再点 → 收起。
    page.onToggleGauge({ currentTarget: { dataset: ds } })
    expect(page.data.gauge).toBeNull()
    // 换一个参数 → 直接切过去（不留上一个）。
    page.onToggleGauge({ currentTarget: { dataset: ds } })
    page.onToggleGauge({ currentTarget: { dataset: { si: 0, li: 0, name: 'color', kind: 'param' } } })
    // color 是 rgb，没有量程 → 不开刻度轴（走颜色弹层）。
    expect(page.data.gauge.name).toBe('brightness')
  })

  test('点左轴圆点展开时长刻度轴；拖轴改时长，圆点秒数与起始时刻同步', () => {
    const page = load(0)
    page.onAddStep()
    page.onToggleGauge({ currentTarget: { dataset: { si: 0, kind: 'duration' } } })
    expect(page.data.gauge.kind).toBe('duration')
    expect(page.data.gauge.label).toBe('时长')
    expect(page.data.gauge.value).toBe(5)
    // 拖到量程 60% 附近 → 时长按 1s 量化（量程 1~60）。
    page._gaugeRect = { left: 0, width: 100 }
    page.onGaugeTouchMove({ touches: [{ clientX: 60 }] })
    const dur = page.data.groups[0].steps[0].duration
    expect(dur).toBe(Math.round(1 + 0.6 * 59))
    // 第二段起始时刻随首段时长后移。
    expect(page.data.stepAxis[1].startAt).toBe(dur)
    page.onGaugeTouchEnd()
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).groups[0].steps[0].duration).toBe(dur)
  })

  test('刻度轴枚举档：拖动换档位，值按档还原', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [{
        pin: 0,
        configured: true,
        name: 'A',
        groups: [{
          name: 'g0',
          ledStart: 0,
          ledEnd: 3,
          steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.BREATH, params: {} }] }],
        }],
      }],
    })
    const page = load(0)
    page.onToggleGauge({ currentTarget: { dataset: { si: 0, li: 0, name: 'waveform', kind: 'param' } } })
    expect(page.data.gauge.options).toEqual(['正弦', '方波'])
    page._gaugeRect = { left: 0, width: 100 }
    page.onGaugeTouchMove({ touches: [{ clientX: 100 }] })
    // 方波 = min(0) + 档位 1。
    expect(fieldOf(page.data.groups[0].steps[0].layers[0], 'waveform').value).toBe(1)
    expect(page.data.gauge.valueText).toBe('方波')
  })

  test('点色盘圆点：开颜色弹层，选色后图层色块同步', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onOpenColorPicker({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } } })
    expect(page.data.colorPickerOpen).toBe(true)
    page.onColorSelected({ currentTarget: { dataset: { hex: '#12AB34' } }, detail: { value: '#12AB34' } })
    expect(page.data.groups[0].steps[0].layers[0].swatch).toBe('#12ab34')
  })

  test('点灯效名：弹系统选择器换灯效，圆环组跟着换 schema', () => {
    const page = load(0)
    // showActionSheet 由 wx mock 触发 success；这里直接验证换灯效后的圆环重建。
    page.onEffectChange({ currentTarget: { dataset: { si: 0, li: 0 } }, detail: { value: 4 } })
    const layer = page.data.groups[0].steps[0].layers[0]
    expect(layer.effectName).toBe('彩虹渐变')
    expect(layer.swatch).toBeNull()
    // 彩虹没有 rgb 参数 → 全是进度环（ring 非 null），且亮度/速度都在。
    expect(layer.fields.every((f) => f.ring !== null)).toBe(true)
    expect(layer.fields.map((f) => f.name)).toContain('brightness')
  })

  test('删除图层：抬起对应槽，另一格不受影响，并收起刻度轴', () => {
    const page = load(0)
    page.onAddLayer({ currentTarget: { dataset: { si: 0, slot: 1 } } })
    page.onToggleGauge({ currentTarget: { dataset: { si: 0, li: 1, name: 'brightness', kind: 'param' } } })
    expect(page.data.gauge).not.toBeNull()
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 1 } } })
    expect(page.data.groups[0].steps[0].layers[1].empty).toBe(true)
    expect(page.data.groups[0].steps[0].layers[0].empty).toBe(false)
    expect(page.data.gauge).toBeNull()
  })

  test('切换灯组/移动/删除阶段时收起刻度轴（避免定位到已不存在的量）', () => {
    const page = load(0)
    page.onAddStep()
    page.onToggleGauge({ currentTarget: { dataset: { si: 1, kind: 'duration' } } })
    page.onMoveStep({ currentTarget: { dataset: { si: 1, dir: -1 } } })
    expect(page.data.gauge).toBeNull()

    page.onToggleGauge({ currentTarget: { dataset: { si: 0, kind: 'duration' } } })
    page.onDeleteStep({ currentTarget: { dataset: { si: 1 } } })
    expect(page.data.gauge).toBeNull()

    page.onToggleGauge({ currentTarget: { dataset: { si: 0, kind: 'duration' } } })
    page.onGroupPick({ detail: { value: 1 } })
    expect(page.data.gauge).toBeNull()
  })

  test('新增阶段追加到末尾并标记进入动画；删除按卡头下标删对应段', () => {
    const page = load(0)
    page.onAddStep()
    page.onAddStep()
    expect(page.data.groups[0].steps).toHaveLength(3)
    expect(page.data.enterIndex).toBe(2) // 新卡片播一次淡入
    expect(page.data.groups[0].steps[2].name).toBe('阶段三')
    page.onDeleteStep({ currentTarget: { dataset: { si: 0 } } })
    expect(page.data.groups[0].steps).toHaveLength(2)
    expect(page.data.groups[0].steps[0].name).toBe('阶段二') // 列表顺序即播放顺序
  })

  test('↑↓ 调整阶段先后：越界不动，交换后起始时刻与连序重算', () => {
    const page = load(0)
    page.onAddStep()
    page.onAddStep()
    page.onStageNameInput({ currentTarget: { dataset: { si: 0 } }, detail: { value: '甲' } })
    page.onStageNameInput({ currentTarget: { dataset: { si: 1 } }, detail: { value: '乙' } })
    page.onStageNameInput({ currentTarget: { dataset: { si: 2 } }, detail: { value: '丙' } })
    setDuration(page, 0, 3)
    setDuration(page, 1, 4)

    // 首段上移 / 末段下移：越界忽略。
    page.onMoveStep({ currentTarget: { dataset: { si: 0, dir: -1 } } })
    page.onMoveStep({ currentTarget: { dataset: { si: 2, dir: 1 } } })
    expect(page.data.groups[0].steps.map((st) => st.name)).toEqual(['甲', '乙', '丙'])

    // 末段上移一位：丙插到乙前面。
    page.onMoveStep({ currentTarget: { dataset: { si: 2, dir: -1 } } })
    expect(page.data.groups[0].steps.map((st) => st.name)).toEqual(['甲', '丙', '乙'])
    // 起始时刻按新顺序累加：甲 0s，丙 3s，乙 3+5=8s。
    expect(page.data.stepAxis.map((a) => a.startAt)).toEqual([0, 3, 8])
    // 3 + 5 + 4 = 12s。
    expect(page.data.stepsTotal).toBe(12)
  })

  test('时间轴左轴：节点色取该段首个灯效主题色，两格都空则灰且标记 allEmpty', () => {
    const page = load(0)
    // 默认常亮 → SOLID 主题色。
    expect(page.data.stepAxis[0].color).toBe(effectColor(EFF.SOLID))
    expect(page.data.stepAxis[0].allEmpty).toBe(false)
    // 两格删空 → 退灰 + allEmpty。
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 0 } } })
    expect(page.data.stepAxis[0].allEmpty).toBe(true)
    expect(page.data.stepAxis[0].color).toBe('') // 空串 → WXML 不下发内联色，走 CSS 灰环
  })

  // 颜色弹层（#33）。
  test('onOpenColorPicker：打开弹层并带入目标 field 与最近色', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onOpenColorPicker({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } } })
    expect(page.data.colorPickerOpen).toBe(true)
    expect(page._colorPickerTarget).toEqual({ si: 0, li: 0, fi: colorFi })
    expect(Array.isArray(page.data.recentColors)).toBe(true)
  })

  test('onColorSelected：hex → rgb 写入 field + 持久化最近色 + 关闭弹层', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onOpenColorPicker({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } } })
    page.onColorSelected({ currentTarget: { dataset: { hex: '#FF8800' } } })
    expect(page.data.colorPickerOpen).toBe(false)
    expect(page._colorPickerTarget).toBeNull()
    const after = page.data.groups[0].steps[0].layers[0]
    expect(fieldOf(after, 'color').value).toEqual([255, 136, 0])
    expect(fieldOf(after, 'color').hex).toBe('#ff8800')
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).groups[0].steps[0].layers[0].params.color).toEqual([255, 136, 0])
    expect(getRecentColors()[0]).toBe('#FF8800')
  })

  test('onCloseColorPicker：关闭弹层但不写回、不持久化', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onOpenColorPicker({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } } })
    page.onCloseColorPicker()
    expect(page.data.colorPickerOpen).toBe(false)
    expect(page._colorPickerTarget).toBeNull()
    expect(page.data.groups[0].steps[0].layers[0].fields.find((f) => f.name === 'color').value).toEqual([255, 255, 255])
    expect(getRecentColors()).toEqual([])
    expect(page.data.syncState).toBe('idle')
  })

  // 最近使用色（#30）：选色写入 Storage + 重进页面回填。
  test('onColorPicked：hex 选中写入 field.value 并持久化最近色', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onColorSelected({
      currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } },
      detail: { value: '#FF8800' },
    })
    const after = page.data.groups[0].steps[0].layers[0]
    expect(fieldOf(after, 'color').value).toEqual([255, 136, 0])
    // Storage 落盘：配置与最近色均已写入。
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).groups[0].steps[0].layers[0].params.color).toEqual([255, 136, 0])
    expect(getRecentColors()[0]).toBe('#FF8800')
  })

  test('最近色去重倒序：重复选色移除后前插', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onColorSelected({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#FF0000' } })
    page.onColorSelected({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#00FF00' } })
    page.onColorSelected({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#FF0000' } })
    expect(getRecentColors()).toEqual(['#FF0000', '#00FF00'])
  })

  test('最近色跨会话回填：重进页面后 getRecentColors 可读回', () => {
    const colorFi = load(0).data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    load(0).onColorSelected({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#123456' } })
    // 重新装载页面（模拟重进）：最近色仍在。
    resetDeviceStore()
    const page2 = load(0)
    expect(page2).toBeTruthy()
    expect(getRecentColors()).toEqual(['#123456'])
  })

  test('最近色损坏 Storage：安全降级为空数组', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    // 注入损坏数据后选色，应不抛异常且写为单元素数组。
    wx.setStorageSync('bt_recent_colors', 'not-json{')
    page.onColorSelected({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#ABCDEF' } })
    expect(getRecentColors()).toEqual(['#ABCDEF'])
  })

  test('最近色损坏 Storage：纯读取降级为空数组（不 push）', () => {
    wx.setStorageSync('bt_recent_colors', 'not-json{')
    expect(getRecentColors()).toEqual([])
    wx.setStorageSync('bt_recent_colors', '{"a":1}') // 非数组
    expect(getRecentColors()).toEqual([])
    wx.setStorageSync('bt_recent_colors', '') // 空
    expect(getRecentColors()).toEqual([])
  })

  test('最近色去重大小写不敏感：#ff0000 与 #FF0000 合并', () => {
    // 模拟旧数据/他源写入小写 hex。
    wx.setStorageSync('bt_recent_colors', JSON.stringify(['#ff0000', '#00ff00']))
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    // 选大写 #FF0000：应与旧小写 #ff0000 合并，不并存。
    page.onColorSelected({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#FF0000' } })
    const colors = getRecentColors()
    expect(colors.filter((c) => c.toUpperCase() === '#FF0000')).toHaveLength(1)
    // 归一为大写 + #。
    expect(colors[0]).toBe('#FF0000')
    expect(colors).toEqual(['#FF0000', '#00FF00'])
  })

  test('最近色截断到上限 10：push 11 个不同色后保留最新 10', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    for (let i = 0; i < 12; i++) {
      const hex = '#' + i.toString(16).padStart(2, '0').toUpperCase().repeat(3)
      page.onColorSelected({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: hex } })
    }
    const colors = getRecentColors()
    expect(colors).toHaveLength(10)
    // 第一个是最末 push 的（#0B0B0B），不含最早的 #00..。
    expect(colors[0]).toBe('#0B0B0B')
    expect(colors.find((c) => c === '#000000')).toBeUndefined()
  })

  // ---- 色轮选色（角度=色相、半径=饱和度；亮度归图层的 brightness 参数） -----

  // 色轮 rect：200×200，圆心 (100,100)，半径 100。
  const WHEEL_RECT = { left: 0, top: 0, width: 200, height: 200 }

  function openPicker(page) {
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onOpenColorPicker({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } } })
  }

  function touchWheel(page, clientX, clientY) {
    page.onPickerTouchStart({ touches: [{ clientX, clientY }] })
  }

  test('onOpenColorPicker：色相/饱和度初值取目标 field 当前颜色', () => {
    const page = load(0)
    // 默认色为白 [255,255,255] → h0 s0。
    openPicker(page)
    expect(page.data.pickerHueSat).toEqual({ h: 0, s: 0 })
    expect(page.data.pickerHex).toBe('#FFFFFF')
    // s=0 → 色轮圆点落在正中央。
    expect(page.data.pickerUi.dotX).toBe('50%')
    expect(page.data.pickerUi.dotY).toBe('50%')
  })

  test('拖色轮：角度 → 色相、半径 → 饱和度，松手才写回 field', () => {
    const page = load(0)
    openPicker(page)
    wx.__gridRect = WHEEL_RECT
    // 正右方满半径：角度 0 → h0，半径 100% → s100 → 纯红。
    touchWheel(page, 200, 100)
    expect(page.data.pickerHueSat).toEqual({ h: 0, s: 100 })
    expect(page.data.pickerHex).toBe('#FF0000')
    // 拖动中未松手：field 未写回（仍是默认白）。
    expect(fieldOf(page.data.groups[0].steps[0].layers[0], 'color').value).toEqual([255, 255, 255])
    page.onPickerTouchEnd()
    expect(fieldOf(page.data.groups[0].steps[0].layers[0], 'color').value).toEqual([255, 0, 0])
    expect(getRecentColors()[0]).toBe('#FF0000')
  })

  test('拖色轮：正上方为 270°（蓝紫），圆点落在圆周', () => {
    const page = load(0)
    openPicker(page)
    wx.__gridRect = WHEEL_RECT
    // 正上方（dy=-100, dx=0）→ atan2(-100,0) = -90 → 归一 270。
    touchWheel(page, 100, 0)
    expect(page.data.pickerHueSat).toEqual({ h: 270, s: 100 })
    expect(page.data.pickerHex).toBe('#8000FF')
    expect(page.data.pickerUi.dotX).toBe('50%')
    expect(page.data.pickerUi.dotY).toBe('0%')
    page.onPickerTouchEnd()
  })

  test('拖色轮：半径一半 → 饱和度 50%，颜色随之变浅', () => {
    const page = load(0)
    openPicker(page)
    wx.__gridRect = WHEEL_RECT
    // 正右方半半径（圆心右侧 50px）→ h0 s50 → #FF8080。
    touchWheel(page, 150, 100)
    expect(page.data.pickerHueSat).toEqual({ h: 0, s: 50 })
    expect(page.data.pickerHex).toBe('#FF8080')
    expect(page.data.pickerUi.dotX).toBe('75%')
    expect(page.data.pickerUi.dotY).toBe('50%')
    page.onPickerTouchEnd()
  })

  test('拖色轮：触圆心 → 饱和度 0 且保持原色相（不突跳到红）', () => {
    const page = load(0)
    openPicker(page)
    wx.__gridRect = WHEEL_RECT
    // 正下方满半径 → h90（黄绿），再拖回圆心。
    touchWheel(page, 100, 200)
    expect(page.data.pickerHueSat.h).toBe(90)
    page.onPickerTouchEnd()
    touchWheel(page, 100, 100)
    expect(page.data.pickerHueSat).toEqual({ h: 90, s: 0 })
    expect(page.data.pickerHex).toBe('#FFFFFF')
    page.onPickerTouchEnd()
  })

  test('拖色轮：越界触摸点饱和度钳制 100%，拖动中不抛异常', () => {
    const page = load(0)
    wx.__gridRect = WHEEL_RECT
    touchWheel(page, 9999, 100)
    expect(page.data.pickerHueSat.s).toBe(100)
    expect(page.data.pickerHueSat.h).toBe(0) // 正右方向仍是 0°
    expect(() => page.onPickerTouchMove({ touches: [{ clientX: 9999, clientY: 9999 }] })).not.toThrow()
  })

  test('h/s 以个位数为最小单位：拖动 → 四舍五入取整', () => {
    const page = load(0)
    wx.__gridRect = WHEEL_RECT
    // 角度 45.5°、半径 74.5% 的落点。
    const rad = (45.5 * Math.PI) / 180
    touchWheel(page, 100 + Math.cos(rad) * 74.5, 100 + Math.sin(rad) * 74.5)
    expect(page.data.pickerHueSat.h).toBe(46)
    expect(page.data.pickerHueSat.s).toBe(75)
    expect(page.data.pickerHueSat.h % 1).toBe(0)
    expect(page.data.pickerHueSat.s % 1).toBe(0)
  })

  test('色轮只产出色相/饱和度：选中色按满亮度写入（不与 brightness 参数重复压暗）', () => {
    const page = load(0)
    openPicker(page)
    wx.__gridRect = WHEEL_RECT
    // 半半径 → s50，写入的 rgb 必须是 v=100 的纯色阶（[255,128,128]），不是暗红。
    touchWheel(page, 150, 100)
    page.onPickerTouchEnd()
    expect(fieldOf(page.data.groups[0].steps[0].layers[0], 'color').value).toEqual([255, 128, 128])
    // 弹层不再有亮度维度。
    expect(page.data.pickerHueSat.v).toBeUndefined()
    expect(page.data.pickerUi.valPos).toBeUndefined()
    expect(page.data.pickerUi.dimOpacity).toBeUndefined()
  })

  test('rect 未就绪时拖动忽略（查询未回不崩）', () => {
    const page = load(0)
    openPicker(page)
    wx.__gridRect = null
    touchWheel(page, 180, 100)
    // 弹层初值未被改写。
    expect(page.data.pickerHueSat).toEqual({ h: 0, s: 0 })
    expect(page.data.pickerHex).toBe('#FFFFFF')
    // move/end 仍安全返回。
    expect(() => page.onPickerTouchMove({ touches: [{ clientX: 0 }] })).not.toThrow()
    expect(() => page.onPickerTouchEnd()).not.toThrow()
  })

  // ---- 修改即推送（autoSync）：防抖合并 / 未连接落盘 / 连接后补发 ------------

  test('自动推送：已连接 → 防抖 500ms 后先 WRITE_CONFIG 后 APPLY，blob 可解码', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    page.onPinNameInput({ detail: { value: '新名' } })
    expect(client.sendCmd).not.toHaveBeenCalled() // 防抖窗口内未下发
    jest.advanceTimersByTime(500)
    await flush()

    expect(client.sendCmd).toHaveBeenCalledTimes(2)
    const [cmd1, blob] = client.sendCmd.mock.calls[0]
    const [cmd2] = client.sendCmd.mock.calls[1]
    expect(cmd1).toBe(CMD.WRITE_CONFIG)
    expect(cmd2).toBe(CMD.APPLY)
    const decoded = decodeConfigBlob(Uint8Array.from(blob))
    expect(decoded.pins.find((p) => p.pin === 0).groups).toHaveLength(5)
    expect(page.data.syncState).toBe('synced')
    jest.useRealTimers()
  })

  test('自动推送：防抖合并——连续改动只下发一次最新快照', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    // 连续三次参数改动（亮度 10 → 20 → 30），每次间隔 200ms < 防抖窗口。
    // 刻度轴拖动期间 silent，松手各落一次盘——三次都落在同一个防抖窗口内。
    page.onToggleGauge({ currentTarget: { dataset: { si: 0, li: 0, name: 'brightness', kind: 'param' } } })
    page._gaugeRect = { left: 0, width: 255 }
    for (const v of [10, 20, 30]) {
      page.onGaugeTouchMove({ touches: [{ clientX: v }] })
      page.onGaugeTouchEnd()
      jest.advanceTimersByTime(200)
    }
    jest.advanceTimersByTime(500)
    await flush()

    expect(client.sendCmd).toHaveBeenCalledTimes(2) // 仅一次 WRITE_CONFIG + APPLY
    const [, blob] = client.sendCmd.mock.calls[0]
    const decoded = decodeConfigBlob(Uint8Array.from(blob))
    // blob 为最新快照：亮度 30（最后一次改动生效）。
    const layer = decoded.pins.find((p) => p.pin === 0).groups[0].steps[0].layers[0]
    expect(layer.params.brightness).toBe(30)
    jest.useRealTimers()
  })

  test('自动推送：未连接 → 落盘 + 状态 local，不下发；连接后补发一次', async () => {
    const client = fakeClient(false)
    setCurrentBleClient(client)
    const page = load(0)
    page.onPinNameInput({ detail: { value: '新名' } })
    // Storage 真相源已写入。
    const saved = getDeviceConfig(dev.id)
    expect(saved.pins.find((p) => p.pin === 0).name).toBe('新名')
    expect(page.data.syncState).toBe('local')
    expect(client.sendCmd).not.toHaveBeenCalled()

    // 连接建立 → 补发（autoSync.onConnected 经 client 状态翻转触发）。
    // 补发走 500ms 防抖（避开 connect 内 GET_VERSION 交错）。
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    client.connected = true
    autoSync.onConnected()
    jest.advanceTimersByTime(500)
    await flush()
    jest.useRealTimers()
    expect(client.sendCmd).toHaveBeenCalledTimes(2)
    expect(page.data.syncState).toBe('synced')
  })

  // 固定双槽（ADR-0033）：删掉背景后动效仍在第二格，重进页面槽位不丢；
  // 两格都空时下发单层全黑（固件渲染全黑 = 灯珠不亮）。
  test('删除图层：槽位随配置保存，重进页面动效仍在第二格', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    page.onAddLayer({ currentTarget: { dataset: { si: 0, slot: 1 } } })
    // 动效槽换成彩虹，便于区分是哪一层。
    page.onEffectChange({ currentTarget: { dataset: { si: 0, li: 1 } }, detail: { value: 4 } })
    // 删掉背景槽。
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 0 } } })
    jest.advanceTimersByTime(500)
    await flush()

    const saved = getDeviceConfig(dev.id).pins.find((p) => p.pin === 0)
    const savedLayers = saved.groups[0].steps[0].layers
    expect(savedLayers).toHaveLength(1)
    expect(savedLayers[0].slot).toBe(1)
    expect(savedLayers[0].effect).toBe(EFF.RAINBOW)

    // 重进页面：动效仍在第二格，第一格是空槽。
    const rePage = load(0)
    const layers = rePage.data.groups[0].steps[0].layers
    expect(layers[0].empty).toBe(true)
    expect(layers[1].empty).toBe(false)
    expect(layers[1].effect).toBe(EFF.RAINBOW)
    jest.useRealTimers()
  })

  test('删除图层：两格都空时下发单层全黑', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    page.setData({ 'groups[0].ledStart': 0, 'groups[0].ledEnd': 3 })
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 0 } } })
    jest.advanceTimersByTime(500)
    await flush()

    const [, blob] = client.sendCmd.mock.calls[0]
    const wireLayers = decodeConfigBlob(Uint8Array.from(blob))
      .pins.find((p) => p.pin === 0).groups[0].steps[0].layers
    expect(wireLayers).toHaveLength(1)
    expect(wireLayers[0].params.color).toEqual([0, 0, 0])
    expect(wireLayers[0].params.brightness).toBe(0)
    jest.useRealTimers()
  })

  test('点空槽：就地新建该槽图层', () => {
    const page = load(0)
    expect(page.data.groups[0].steps[0].layers[1].empty).toBe(true)
    page.onLayerCardTap({ currentTarget: { dataset: { si: 0, li: 1 } } })
    expect(page.data.groups[0].steps[0].layers[1].empty).toBe(false)
    expect(page.data.groups[0].steps[0].layers[1].role).toBe('动效')
  })

  test('时间轴左轴：两格都删空 → 节点标记 allEmpty 且退灰', () => {
    const page = load(0)
    page.onDeleteLayer({ currentTarget: { dataset: { si: 0, li: 0 } } })
    expect(page.data.groups[0].steps[0].layers.every((l) => l.empty)).toBe(true)
    expect(page.data.stepAxis[0].allEmpty).toBe(true)
    expect(page.data.stepAxis[0].color).toBe('')
  })

  test('自动推送：校验失败（终点 < 起点）静默跳过，不写 Storage、不下发', async () => {
    const client = fakeClient(true)
    setCurrentBleClient(client)
    const page = load(0)
    page.setData({ 'groups[0].ledStart': 5, 'groups[0].ledEnd': 0 })
    page.onGroupNameInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: 'x' } })
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    jest.advanceTimersByTime(500)
    await flush()
    expect(client.sendCmd).not.toHaveBeenCalled()
    expect(getDeviceConfig(dev.id)).toBeNull() // 未写
    jest.useRealTimers()
  })

  test('自动推送：保留其他引脚配置', () => {
    saveDeviceConfig(dev.id, {
      version: 1,
      pins: [
        { pin: 0, configured: true, name: 'A', groups: [{ name: 'g', ledStart: 0, ledEnd: 3, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: 10 } }] }] }] },
        { pin: 3, configured: true, name: 'B', groups: [{ name: 'h', ledStart: 0, ledEnd: 4, steps: [{ duration: 5, transition: 0, loopMode: 1, layers: [{ effect: EFF.SOLID, params: { color: [2, 2, 2], brightness: 20 } }] }] }] },
      ],
    })
    const page = load(0)
    page.onPinNameInput({ detail: { value: '新名' } })
    const pins = getDeviceConfig(dev.id).pins
    expect(pins.map((p) => p.pin)).toEqual([0, 3]) // pin 3 原样保留
  })

  test('自动推送：下发失败静默重试 2 次后置 failed，点状态条重试立即重发', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const client = fakeClient(true)
    client.sendCmd = jest.fn(() => Promise.reject(new Error('timeout')))
    setCurrentBleClient(client)
    const page = load(0)
    page.onPinNameInput({ detail: { value: '新名' } })
    jest.advanceTimersByTime(500)
    await flush()
    expect(page.data.syncState).toBe('syncing') // 第 1 次失败，等待 1s 重试
    jest.advanceTimersByTime(1000)
    await flush()
    jest.advanceTimersByTime(2000)
    await flush()
    expect(page.data.syncState).toBe('failed') // 重试用尽
    // WRITE_CONFIG 首次即失败：每次尝试只调 1 次 sendCmd，3 次尝试 = 3 次调用。
    expect(client.sendCmd).toHaveBeenCalledTimes(3)

    // 点状态条重试：立即再发一轮。
    client.sendCmd = jest.fn(() => Promise.resolve())
    page.onSyncRetry()
    await flush()
    expect(client.sendCmd).toHaveBeenCalledTimes(2)
    expect(page.data.syncState).toBe('synced')
    jest.useRealTimers()
  })

  test('离开拦截：仅同步在途（syncing）时开启，local 不拦截', () => {
    const page = load(0)
    expect(wx.disableAlertBeforeUnload).toHaveBeenCalled() // onLoad 时 clean
    page.onPinNameInput({ detail: { value: '新名' } }) // 未连接 → local，不拦截
    expect(wx.enableAlertBeforeUnload).not.toHaveBeenCalled()
    expect(page.data.syncState).toBe('local')
  })

  // ---- 引脚固定 8 个：无删除入口 ----------------------------------------------

  test('引脚固定 8 个：详情页无删除引脚入口（onDeletePin 不存在）', () => {
    const page = load(0)
    expect(page.onDeletePin).toBeUndefined()
    expect(page.data.configured).toBeUndefined()
  })

  // ---- 图表（时间轴左轴 / 渐变色带 / 波形） -----------------------------------

  test('时间轴左轴：加载后只有一段，起始 0s、总时长 = 该段时长', () => {
    const page = load(0)
    // 默认 1 阶段 5s。
    expect(page.data.stepAxis).toHaveLength(1)
    expect(page.data.stepAxis[0].startAt).toBe(0)
    expect(page.data.stepsTotal).toBe(5)
  })

  test('时间轴左轴：新增阶段与改时长后起始时刻/总时长重算', () => {
    const page = load(0)
    page.onAddStep() // 阶段一 5s + 阶段二 5s
    expect(page.data.stepAxis.map((a) => a.startAt)).toEqual([0, 5])
    expect(page.data.stepsTotal).toBe(10)
    // 阶段二改成 15s → 起点不动，总时长 20s。
    setDuration(page, 1, 15)
    expect(page.data.stepAxis.map((a) => a.startAt)).toEqual([0, 5])
    expect(page.data.stepsTotal).toBe(20)
    // 首段改成 2s → 第二段起点随之前移。
    setDuration(page, 0, 2)
    expect(page.data.stepAxis.map((a) => a.startAt)).toEqual([0, 2])
    expect(page.data.stepsTotal).toBe(17)
  })

  test('时间轴左轴：切换灯组后按新组的阶段重建', () => {
    const page = load(0)
    page.onAddStep() // 组 0 变 2 阶段
    expect(page.data.stepAxis).toHaveLength(2)
    page.onGroupPick({ detail: { value: 1 } }) // 组 1 仍是默认 1 阶段
    expect(page.data.stepAxis).toHaveLength(1)
    expect(page.data.stepsTotal).toBe(5)
  })

  test('渐变色带：彩虹有渐变、常亮无', () => {
    const page = load(0)
    const solid = page.data.groups[0].steps[0].layers[0]
    expect(solid.gradientCss).toBeNull()
    page.onEffectChange({ currentTarget: { dataset: { si: 0, li: 0 } }, detail: { value: 4 } }) // 彩虹
    expect(page.data.groups[0].steps[0].layers[0].gradientCss).toContain('linear-gradient')
  })

})
