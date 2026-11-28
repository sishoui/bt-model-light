// chartHelpers 纯函数层测试：渐变 / 效果配色 / 错误聚合 / RSSI 采样。

'use strict'

const {
  effectColor,
  layerGradientCss,
  aggregateErrorLog,
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
