// 图表辅助纯函数层：渐变色标 / 时间轴 / 错误聚合 / RSSI 采样。
// 全部无 wx / BLE 依赖（Storage 通过注入的读写函数），Jest 直接可测。
// 图表渲染（canvas / CSS gradient）由页面负责，本文件只产出数据。

'use strict'

const { EFF, EFFECT_PARAMS, LIMITS } = require('./protocol_gen')
const { effectName, clampInt } = require('./configCodec')

// ---- effect id → name（与 pin-detail EFFECT_LABELS 同序，供图表配色） ----------

// 每个灯效一个主题色（与 design.md token 同色系），时间轴图层/色带用。
const EFFECT_COLORS = {
  [EFF.SOLID]: '#0088FF',
  [EFF.BREATH]: '#AF52DE',
  [EFF.BLINK]: '#FF9F0A',
  [EFF.MARQUEE]: '#64D2FF',
  [EFF.RAINBOW]: '#FF375F',
  [EFF.METEOR]: '#FFD60A',
  [EFF.DUAL_GRADIENT]: '#30D158',
  [EFF.RHYTHM]: '#FF453A',
}

function effectColor(effectId) {
  return EFFECT_COLORS[effectId] || '#8E8E93'
}

// ---- 渐变色带（CSS linear-gradient 字符串） -----------------------------------

// 彩虹：HSV 色环 6 段近似（红→橙→黄→绿→蓝→紫→红）。
const RAINBOW_STOPS = ['#FF375F', '#FF9F0A', '#FFD60A', '#30D158', '#0A84FF', '#BF5AF2', '#FF375F']

// 按 effect 生成卡片底部渐变条的 background-image。
// 返回 null 表示不用渐变（SOLID/BLINK 单色用 swatch 即可）。
function layerGradientCss(effectId, fields) {
  const name = effectName(effectId)
  const f = fields || []
  const c1 = _fieldHex(f, 'color', '#FFFFFF')
  const c2 = _fieldHex(f, 'color2', '#0088FF')
  switch (name) {
    case 'RAINBOW':
      return `linear-gradient(to right, ${RAINBOW_STOPS.join(', ')})`
    case 'DUAL_GRADIENT':
      return `linear-gradient(to right, ${c1}, ${c2})`
    case 'METEOR':
      // 头亮尾暗：白 → 主题色 → 透明感深色。
      return `linear-gradient(to right, #FFFFFF, ${c1} 40%, #000000)`
    case 'MARQUEE':
      return `linear-gradient(to right, transparent, ${c1} 30%, ${c1} 70%, transparent)`
    case 'BREATH':
      return `linear-gradient(to right, ${c1}33, ${c1}, ${c1}33)`
    default:
      return null
  }
}

function _fieldHex(fields, name, fallback) {
  const fd = (fields || []).find((x) => x && x.name === name)
  if (!fd) return fallback
  if (fd.hex) return fd.hex
  if (Array.isArray(fd.value)) {
    const [r, g, b] = fd.value
    const to = (v) => ('0' + clampInt(v, 0, 255).toString(16)).slice(-2)
    return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
  }
  return fallback
}

// ---- 错误日志分布（mine 页柱状图） ---------------------------------------------
// 把 error_log 条目聚合成"最近 N 天"的桶：[{label, count}]，label 为 M/D。

function aggregateErrorLog(log, days) {
  const n = days || 7
  const now = Date.now()
  const DAY = 86400000
  const buckets = []
  for (let i = n - 1; i >= 0; i--) {
    const start = now - (i + 1) * DAY
    const end = now - i * DAY
    buckets.push({ start, end, count: 0, label: '' })
  }
  // label 用结束日的月/日。
  buckets.forEach((b) => {
    const d = new Date(b.end)
    b.label = `${d.getMonth() + 1}/${d.getDate()}`
  })
  for (const e of log || []) {
    const ts = Number(e && e.ts) || 0
    if (!ts) continue
    // 找桶：ts ∈ [start, end)
    for (const b of buckets) {
      if (ts >= b.start && ts < b.end) {
        b.count++
        break
      }
    }
  }
  return buckets
}

// ---- RSSI 采样（device-list 扫描结果 sparkline） -------------------------------
// 扫描会话内把每次 onFound 的 (ts, rssi) 攒起来，画最近 N 秒的信号曲线。
// 纯内存环形缓冲，不落盘。

function createRssiSampler(maxPoints) {
  const cap = maxPoints || 40
  const buf = []
  return {
    push(rssi, now) {
      const v = Number(rssi)
      if (!isFinite(v)) return
      buf.push({ ts: now || Date.now(), v })
      while (buf.length > cap) buf.shift()
    },
    // 归一化到 [-1, 0] dBm → [0, 1]（-100..-30 映射，超出钳制）。
    points() {
      return buf.map((p) => ({
        x: p.ts,
        y: Math.max(0, Math.min(1, (p.v + 100) / 70)),
      }))
    },
    raw() {
      return buf.slice()
    },
    clear() {
      buf.length = 0
    },
  }
}

module.exports = {
  RAINBOW_STOPS,
  EFFECT_COLORS,
  effectColor,
  layerGradientCss,
  aggregateErrorLog,
  createRssiSampler,
}
