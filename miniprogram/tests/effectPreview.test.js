// effectPreview 纯函数层测试：逐灯珠渲染（对齐固件 effects.cpp）+ 长条 3D 投影。

'use strict'

const {
  TICK_MS,
  PREVIEW_LEDS_FALLBACK,
  breathBrightness,
  hsvToRgb255,
  effectPixel,
  renderStrip,
  composeLayers,
  renderStageStrip,
  stripLength,
  stripPoints,
  projectPoints,
} = require('../utils/effectPreview')
const { EFF } = require('../utils/protocol_gen')

const WHITE = { color: [255, 255, 255], brightness: 255 }

// 固件默认参数在页面里的取值（buildParamFields 的 defaultParamValue 同口径）。
function baseParams(over) {
  return Object.assign({
    color: [255, 255, 255],
    color2: [0, 136, 255],
    brightness: 128,
    speed: 50,
    direction: 0,
    period: 1000,
    waveform: 0,
    on_time: 200,
    off_time: 200,
    led_count: 10,
    gap: 5,
    spread: 50,
    tail_length: 20,
    decay: 128,
    mode: 0,
    pattern: 255,
    step_size: 10,
  }, over)
}

const lum = (c) => Math.max(c[0], c[1], c[2])

describe('breathBrightness', () => {
  test('正弦表：相位 0 在中位，四分之一周期到峰值，半周期回中位再下行', () => {
    // 固件 SIN_TABLE 是 (sin+1)/2*221+34：起表在中位 145，峰 255，谷 34。
    expect(breathBrightness(0)).toBe(145)
    expect(breathBrightness(256)).toBe(255)
    expect(breathBrightness(768)).toBeGreaterThan(30)
    expect(breathBrightness(768)).toBeLessThan(50)
  })

  test('相位越界/负数回卷到 [0,1024)', () => {
    expect(breathBrightness(1024 + 128)).toBe(breathBrightness(128))
    expect(breathBrightness(-128)).toBe(breathBrightness(1024 - 128))
  })
})

describe('hsvToRgb255', () => {
  test('四个基准色相', () => {
    expect(hsvToRgb255(0, 255, 255)).toEqual([255, 0, 0])
    expect(hsvToRgb255(512, 255, 255)).toEqual([0, 255, 0])
    expect(hsvToRgb255(1024, 255, 255)).toEqual([0, 0, 255])
    expect(hsvToRgb255(300, 0, 255)).toEqual([255, 255, 255])
  })

  test('v=0 恒为黑，分量都在 [0,255]', () => {
    expect(hsvToRgb255(1234, 255, 0)).toEqual([0, 0, 0])
    for (let h = 0; h < 1536; h += 37) {
      for (const c of hsvToRgb255(h, 200, 180)) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  })
})

describe('effectPixel', () => {
  test('SOLID：亮度线性缩放，brightness=0 全黑', () => {
    expect(effectPixel(EFF.SOLID, { color: [255, 255, 255], brightness: 255 }, 0, 10, 0)).toEqual([255, 255, 255])
    expect(effectPixel(EFF.SOLID, { color: [255, 0, 0], brightness: 128 }, 3, 10, 99)).toEqual([128, 0, 0])
    expect(effectPixel(EFF.SOLID, { color: [255, 255, 255], brightness: 0 }, 0, 10, 0)).toEqual([0, 0, 0])
  })

  test('BREATH：同一像素随时间明暗变化，正弦与三角波形状不同', () => {
    const p = baseParams()
    const samples = [0, 250, 500, 750].map((t) => lum(effectPixel(EFF.BREATH, p, 0, 20, t / TICK_MS)))
    expect(new Set(samples).size).toBeGreaterThan(1)
    expect(Math.max(...samples)).toBeGreaterThan(Math.min(...samples))
    const tri = baseParams({ waveform: 1 })
    const sine = baseParams({ waveform: 0 })
    const a = lum(effectPixel(EFF.BREATH, sine, 0, 20, 30))
    const b = lum(effectPixel(EFF.BREATH, tri, 0, 20, 30))
    expect(a).not.toBe(b)
  })

  test('BREATH direction=1：同一时刻的亮度与正向互补', () => {
    const fwd = baseParams({ brightness: 255 })
    const rev = baseParams({ brightness: 255, direction: 1 })
    const a = lum(effectPixel(EFF.BREATH, fwd, 0, 20, 40))
    const b = lum(effectPixel(EFF.BREATH, rev, 0, 20, 40))
    expect(a + b).toBe(255)
  })

  test('BLINK：亮段用亮度色，灭段全黑', () => {
    const p = baseParams({ on_time: 300, off_time: 100, brightness: 255 })
    // on 300ms = 30 tick，off 100ms = 10 tick，周期 40 tick。
    expect(effectPixel(EFF.BLINK, p, 0, 10, 0)).toEqual([255, 255, 255])
    expect(effectPixel(EFF.BLINK, p, 0, 10, 35)).toEqual([0, 0, 0])
    expect(effectPixel(EFF.BLINK, p, 0, 10, 40)).toEqual([255, 255, 255])
  })

  test('MARQUEE：亮块按 speed 推移，不是整条常亮也不是全黑', () => {
    const p = baseParams({ led_count: 4, gap: 2, speed: 50, brightness: 255 })
    const litAt = (ticks) => {
      const out = []
      for (let i = 0; i < 60; i++) if (lum(effectPixel(EFF.MARQUEE, p, i, 60, ticks)) > 0) out.push(i)
      return out
    }
    const first = litAt(0)
    const later = litAt(4) // 4 tick → 亮头平移 2 像素，落到下一个亮块
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(60) // 有暗间隔
    expect(first.join(',')).not.toBe(later.join(',')) // 亮块在走
  })

  test('RAINBOW：色相沿灯带铺开，相邻灯珠不同色', () => {
    const p = baseParams({ spread: 100, brightness: 255, speed: 1 })
    const a = effectPixel(EFF.RAINBOW, p, 0, 20, 0)
    const b = effectPixel(EFF.RAINBOW, p, 10, 20, 0)
    expect(a).not.toEqual(b)
  })

  test('METEOR：镜像固件语义——亮头及未扫到的前方全亮，身后按 decay 衰减', () => {
    const p = baseParams({ speed: 50, tail_length: 6, decay: 128, brightness: 255 })
    // speed 50 → 2 tick/像素；tick 20 → 头在第 10 颗。正向时拖尾在 head 之后（更小下标）。
    const head = lum(effectPixel(EFF.METEOR, p, 10, 30, 20))
    const behind = lum(effectPixel(EFF.METEOR, p, 8, 30, 20))
    const ahead = lum(effectPixel(EFF.METEOR, p, 20, 30, 20))
    expect(head).toBe(255)
    expect(behind).toBeLessThan(head) // 身后是拖尾
    expect(ahead).toBe(255) // 固件 fx_meteor：pixel 在头前方时 dist=0 → 全亮
    expect(effectPixel(EFF.METEOR, p, 0, 30, 20)).toEqual([0, 0, 0]) // 尾巴之外全黑
  })

  test('METEOR：亮头扫出灯带后会重新进入（预览不永久黑屏）', () => {
    const p = baseParams({ speed: 50, tail_length: 4, brightness: 255 })
    const n = 20
    const ticksPerStep = 2
    const cycle = ticksPerStep * (n + 4)
    // 超过固件的"一次性"时域后仍有亮灯。
    const later = []
    for (let i = 0; i < n; i++) later.push(lum(effectPixel(EFF.METEOR, p, i, n, cycle * 3 + 4)))
    expect(Math.max(...later)).toBeGreaterThan(0)
  })

  test('DUAL_GRADIENT：两端分别是 color 与 color2', () => {
    const p = baseParams({ color: [255, 0, 0], color2: [0, 0, 255], brightness: 255, speed: 1 })
    expect(effectPixel(EFF.DUAL_GRADIENT, p, 0, 11, 0)).toEqual([255, 0, 0])
    expect(effectPixel(EFF.DUAL_GRADIENT, p, 10, 11, 0)).toEqual([0, 0, 255])
  })

  test('RHYTHM：有的拍亮、有的拍灭', () => {
    const p = baseParams({ speed: 50, brightness: 255 })
    const litOf = (ticks) => {
      let lit = 0
      for (let i = 0; i < 30; i++) if (lum(effectPixel(EFF.RHYTHM, p, i, 30, ticks)) > 0) lit++
      return lit
    }
    const frames = [0, 5, 10, 15, 20, 25, 30, 35].map(litOf)
    expect(frames.some((n) => n > 0)).toBe(true)
    expect(frames.some((n) => n === 0)).toBe(true)
  })

  test('未知灯效渲染为全黑（不抛错）', () => {
    expect(effectPixel(0x7f, baseParams(), 0, 10, 0)).toEqual([0, 0, 0])
    expect(effectPixel(0x7f, null, 0, 10, 0)).toEqual([0, 0, 0])
  })

  test('缺省参数也能渲染（不产生 NaN / 越界）', () => {
    for (const id of Object.values(EFF)) {
      const c = effectPixel(id, {}, 0, 10, 0)
      expect(c).toHaveLength(3)
      for (const v of c) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    }
  })
})

describe('renderStrip', () => {
  test('返回定长三元组，长度跟随灯珠数并受上限钳制', () => {
    const colors = renderStrip(EFF.SOLID, WHITE, 12, 0)
    expect(colors).toHaveLength(12)
    for (const c of colors) expect(c).toEqual([255, 255, 255])
    expect(renderStrip(EFF.SOLID, WHITE, 999, 0)).toHaveLength(100)
    expect(renderStrip(EFF.SOLID, WHITE, 0, 0)).toHaveLength(PREVIEW_LEDS_FALLBACK)
  })

  test('同一时刻 SOLID 全亮，BLINK 灭段全黑（整条一致）', () => {
    const solid = renderStrip(EFF.SOLID, WHITE, 16, 300)
    expect(solid.every((c) => c[0] === 255)).toBe(true)
    const blink = renderStrip(EFF.BLINK, baseParams({ on_time: 100, off_time: 200, brightness: 255 }), 16, 150)
    expect(blink.every((c) => c[0] === 0)).toBe(true)
  })
})

describe('composeLayers / renderStageStrip', () => {
  test('上层非黑取上层，上层全黑回落到背景层', () => {
    // composeLayers(bg, anim)：anim 非黑取 anim，否则取 bg。
    expect(composeLayers([10, 20, 30], [0, 0, 0])).toEqual([10, 20, 30])
    expect(composeLayers([255, 0, 0], [0, 0, 1])).toEqual([0, 0, 1])
    expect(composeLayers(null, [0, 0, 0])).toEqual([0, 0, 0])
    expect(composeLayers([255, 0, 0], null)).toEqual([255, 0, 0])
  })

  test('单图层阶段等价于 renderStrip', () => {
    const single = renderStageStrip([{ effect: EFF.SOLID, params: WHITE }], 8, 0)
    expect(single).toEqual(renderStrip(EFF.SOLID, WHITE, 8, 0))
  })

  test('双图层：动效层亮灯珠覆盖背景，灭灯珠露出背景', () => {
    // 背景常亮纯红；动效层闪烁（on 100ms / off 200ms）纯绿。
    const layers = [
      { effect: EFF.SOLID, params: { color: [255, 0, 0], brightness: 255 } },
      { effect: EFF.BLINK, params: { color: [0, 255, 0], brightness: 255, on_time: 100, off_time: 200 } },
    ]
    const on = renderStageStrip(layers, 4, 50)
    for (const c of on) expect(c).toEqual([0, 255, 0])
    const off = renderStageStrip(layers, 4, 150)
    for (const c of off) expect(c).toEqual([255, 0, 0])
  })

  test('空图层列表返回空数组', () => {
    expect(renderStageStrip([], 8, 0)).toEqual([])
    expect(renderStageStrip(null, 8, 0)).toEqual([])
  })
})

describe('stripLength', () => {  test('未配置灯珠（255 哨兵）用示意长度', () => {
    expect(stripLength({ ledStart: 0xff, ledEnd: 0xff })).toBe(PREVIEW_LEDS_FALLBACK)
    expect(stripLength(null)).toBe(PREVIEW_LEDS_FALLBACK)
  })

  test('已配置取区间长度，倒序回退示意长度', () => {
    expect(stripLength({ ledStart: 10, ledEnd: 39 })).toBe(30)
    expect(stripLength({ ledStart: 5, ledEnd: 4 })).toBe(PREVIEW_LEDS_FALLBACK)
  })

  test('超出引脚上限钳到 100', () => {
    expect(stripLength({ ledStart: 0, ledEnd: 200 })).toBe(100)
  })
})

describe('stripPoints', () => {
  test('点数与灯珠数一致，沿 x 等距排成一条直线', () => {
    const pts = stripPoints(40, { length: 8 })
    expect(pts).toHaveLength(40)
    for (const p of pts) {
      expect(p.y).toBe(0)
      expect(p.z).toBe(0)
    }
    const gaps = []
    for (let i = 1; i < pts.length; i++) gaps.push(pts[i].x - pts[i - 1].x)
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 9)
    expect(pts[0].x).toBeCloseTo(-4, 9)
    expect(pts[39].x).toBeCloseTo(4, 9)
  })

  test('单颗灯珠不除零，落在中心', () => {
    const pts = stripPoints(1, { length: 4 })
    expect(pts).toHaveLength(1)
    expect(pts[0].x).toBeCloseTo(0, 9)
  })

  test('默认长度可用，非法数量兜底为 1 颗', () => {
    expect(stripPoints(5).length).toBe(5)
    expect(stripPoints(0, { length: 4 })).toHaveLength(1)
  })
})

describe('projectPoints', () => {
  const opts = { width: 300, height: 160, yaw: 0, pitch: 0 }

  test('原点投影到画布中心，结果都在画布内', () => {
    const out = projectPoints([{ x: 0, y: 0, z: 0 }], opts)
    expect(out[0].x).toBeCloseTo(150, 6)
    expect(out[0].y).toBeCloseTo(80, 6)
    const many = projectPoints(stripPoints(50, { length: 8 }), opts)
    for (const p of many) {
      expect(p.x).toBeGreaterThan(0)
      expect(p.x).toBeLessThan(300)
      expect(p.y).toBeGreaterThan(0)
      expect(p.y).toBeLessThan(160)
    }
  })

  test('y 轴向上：正 y 渲染在更小的画布 y（屏幕上方）', () => {
    const out = projectPoints([{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }], opts)
    expect(out[0].y).toBeLessThan(out[1].y)
  })

  test('近大远小：z 越大 depth 越大、rel 越小', () => {
    const [near, far] = projectPoints([{ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }], opts)
    expect(far.depth).toBeGreaterThan(near.depth)
    expect(far.rel).toBeLessThan(near.rel)
  })

  test('任意 yaw/pitch 下整条灯条都不出画布（按限位范围取最坏尺寸）', () => {
    const opts = { width: 300, height: 160, padding: 8, yawRange: 0.85, pitchRange: 0.55 }
    const pts = stripPoints(100, { length: 8 })
    for (const yaw of [-0.85, -0.5, 0, 0.5, 0.85]) {
      for (const pitch of [-0.55, -0.2, 0, 0.3, 0.55]) {
        for (const p of projectPoints(pts, Object.assign({ yaw, pitch }, opts))) {
          expect(p.x).toBeGreaterThanOrEqual(0)
          expect(p.x).toBeLessThanOrEqual(300)
          expect(p.y).toBeGreaterThanOrEqual(0)
          expect(p.y).toBeLessThanOrEqual(160)
        }
      }
    }
  })

  test('缩放与当前角度无关：摆动时灯条整体尺度不变（只做透视压缩）', () => {
    const pts = stripPoints(60, { length: 8 })
    const opts = { width: 300, height: 160, pitch: 0, yawRange: 0.85, pitchRange: 0.55 }
    const span = (yaw) => {
      const out = projectPoints(pts, Object.assign({ yaw }, opts))
      const xs = out.map((p) => p.x)
      return Math.max(...xs) - Math.min(...xs)
    }
    // 限位内摆动：横向跨度应接近（不会被逐帧归一拉成满宽）。
    const base = span(0)
    for (const yaw of [-0.85, -0.4, 0.4, 0.85]) {
      expect(span(yaw)).toBeGreaterThan(base * 0.75)
      expect(span(yaw)).toBeLessThanOrEqual(base)
    }
  })

  test('灯条占据舞台的主要宽度（构图不被限位压小）', () => {
    const pts = stripPoints(100, { length: 8 })
    const out = projectPoints(pts, { width: 320, height: 160, yaw: 0, pitch: 0, yawRange: 0.85, pitchRange: 0.55 })
    const xs = out.map((p) => p.x)
    const fill = (Math.max(...xs) - Math.min(...xs)) / 320
    expect(fill).toBeGreaterThan(0.6)
    expect(fill).toBeLessThan(0.95)
  })

  test('非法输入不抛错', () => {
    expect(projectPoints(null, opts)).toEqual([])
    expect(projectPoints([null], opts)[0]).toEqual({ x: 150, y: 80, rel: 1, depth: 6.5 })
  })
})
