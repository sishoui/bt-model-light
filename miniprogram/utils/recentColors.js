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

module.exports = {
  STORAGE_KEY_RECENT_COLORS,
  MAX_RECENT_COLORS,
  getRecentColors,
  pushRecentColor,
  resetRecentColors,
  hexToRgb,
  rgbToHex,
  normalizeHex,
}
