// chartHelpers 纯函数层测试：波形采样 / 渐变 / 时间轴 / 错误聚合 / 历史与采样器。

'use strict'

const {
  WAVE_SAMPLES,
  effectColor,
  sampleWaveform,
  layerGradientCss,
  buildTimeline,
  aggregateErrorLog,
  loadBrightnessHistory,
  pushBrightnessHistory,
  createRssiSampler,
  RAINBOW_STOPS,
} = require('../utils/chartHelpers')
const { EFF } = require('../utils/protocol_gen')

describe('effectColor', () => {
  test('已知灯效返回主题色，未知回退灰', () => {
    expect(effectColor(EFF.SOLID)).toBe('#0088FF')
    expect(effectColor(EFF.RAINBOW)).toBe('#FF375F')
    expect(effectColor(99)).toBe('#8E8E93')
  })
})

describe('sampleWaveform', () => {
  const mkFields = (over) =>
    [
      { name: 'color', type: 'rgb', value: [255, 255, 255], hex: '#FFFFFF' },
      { name: 'brightness', type: 'u8', value: 128, min: 0, max: 255 },
      { name: 'speed', type: 'u8', value: 50, min: 1, max: 100 },
      { name: 'period', type: 'u16', value: 1000, min: 100, max: 10000 },
      { name: 'on_time', type: 'u16', value: 200, min: 10, max: 5000 },
      { name: 'off_time', type: 'u16', value: 200, min: 10, max: 5000 },
      { name: 'waveform', type: 'u8', value: 0, min: 0, max: 1 },
      { name: 'tail_length', type: 'u8', value: 50, min: 1, max: 100 },
      { name: 'decay', type: 'u8', value: 128, min: 1, max: 255 },
      { name: 'mode', type: 'u8', value: 0, min: 0, max: 1 },
      { name: 'pattern', type: 'u8', value: 0, min: 0, max: 255 },
      { name: 'step_size', type: 'u8', value: 25, min: 1, max: 100 },
      { name: 'led_count', type: 'u8', value: 10, min: 1, max: 100 },
      { name: 'gap', type: 'u8', value: 5, min: 0, max: 99 },
      { name: 'spread', type: 'u8', value: 50, min: 1, max: 100 },
    ].map((f) => Object.assign(f, over && over[f.name] ? over[f.name] : {}))

  test('所有灯效都返回定长、x 单调、y∈[0,1] 的点列', () => {
    for (const id of Object.values(EFF)) {
      const pts = sampleWaveform(id, mkFields(), 24)
      expect(pts).toHaveLength(24)
      for (let i = 0; i < pts.length; i++) {
        expect(pts[i].x).toBeCloseTo(i / (pts.length - 1), 5)
        expect(pts[i].y).toBeGreaterThanOrEqual(0)
        expect(pts[i].y).toBeLessThanOrEqual(1)
      }
    }
  })

  test('SOLID 波形平直且为所有灯效中最高（不受 speed/period 影响）', () => {
    const pts = sampleWaveform(EFF.SOLID, mkFields(), 12)
    for (const p of pts) expect(p.y).toBeCloseTo(pts[0].y, 5)
    const breath = sampleWaveform(EFF.BREATH, mkFields(), 12)
    expect(Math.min(...pts.map((p) => p.y))).toBeGreaterThan(Math.max(...breath.map((p) => p.y)))
  })

  test('brightness=0 时整体压低（SOLID 也变暗）', () => {
    const dark = sampleWaveform(EFF.SOLID, mkFields({ brightness: { value: 0 } }), 12)
    expect(dark[0].y).toBeLessThan(0.5)
  })

  test('BLINK 占空比随 on/off 时间变化', () => {
    const longOn = sampleWaveform(EFF.BLINK, mkFields({ on_time: { value: 4000 }, off_time: { value: 100 } }), 48)
    const longOff = sampleWaveform(EFF.BLINK, mkFields({ on_time: { value: 100 }, off_time: { value: 4000 } }), 48)
    const mean = (a) => a.reduce((s, p) => s + p.y, 0) / a.length
    expect(mean(longOn)).toBeGreaterThan(mean(longOff))
  })
})

describe('layerGradientCss', () => {
  test('RAINBOW 返回彩虹渐变，DUAL_GRADIENT 用两色', () => {
    const rainbow = layerGradientCss(EFF.RAINBOW, [])
    expect(rainbow).toContain('linear-gradient')
    expect(rainbow).toContain(RAINBOW_STOPS[0])
    const dual = layerGradientCss(EFF.DUAL_GRADIENT, [
      { name: 'color', type: 'rgb', value: [255, 0, 0], hex: '#FF0000' },
      { name: 'color2', type: 'rgb', value: [0, 0, 255], hex: '#0000FF' },
    ])
    expect(dual).toContain('#FF0000')
    expect(dual).toContain('#0000FF')
  })

  test('SOLID/BLINK 返回 null（单色用 swatch）', () => {
    expect(layerGradientCss(EFF.SOLID, [])).toBeNull()
    expect(layerGradientCss(EFF.BLINK, [])).toBeNull()
  })
})

describe('buildTimeline', () => {
  test('段宽按 duration 比例、x 累计、总宽=1', () => {
    const steps = [
      { name: 'A', duration: 5, transition: 0, layers: [{ effect: EFF.SOLID }] },
      { name: 'B', duration: 15, transition: 1, layers: [{ effect: EFF.BREATH }, { effect: EFF.BLINK }] },
    ]
    const tl = buildTimeline(steps)
    expect(tl).toHaveLength(2)
    expect(tl[0].x).toBe(0)
    expect(tl[0].w).toBeCloseTo(0.25, 5)
    expect(tl[1].x).toBeCloseTo(0.25, 5)
    expect(tl[1].w).toBeCloseTo(0.75, 5)
    // 第二段有过渡 → transW > 0
    expect(tl[1].transW).toBeGreaterThan(0)
    // 图层子段均分段宽
    expect(tl[1].layers).toHaveLength(2)
    expect(tl[1].layers[0].w).toBeCloseTo(tl[1].w / 2, 5)
  })

  test('空数组返回空', () => {
    expect(buildTimeline([])).toEqual([])
    expect(buildTimeline(null)).toEqual([])
  })
})

describe('aggregateErrorLog', () => {
  test('按天聚合，越界丢弃', () => {
    const now = Date.now()
    const DAY = 86400000
    const log = [
      { ts: now - 1000, message: 'a' }, // 今天
      { ts: now - DAY - 1000, message: 'b' }, // 昨天
      { ts: now - DAY * 3 - 1000, message: 'c' }, // 3 天前
      { ts: now - DAY * 30, message: 'old' }, // 超窗丢弃
      { ts: 0, message: 'zero' }, // ts=0 丢弃
    ]
    const buckets = aggregateErrorLog(log, 7)
    expect(buckets).toHaveLength(7)
    expect(buckets[6].count).toBe(1) // 今天
    expect(buckets[5].count).toBe(1) // 昨天
    expect(buckets[3].count).toBe(1) // 3 天前
    const total = buckets.reduce((s, b) => s + b.count, 0)
    expect(total).toBe(3)
    // label 形如 M/D
    expect(buckets[6].label).toMatch(/^\d{1,2}\/\d{1,2}$/)
  })
})

describe('brightness history', () => {
  function memStorage() {
    const m = new Map()
    return {
      get: (k) => m.get(k) || null,
      set: (k, v) => m.set(k, v),
      map: m,
    }
  }

  test('push 追加、近时戳去重、超上限裁剪', () => {
    const s = memStorage()
    const key = 'h'
    pushBrightnessHistory(s.get, s.set, key, 100, 1000)
    pushBrightnessHistory(s.get, s.set, key, 200, 2500) // 间隔 1500ms → 新点
    pushBrightnessHistory(s.get, s.set, key, 255, 2600) // 100ms 内 → 覆盖上一点
    const hist = loadBrightnessHistory(s.get, key)
    expect(hist).toHaveLength(2)
    expect(hist[0].v).toBe(100)
    expect(hist[1].v).toBe(255)
    // 越界钳制
    pushBrightnessHistory(s.get, s.set, key, 999, 2000)
    expect(loadBrightnessHistory(s.get, key).pop().v).toBe(255)
    pushBrightnessHistory(s.get, s.set, key, -5, 3000)
    expect(loadBrightnessHistory(s.get, key).pop().v).toBe(0)
  })

  test('损坏 JSON 返回空', () => {
    const s = memStorage()
    s.set('bad', '{oops')
    expect(loadBrightnessHistory(s.get, 'bad')).toEqual([])
    expect(loadBrightnessHistory(s.get, 'missing')).toEqual([])
  })
})

describe('createRssiSampler', () => {
  test('环形缓冲 + 归一化', () => {
    const s = createRssiSampler(3)
    s.push(-100, 1)
    s.push(-50, 2)
    s.push(-30, 3)
    s.push(-70, 4) // 挤掉最旧
    const raw = s.raw()
    expect(raw).toHaveLength(3)
    expect(raw[0].v).toBe(-50)
    const pts = s.points()
    // -50 → (−50+100)/70 ≈ 0.714；-30 → 1；-70 → 0.428
    expect(pts[1].y).toBeCloseTo(1, 5)
    expect(pts[0].y).toBeCloseTo(50 / 70, 5)
    // 非数字忽略
    s.push('x', 5)
    expect(s.raw()).toHaveLength(3)
  })
})
