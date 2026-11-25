// 最近使用色持久化（跨会话）。
//
// Storage 布局：
//   bt_recent_colors  最近使用色 hex 数组：["#RRGGBB", ...]
//
// 与 device_config_* / bt_devices 独立，不触碰 configCodec / wire 格式。
//
// 依赖 wx Storage 仅通过全局 wx 访问，不 import wx，便于 Jest 双端运行
// （与 deviceStore.js 相同的约束：ES2017+ 标准 API）。
//
// 设计：无进程内缓存（色板体积小，每次读直接走 Storage，避免跨测试/跨会话
// 缓存不同步问题）。上限约 10，写入时去重、倒序，读取 JSON 解析容错。

'use strict'

const STORAGE_KEY_RECENT_COLORS = 'bt_recent_colors'
const MAX_RECENT_COLORS = 10

function _wx() {
  if (typeof wx === 'undefined') {
    throw new Error('recentColors requires the wx runtime (call it inside miniprogram or install wx-mock in tests)')
  }
  return wx
}

// hex 归一：大写、带 # 前缀、6 位。去重与读写均经此，避免大小写并存。
function normalizeHex(hex) {
  if (typeof hex !== 'string') return null
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/)
  if (!m) return null
  return '#' + m[1].toUpperCase()
}

// 读取最近使用色数组；无记录 / 损坏 / 非数组时安全降级为空数组。
// 读取时归一（大写 + #），并去重，避免旧数据大小写并存。
function getRecentColors() {
  const raw = _wx().getStorageSync(STORAGE_KEY_RECENT_COLORS)
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out = []
    const seen = new Set()
    for (const h of parsed) {
      const n = normalizeHex(h)
      if (!n || seen.has(n)) continue
      seen.add(n)
      out.push(n)
    }
    return out
  } catch (e) {
    return [] // 存储损坏视为空，后续 push 会覆盖
  }
}

// 将 hex 插入数组头部：已存在则先移除再前插（去重、倒序），截断到上限。
// 入库前归一（大写 + #），避免大小写并存重复。
function pushRecentColor(hex) {
  const norm = normalizeHex(hex)
  if (!norm) return
  const colors = getRecentColors().map(normalizeHex).filter(Boolean)
  const next = [norm, ...colors.filter((c) => c !== norm)]
  next.length = Math.min(next.length, MAX_RECENT_COLORS)
  _wx().setStorageSync(STORAGE_KEY_RECENT_COLORS, JSON.stringify(next))
}

// 测试钩子：清掉最近色 Storage（与 deviceStore.resetDeviceStore 风格一致）。
function resetRecentColors() {
  _wx().removeStorageSync(STORAGE_KEY_RECENT_COLORS)
}

// hex ↔ rgb 转换（供颜色弹层把 hex 写入 field.value rgb 数组、把 rgb 渲染为 hex 预览）。
// 极简，无校验；非法输入统一返回 null，调用方据此忽略。
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/)
  if (!m) return null
  const v = m[1]
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}

function rgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return null
  const c = (n) => {
    const v = Math.max(0, Math.min(255, Math.round(Number(n) || 0)))
    return v.toString(16).padStart(2, '0')
  }
  return '#' + c(rgb[0]) + c(rgb[1]) + c(rgb[2])
}

// HSV ↔ RGB 转换（颜色弹层三维选色：色相/饱和度/亮度条拖动）。
// h: [0,360)，s/v: [0,100]（弹层与 UI 的显示单位）；rgb 分量 [0,255]。
// 极简无校验入口，非法输入由调用方保证不传入；hsvToRgb 对越界值做归一。
function hsvToRgb(h, s, v) {
  const sn = Math.max(0, Math.min(100, Number(s) || 0)) / 100
  const vn = Math.max(0, Math.min(100, Number(v) || 0)) / 100
  const hn = ((Number(h) || 0) % 360 + 360) % 360
  const c = vn * sn
  const x = c * (1 - Math.abs((hn / 60) % 2 - 1))
  const m = vn - c
  let r = 0
  let g = 0
  let b = 0
  if (hn < 60) { r = c; g = x } else if (hn < 120) { r = x; g = c } else if (hn < 180) { g = c; b = x } else if (hn < 240) { g = x; b = c } else if (hn < 300) { r = x; b = c } else { r = c; b = x }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

// rgb → { h, s, v }（h 四舍五入取整 [0,360]，s/v 取整 [0,100]）。
// 灰度（max===min）色相记 0，与 HSV 数学定义一致（灰/黑/白无彩色相）。
function rgbToHsv(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return null
  const r = Math.max(0, Math.min(255, Number(rgb[0]) || 0)) / 255
  const g = Math.max(0, Math.min(255, Number(rgb[1]) || 0)) / 255
  const b = Math.max(0, Math.min(255, Number(rgb[2]) || 0)) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return { h: Math.round(h) % 360, s: Math.round((max === 0 ? 0 : d / max) * 100), v: Math.round(max * 100) }
}

module.exports = {
  STORAGE_KEY_RECENT_COLORS,
  MAX_RECENT_COLORS,
  getRecentColors,
  pushRecentColor,
  resetRecentColors,
  hexToRgb,
  rgbToHex,
  hsvToRgb,
  rgbToHsv,
  normalizeHex,
}
