// Jest 单测：miniprogram/pages/pin-detail/pin-detail.js（#27 / T7）。
//
// 用 pageHarness 装载页面（同 home.test.js），fake bleClient 断言保存链路
// 的命令顺序与参数（SPEC seam 3：BLE 命令边界 Jest + wx mock 覆盖调用顺序与参数）。

'use strict'

const { loadPage, makeApp } = require('./pageHarness')
const { createWxMock } = require('./wx-mock')
const { flush } = require('./bleTestUtils')
const { saveDevice, saveDeviceConfig, getDeviceConfig, resetDeviceStore } = require('../utils/deviceStore')
const { getRecentColors, resetRecentColors } = require('../utils/recentColors')
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
    expect(page.data.dirty).toBe(false)
  })

  test('无配置：默认 5 灯组 / 1 步骤 / 1 图层 / 常亮', () => {
    const page = load(0)
    expect(page.data.pinName).toBe('引脚 1')
    expect(page.data.groups).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(page.data.groups[i].name).toBe(`灯组 ${i + 1}`)
      expect(page.data.groups[i].steps).toHaveLength(1)
      expect(page.data.groups[i].steps[0].layers).toHaveLength(1)
      expect(page.data.groups[i].steps[0].layers[0].effect).toBe(EFF.SOLID)
      // 默认空态：255 哨兵（未选灯珠）。
      expect(page.data.groups[i].ledStart).toBe(0xff)
      expect(page.data.groups[i].ledEnd).toBe(0xff)
    }
    expect(page.data.activeGroup).toBe(0)
    expect(litCount(page)).toBe(0) // 默认全空
    expect(page.data.dirty).toBe(false)
  })

  test('灯组 Tab：onTapGroup 切换 activeGroup 并重建灯珠网格', () => {
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
    page.onTapGroup({ currentTarget: { dataset: { index: 1 } } })
    expect(page.data.activeGroup).toBe(1)
    expect(page.data.groups[1].name).toBe('彩虹')
    // 灯珠网格按新灯组范围重建：[4,9] 共 6 颗。
    expect(litCount(page)).toBe(6)
    // 步骤/图层属于新灯组（呼吸灯效、周期 3000）。
    const layer = page.data.groups[1].steps[0].layers[0]
    expect(layer.effect).toBe(EFF.BREATH)
    expect(fieldOf(layer, 'period').value).toBe(3000)
    // 切换不动 groups VM、不置 dirty。
    expect(page.data.dirty).toBe(false)
    // 越界 index 忽略。
    page.onTapGroup({ currentTarget: { dataset: { index: 9 } } })
    expect(page.data.activeGroup).toBe(1)
  })

  test('重命名灯组：输入即改 name 并置 dirty', () => {
    const page = load(0)
    page.onGroupNameInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '彩虹带' } })
    expect(page.data.groups[0].name).toBe('彩虹带')
    expect(page.data.dirty).toBe(true)
  })

  test('灯珠拖选：touchstart→move→end 写回区间 + 置 dirty + 蓝框/浅蓝条渲染', () => {
    const page = load(0)
    // 注入网格几何：rect 600x600，10 列派生 100 格 rects（每格 60x60）。
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    // touchstart 在格 2（clientX=150, clientY=30）：仅记录起点，不激活（防误触）。
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] })
    expect(page.data.dragging).toBe(false)
    // move 到格 5（dx=180 > 8px 阈值）：激活并更新区间 [2,5]。
    page.onLedTouchMove({ touches: [{ clientX: 330, clientY: 30 }] })
    expect(page.data.dragging).toBe(true)
    expect(page.data.dragRange).toEqual([2, 5])
    const states = page.data.ledCells.map((c) => c.state)
    expect(states[2]).toBe('drag-start')
    expect(states[5]).toBe('drag-end')
    expect(states[3]).toBe('drag-mid')
    expect(states[4]).toBe('drag-mid')
    // 松手：写回 [2,5] + 置 dirty + 拖选态清零。
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.dragging).toBe(false)
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(5)
    expect(litCount(page)).toBe(4) // [2,5] 共 4 颗 selected
    expect(page.data.dirty).toBe(true)
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
    expect(page.data.dirty).toBe(false)
  })

  test('灯珠拖选：长按 300ms 激活（即使没移动）', () => {
    jest.useFakeTimers()
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] })
    expect(page.data.dragging).toBe(false) // 长按前不激活
    jest.advanceTimersByTime(300) // 长按计时器触发
    expect(page.data.dragging).toBe(true)
    expect(page.data.groups[0].ledStart).toBe(0xff) // 未写回
    page.onLedTouchEnd({ type: 'touchend' })
    jest.useRealTimers()
  })

  test('灯珠拖选：长按后松手（不移动）→ 选中单颗', () => {
    jest.useFakeTimers()
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2
    jest.advanceTimersByTime(300) // 长按激活
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(2) // 单颗
    expect(litCount(page)).toBe(1)
    jest.useRealTimers()
  })

  test('灯珠拖选：未长按但拖动超阈值 8px 激活', () => {
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] })
    expect(page.data.dragging).toBe(false) // 长按未到
    // 轻微抖动 5px：不激活。
    page.onLedTouchMove({ touches: [{ clientX: 155, clientY: 30 }] })
    expect(page.data.dragging).toBe(false)
    // 拖到格 4（dx=120 > 8px 阈值）：激活 + 区间更新。
    page.onLedTouchMove({ touches: [{ clientX: 270, clientY: 30 }] })
    expect(page.data.dragging).toBe(true)
    expect(page.data.dragRange).toEqual([2, 4])
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(4)
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
    const page = load(0)
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    wx.__cancelRect = null
    page.onLedTouchStart({ touches: [{ clientX: 330, clientY: 30 }] }) // 格 5
    page.onLedTouchMove({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2
    page.onLedTouchEnd({ type: 'touchend' })
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(5)
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
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2
    page.onLedTouchMove({ touches: [{ clientX: 210, clientY: 30 }] }) // 格 3（可扩）
    page.onLedTouchMove({ touches: [{ clientX: 330, clientY: 30 }] }) // 格 5（占用，停止）
    page.onLedTouchEnd({ type: 'touchend' })
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
    const page = load(0) // 上次选中 [2,5]
    wx.__gridRect = { left: 0, top: 0, width: 600, height: 600 }
    wx.__cancelRect = { left: 0, top: 700, width: 600, height: 100 }
    page.onLedTouchStart({ touches: [{ clientX: 150, clientY: 30 }] }) // 格 2 起
    page.onLedTouchMove({ touches: [{ clientX: 330, clientY: 30 }] }) // 格 5
    // 拖到取消区（clientY=750 落在 cancelRect 700..800）。
    page.onLedTouchMove({ touches: [{ clientX: 300, clientY: 750 }] })
    expect(page.data.inCancelZone).toBe(true)
    page.onLedTouchEnd({ type: 'touchend' })
    // 回滚：保留上次 [2,5]，不置 dirty。
    expect(page.data.groups[0].ledStart).toBe(2)
    expect(page.data.groups[0].ledEnd).toBe(5)
    expect(page.data.dirty).toBe(false)
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
    wx.__cancelRect = null
    // 起点落在格 5（被 g1 占用）→ 不进入 dragging。
    page.onLedTouchStart({ touches: [{ clientX: 330, clientY: 30 }] })
    expect(page.data.dragging).toBe(false)
  })

  test('清除本组灯珠：onClearLeds 设 255 空哨兵 + 置 dirty', () => {
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
    expect(page.data.dirty).toBe(true)
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

  // 最近使用色（#30）：选色写入 Storage + 重进页面回填。
  test('onColorPicked：hex 选中写入 field.value 并持久化最近色', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onColorPicked({
      currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } },
      detail: { value: '#FF8800' },
    })
    const after = page.data.groups[0].steps[0].layers[0]
    expect(fieldOf(after, 'color').value).toEqual([255, 136, 0])
    expect(page.data.dirty).toBe(true)
    // Storage 落盘：bt_recent_colors 首项为 '#FF8800'。
    expect(getRecentColors()[0]).toBe('#FF8800')
  })

  test('最近色去重倒序：重复选色移除后前插', () => {
    const page = load(0)
    const colorFi = page.data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    page.onColorPicked({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#FF0000' } })
    page.onColorPicked({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#00FF00' } })
    page.onColorPicked({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#FF0000' } })
    expect(getRecentColors()).toEqual(['#FF0000', '#00FF00'])
  })

  test('最近色跨会话回填：重进页面后 getRecentColors 可读回', () => {
    const colorFi = load(0).data.groups[0].steps[0].layers[0].fields.findIndex((f) => f.name === 'color')
    load(0).onColorPicked({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#123456' } })
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
    page.onColorPicked({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#ABCDEF' } })
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
    page.onColorPicked({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: '#FF0000' } })
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
      page.onColorPicked({ currentTarget: { dataset: { si: 0, li: 0, fi: colorFi } }, detail: { value: hex } })
    }
    const colors = getRecentColors()
    expect(colors).toHaveLength(10)
    // 第一个是最末 push 的（#0B0B0B），不含最早的 #00..。
    expect(colors[0]).toBe('#0B0B0B')
    expect(colors.find((c) => c === '#000000')).toBeUndefined()
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
    expect(decoded.pins.find((p) => p.pin === 0).groups).toHaveLength(5)
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

  // ---- 删除引脚 ---------------------------------------------------------------

  // 造一个含两个已配置引脚（0/2）的配置，便于断言删除 pin 0 后保留 pin 2。
  function seedTwoPins() {
    const mk = (pin, name, bright) => ({
      pin,
      configured: true,
      name,
      groups: [
        {
          name: `g${pin}`,
          ledStart: 0,
          ledEnd: 3,
          steps: [
            {
              duration: 5,
              transition: 0,
              loopMode: 1,
              layers: [{ effect: EFF.SOLID, params: { color: [1, 1, 1], brightness: bright } }],
            },
          ],
        },
      ],
    })
    saveDeviceConfig(dev.id, { version: 1, pins: [mk(0, 'A', 10), mk(2, 'B', 20)] })
  }

  test('删除引脚：已配置引脚 data.configured=true，未配置的新引脚为 false', () => {
    seedTwoPins()
    expect(load(0).data.configured).toBe(true)
    // pin 1 未配置：从"新增引脚"进入时不应展示删除入口。
    expect(load(1).data.configured).toBe(false)
  })

  test('删除引脚：确认后从 Storage 移除该引脚、保留其它，并返回', () => {
    jest.useFakeTimers()
    seedTwoPins()
    const page = load(0)
    setCurrentBleClient(null) // 未连接：只落盘 + 返回
    page.onDeletePin() // showModal mock 默认 confirm
    jest.runAllTimers()

    const pins = getDeviceConfig(dev.id).pins
    expect(pins.map((p) => p.pin)).toEqual([2]) // pin 0 已删，pin 2 原样保留
    expect(wx.navigateBack).toHaveBeenCalled()
    jest.useRealTimers()
  })

  test('删除引脚：已连接 → WRITE_CONFIG + APPLY 下发移除后的配置', async () => {
    const client = fakeClient(true)
    setCurrentBleClient(client)
    seedTwoPins()
    const page = load(0)
    page.onDeletePin()
    await flush()

    expect(client.sendCmd).toHaveBeenCalledTimes(2)
    expect(client.sendCmd.mock.calls[0][0]).toBe(CMD.WRITE_CONFIG)
    expect(client.sendCmd.mock.calls[1][0]).toBe(CMD.APPLY)
    // 下发的 blob 解回后 pin 0 已移除、pin 2 保留。
    const decoded = decodeConfigBlob(Uint8Array.from(client.sendCmd.mock.calls[0][1]))
    expect(decoded.pins.find((p) => p.pin === 0)).toBeUndefined()
    expect(decoded.pins.find((p) => p.pin === 2)).toBeDefined()
    // Storage 同步落盘。
    expect(getDeviceConfig(dev.id).pins.map((p) => p.pin)).toEqual([2])
  })
})