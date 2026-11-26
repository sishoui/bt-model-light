// 3D 灯效预览渲染层：逐灯珠效果渲染（镜像固件）+ 长条灯条 3D 投影。
//
// 纯函数（无 wx / canvas 依赖），Jest 直接可测；页面只负责逐帧画。
// 渲染规则逐条对齐 firmware/src/effects.cpp（ADR-0017 / ADR-0018）：
// 同一组参数下，预览里每颗灯珠的颜色与固件输出一致（时间单位为 10ms tick）。
// 唯一例外：流星拖尾亮头扫出灯带后固件维持原样不再变化，预览让时间回卷循环，
// 否则调参几秒后画面就静止了。

'use strict'

const { EFF, LIMITS } = require('./protocol_gen')

// 与固件 effects.h 的 TICK_MS 一致：效果内部一切时间都以 tick 计数。
const TICK_MS = 10
// 固件呼吸相位分辨率（effects.cpp PHASE_STEPS）。
const PHASE_STEPS = 1024
// 固件色相环一圈的刻度数（360 * 255 / 60）。
const HUE_WRAP = 1536
// 灯组未配置灯珠区间时，预览按这条示意灯带长度渲染。
const PREVIEW_LEDS_FALLBACK = 24

function _num(v, fallback) {
  const n = Number(v)
  return isFinite(n) ? n : fallback
}

// 整数除法（向零截断）：固件里全是整数运算，浮点会把亮度/色相算出 1 的偏差。
function _idiv(a, b) {
  return Math.trunc(a / b)
}

function _clamp255(v) {
  const n = Math.round(_num(v, 0))
  return n < 0 ? 0 : n > 255 ? 255 : n
}

// 参数里的 rgb（数组）→ 三元组；缺省白（表单默认色）。
function _rgb(v) {
  if (!Array.isArray(v) || v.length < 3) return [255, 255, 255]
  return [_clamp255(v[0]), _clamp255(v[1]), _clamp255(v[2])]
}

// 按亮度缩放颜色（镜像固件 scale_rgb）。
function _scale(c, brightness) {
  const b = _clamp255(brightness)
  if (b >= 255) return c
  if (b <= 0) return [0, 0, 0]
  return [_idiv(c[0] * b, 255), _idiv(c[1] * b, 255), _idiv(c[2] * b, 255)]
}

// 呼吸亮度曲线：sin 映射到 [34, 255]（固件 SIN_TABLE 的解析式近似，
// 与查表值最多差 1/255，肉眼不可见）。
function breathBrightness(phaseSteps) {
  const ph = ((Math.floor(_num(phaseSteps, 0)) % PHASE_STEPS) + PHASE_STEPS) % PHASE_STEPS
  const idx = _idiv(ph, 4) & 0xff
  const s = Math.sin((idx / 256) * Math.PI * 2)
  return _clamp255(((s + 1) / 2) * 221 + 34)
}

// HSV → RGB，h ∈ [0, HUE_WRAP)、s/v ∈ [0,255]（镜像固件 hsvToRgb）。
function hsvToRgb255(h, s, v) {
  const hh = ((_idiv(_num(h, 0), 1) % HUE_WRAP) + HUE_WRAP) % HUE_WRAP
  const ss = _clamp255(s)
  const vv = _clamp255(v)
  const sector = _idiv(hh, 256)
  const f = hh & 0xff
  const p = _idiv((255 - ss) * vv, 255)
  const q = _idiv((255 - _idiv(ss * f, 255)) * vv, 255)
  const t = _idiv((255 - _idiv(ss * (255 - f), 255)) * vv, 255)
  switch (sector) {
    case 0: return [vv, t, p]
    case 1: return [q, vv, p]
    case 2: return [p, vv, t]
    case 3: return [p, q, vv]
    case 4: return [t, p, vv]
    default: return [vv, p, q]
  }
}

// 单颗灯珠的颜色：effect_id + 参数 + 组内像素序号 + 组灯珠数 + 时间 tick。
// 与固件 effectRenderPixel 一一对应；未知灯效输出全黑。
function effectPixel(effectId, params, pixel, ledCount, ticks) {
  const p = params || {}
  const n = Math.max(1, ledCount)
  const t = Math.max(0, Math.floor(_num(ticks, 0)))
  const brightness = _num(p.brightness, 255)

  switch (effectId) {
    // 常亮：纯色 × 亮度。
    case EFF.SOLID:
      return _scale(_rgb(p.color), brightness)

    // 呼吸：亮度按 period 走正弦/三角波，pixel 参与相位（灯带上有传播感）。
    case EFF.BREATH: {
      const periodTicks = Math.max(1, _idiv(_num(p.period, 1000), TICK_MS))
      const phase = _idiv(((t + pixel) % periodTicks) * PHASE_STEPS, periodTicks)
      const half = PHASE_STEPS / 2
      const ph = phase % PHASE_STEPS
      let b
      if (_num(p.waveform, 0) === 1) {
        // 三角波：前半程升到 255，后半程降回 0。
        b = ph < half
          ? _idiv(_idiv(ph * 2, half) * 255, 256)
          : 255 - _idiv((ph - half) * 2, half)
      } else {
        b = breathBrightness(phase)
      }
      if (_num(p.direction, 0) & 1) b = 255 - b
      return _scale(_rgb(p.color), b)
    }

    // 闪烁：on_time / off_time 决定占空比，亮段乘亮度。
    case EFF.BLINK: {
      const onTicks = Math.max(1, _idiv(_num(p.on_time, 500), TICK_MS))
      const offTicks = Math.max(1, _idiv(_num(p.off_time, 500), TICK_MS))
      const pos = t % (onTicks + offTicks)
      if (pos >= onTicks) return [0, 0, 0]
      return _scale(_rgb(p.color), brightness)
    }

    // 跑马灯：led_count 颗亮块 + gap 颗暗间隔，按 speed 平移，离亮头越远越暗。
    case EFF.MARQUEE: {
      const speed = Math.max(1, _num(p.speed, 50))
      const ticksPerStep = Math.max(1, _idiv(_idiv(1000, speed), TICK_MS))
      const head = _idiv(t, ticksPerStep)
      const lit = Math.max(1, _num(p.led_count, 1))
      const cell = Math.max(1, lit + _num(p.gap, 0))
      const cells = Math.max(1, Math.ceil(n / cell))
      const myCell = _idiv(pixel, cell)
      const myOff = pixel % cell
      const headCell = _num(p.direction, 0) & 1
        ? cells - 1 - (head % cells)
        : head % cells
      const dist = myCell >= headCell ? myCell - headCell : myCell + cells - headCell
      if (dist >= lit || myOff >= lit) return [0, 0, 0]
      let b = brightness
      if (dist > 0) {
        const fade = _idiv(dist * 255, lit)
        b = b > fade ? b - fade : 0
      }
      return _scale(_rgb(p.color), b)
    }

    // 彩虹：色相沿灯带铺开 spread%，整体按 speed 滚动。
    case EFF.RAINBOW: {
      const speed = Math.max(1, _num(p.speed, 50))
      const scroll = _idiv(_idiv(t * 256, _idiv(256, speed)), _idiv(1000, TICK_MS))
      const span = _idiv(_num(p.spread, 50) * HUE_WRAP, 100)
      const spatial = _idiv(pixel * span, n)
      let hue = (spatial + scroll) % HUE_WRAP
      if (_num(p.direction, 0) & 1) hue = HUE_WRAP - 1 - hue
      return hsvToRgb255(hue, 255, brightness)
    }

    // 流星拖尾：亮头 + 按 decay 指数衰减的尾，尾长 tail_length。
    // 注意固件 fx_meteor 的 dist 语义：亮头"前方"（未扫到的灯珠）也算 dist=0，
    // 因此固件实际是"头部及其前方全亮、身后按 decay 衰减"。预览如实复现。
    // 唯一的时间适配：亮头扫出灯带后固件永久维持全亮，预览让时间回卷循环。
    case EFF.METEOR: {
      const speed = Math.max(1, _num(p.speed, 50))
      const ticksPerStep = Math.max(1, _idiv(_idiv(1000, speed), TICK_MS))
      const tail = Math.max(1, _num(p.tail_length, 1))
      const loopTicks = ticksPerStep * (n + tail)
      const head = _idiv(t % loopTicks, ticksPerStep)
      const reverse = _num(p.direction, 0) & 1
      const dist = reverse
        ? (pixel >= head ? pixel - head : 0)
        : (pixel <= head ? head - pixel : 0)
      if (dist >= tail) return [0, 0, 0]
      const decay = _clamp255(_num(p.decay, 128))
      let b = brightness
      for (let i = 0; i < dist && b > 0; i++) b = _idiv(b * decay, 255)
      return _scale(_rgb(p.color), b)
    }

    // 双色渐变：color → color2 沿灯带插值，mode 1 用正弦缓动，speed 控制流动。
    case EFF.DUAL_GRADIENT: {
      if (n <= 1) return _scale(_rgb(p.color), brightness)
      const speed = Math.max(1, _num(p.speed, 50))
      const scroll = _idiv(t * speed, _idiv(100, TICK_MS))
      const pos = (_idiv(pixel * 255, n - 1) + scroll) & 0xff
      const frac = _num(p.mode, 0) === 1
        ? breathBrightness(_idiv(pos * PHASE_STEPS, 256) % PHASE_STEPS)
        : pos
      const c1 = _rgb(p.color)
      const c2 = _rgb(p.color2)
      // 逐分量 c1 + (c2-c1)*frac/255（与固件的截断顺序一致，先乘后除再相加）。
      const mix = [0, 1, 2].map((k) => c1[k] + _idiv((c2[k] - c1[k]) * frac, 255))
      return _scale(mix, brightness)
    }

    // 律动跳变：pattern 位掩码决定每拍亮灭，亮拍里 1/3 的块跳变点亮。
    case EFF.RHYTHM: {
      const speed = Math.max(1, _num(p.speed, 50))
      const ticksPerBeat = Math.max(1, _idiv(_idiv(1000, speed), TICK_MS))
      const beat = _idiv(t, ticksPerBeat)
      const mask = (_num(p.pattern, 0) >> (beat & 7)) & 1
      const gate = _idiv(beat, 8) & 1
      if ((mask ^ gate) === 0) return [0, 0, 0]
      const step = Math.max(1, _num(p.step_size, 1))
      if ((_idiv(pixel, step) + beat) % 3 !== 0) return [0, 0, 0]
      return _scale(_rgb(p.color), brightness)
    }

    default:
      return [0, 0, 0]
  }
}

// 整条灯带的颜色：[{r,g,b} 三元组] 数组，长度 = 组内灯珠数（≤100）。
// tMs 为效果本地时间（毫秒），从 0 开始。
function renderStrip(effectId, params, ledCount, tMs) {
  const count = Math.floor(_num(ledCount, 0))
  const n = count >= 1
    ? Math.min(LIMITS.ledsPerPinMax, count)
    : PREVIEW_LEDS_FALLBACK
  const ticks = Math.max(0, Math.floor(_num(tMs, 0) / TICK_MS))
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = effectPixel(effectId, params, i, n, ticks)
  return out
}

// 双图层合成（镜像固件 composition.cpp 的 compose_layer）：
// 上层（动效层）非黑取上层，否则取下层（背景层）。
function composeLayers(bg, anim) {
  const a = anim || [0, 0, 0]
  if (a[0] !== 0 || a[1] !== 0 || a[2] !== 0) return a
  return bg || [0, 0, 0]
}

// 一个阶段（含 1~2 个图层）的整条灯带颜色：先各层独立渲染再逐灯珠合成。
// layers 为 [{ effect, params }]（顺序即图层序，0 = 背景层）。
function renderStageStrip(layers, ledCount, tMs) {
  const list = Array.isArray(layers) ? layers.filter((l) => l && l.effect) : []
  if (!list.length) return []
  const count = Math.floor(_num(ledCount, 0))
  const n = count >= 1
    ? Math.min(LIMITS.ledsPerPinMax, count)
    : PREVIEW_LEDS_FALLBACK
  const ticks = Math.max(0, Math.floor(_num(tMs, 0) / TICK_MS))
  const rendered = list.map((l) => {
    const arr = new Array(n)
    for (let i = 0; i < n; i++) arr[i] = effectPixel(l.effect, l.params, i, n, ticks)
    return arr
  })
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    let c = rendered[0][i]
    for (let k = 1; k < rendered.length; k++) c = composeLayers(c, rendered[k][i])
    out[i] = c
  }
  return out
}

// 预览灯带长度：取灯组已配置的灯珠区间长度；未配置（255 哨兵）用示意长度。
function stripLength(group) {
  const g = group || {}
  const start = _num(g.ledStart, 0xff)
  const end = _num(g.ledEnd, 0xff)
  if (start === 0xff || end === 0xff || end < start) return PREVIEW_LEDS_FALLBACK
  return Math.max(1, Math.min(LIMITS.ledsPerPinMax, end - start + 1))
}

// ---- 3D 投影 ---------------------------------------------------------------
// 灯条沿 x 轴直线排布（一条长条灯带），y 为上下、z 指向远处（投影后 z 越大越远）。
// 长条本身贴在 x 轴上，靠 yaw 转出横向透视压缩、pitch 转出纵向倾角，形成立体感。

// 长条灯带几何：n 颗灯珠等距铺在一条直线上，中心在原点，总长 length。
function stripPoints(count, opts) {
  const o = opts || {}
  const n = Math.max(1, Math.floor(_num(count, 1)))
  const length = _num(o.length, 4)
  const points = []
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0.5 : i / (n - 1)
    points.push({
      x: -length / 2 + u * length,
      y: 0,
      z: 0,
    })
  }
  return points
}

// 透视投影：先绕 y 轴转 yaw、再绕 x 轴转 pitch，最后按相机距离做透视除法。
// 返回 [{ x, y, rel, depth }]：x/y 为画布 CSS 像素坐标，depth 越大越远，
// rel = 参考距离 / 本点距离（近处 > 1），供页面按深度缩放灯珠。
//
// 缩放口径：在允许的旋转范围内采样若干个角度，算出模型最坏的投影伸出量，
// 据此一次性定下像素比例，与当前 yaw/pitch 无关。这样长条在任意允许角度都
// 保持同一像素尺度——转过去变短是真实透视压缩，而不是画面在缩放（若每帧
// 按当前投影包围盒归一，画面会随转动忽大忽小地抖）。
// yawRange/pitchRange 必须与页面实际施加的旋转限位一致，否则会估小导致出界。
function projectPoints(points, opts) {
  const o = opts || {}
  const list = Array.isArray(points) ? points : []
  const yaw = _num(o.yaw, 0)
  const pitch = _num(o.pitch, 0)
  const width = _num(o.width, 300)
  const height = _num(o.height, 160)
  const distance = Math.max(0.5, _num(o.distance, 6.5))
  const focal = _num(o.focal, 6.5)
  const pad = Math.max(0, _num(o.padding, 10))
  const yawRange = Math.abs(_num(o.yawRange, Math.PI / 2))
  const pitchRange = Math.abs(_num(o.pitchRange, Math.PI / 2))

  // 绕 y 轴／x 轴旋转 + 透视除法，返回未缩放的相机平面坐标（单位 = 模型单位）。
  // 缩放与居中在最后一步统一施加，避免两处各算一遍。
  const project = (x, y, z, cy_, sy_, cp, sp) => {
    const x1 = x * cy_ + z * sy_
    const z1 = -x * sy_ + z * cy_
    const y1 = y * cp - z1 * sp
    const z2 = y * sp + z1 * cp
    const cam = Math.max(0.5, distance + z2)
    const k = focal / cam
    return { x: x1 * k, y: y1 * k, rel: distance / cam, depth: cam }
  }

  const sx = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const projected = list.map((pt) => project(
    _num(pt && pt.x, 0), _num(pt && pt.y, 0), _num(pt && pt.z, 0), sx, sy, cp, sp,
  ))

  // 旋转范围采样（含端点与 0）：取各角度下投影伸出量的最大值来定比例。
  const STEPS = 4
  let maxAbsX = 0
  let maxAbsY = 0
  for (let i = 0; i <= STEPS; i++) {
    const yy = (yawRange * (2 * i - STEPS)) / STEPS
    const cy_ = Math.cos(yy)
    const sy_ = Math.sin(yy)
    for (let j = 0; j <= STEPS; j++) {
      const pp = (pitchRange * (2 * j - STEPS)) / STEPS
      const cp_ = Math.cos(pp)
      const sp_ = Math.sin(pp)
      for (const pt of list) {
        const q = project(
          _num(pt && pt.x, 0), _num(pt && pt.y, 0), _num(pt && pt.z, 0), cy_, sy_, cp_, sp_,
        )
        const ax = Math.abs(q.x)
        const ay = Math.abs(q.y)
        if (ax > maxAbsX) maxAbsX = ax
        if (ay > maxAbsY) maxAbsY = ay
      }
    }
  }

  const availW = Math.max(1, width - pad * 2)
  const availH = Math.max(1, height - pad * 2)
  let unit = Math.min(
    maxAbsX > 0 ? availW / (2 * maxAbsX) : Infinity,
    maxAbsY > 0 ? availH / (2 * maxAbsY) : Infinity,
  )
  if (!isFinite(unit) || unit <= 0) unit = Math.min(width, height) * 0.3

  const cx = width / 2
  const cy0 = height / 2
  return projected.map((q) => ({
    x: cx + q.x * unit,
    y: cy0 - q.y * unit,
    rel: q.rel,
    depth: q.depth,
  }))
}

module.exports = {
  TICK_MS,
  PHASE_STEPS,
  HUE_WRAP,
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
}
