// 设备配置 blob 编解码（T7 / #27）。
//
// WRITE_CONFIG(0x01) / READ_CONFIG(0x02) 的 payload 就是这份 blob，
// 与固件 firmware/src/config.cpp 的 config_encode/config_decode 字节级一致，
// 布局见 protocol/frame-spec.md "配置负载"：
//
//   magic(4 "BTLC") + version(1) + flags(1) + body_len(2 LE) + body + crc16(2 LE)
//   body = 8 个引脚块：group_count(1) + 灯组…
//   灯组 = led_start(1) + led_end(1) + step_count(1) + 步骤…
//   步骤 = duration(2 LE) + transition(1) + loop_mode(1) + layer_count(1) + 图层…
//   图层 = effect_id(1) + param_len(1) + params(param_len)
//
// 配置对象（Storage 真相源 / 页面模型）在 wire 字段之外还带 UI 元数据
// （pin.name / pin.power / pin.configured / group.name），编码时忽略。
//
// 仅依赖 ES2017+ 标准 API 与 protocol_gen / frameParser（均不依赖 wx），
// Jest 与小程序运行时双端可用（同 frameParser.js 约束）。

'use strict'

const { crc16Ccitt } = require('./frameParser')
const { EFF, EFFECT_PARAMS, ERR, LIMITS, FRAME } = require('./protocol_gen')

const CONFIG_VERSION = 1
const CONFIG_MAGIC_LE = 0x434c5442 // "BTLC" 小端
const CONFIG_BLOB_OVERHEAD = 10 // magic4+ver1+flags1+body_len2+crc2
const CONFIG_BODY_MAX = FRAME.lenMax - CONFIG_BLOB_OVERHEAD // 固件 CONFIG_BODY_MAX
const PIN_COUNT = LIMITS.pinCount // 8

// effect id ↔ name 互查（EFF 只有 name→id，这里补反向表）。
const NAME_BY_ID = {}
for (const name of Object.keys(EFF)) NAME_BY_ID[EFF[name]] = name

function effectName(effectId) {
  return NAME_BY_ID[effectId] || null
}

// 带错误码的错误：页面/测试按 code 区分（对齐 ERR_* / ADR-0026）。
function configError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

// ---- 校验（镜像 firmware config_validate） -----------------------------------

// 返回 null 表示合法；否则 { code, message }。只校验结构与枚举/范围，
// 参数值范围由渲染层钳制（固件 config_validate 同样只校验 param_len/effect_id）。
function validateConfig(config) {
  const pins = config && Array.isArray(config.pins) ? config.pins : []
  const seen = new Set()
  for (const pin of pins) {
    // pin 索引必须落在 [0, PIN_COUNT) 且不重复：encode 只遍历 0..7，
    // 越界/重复条目会被静默丢弃，导致 Storage 与固件不一致，这里提前拒绝。
    const idx = pin && pin.pin
    if (!(Number.isInteger(idx) && idx >= 0 && idx < PIN_COUNT)) {
      return { code: ERR.INVALID_PARAMETER, message: '引脚索引越界' }
    }
    if (seen.has(idx)) return { code: ERR.INVALID_PARAMETER, message: '引脚索引重复' }
    seen.add(idx)
    const groups = Array.isArray(pin.groups) ? pin.groups : []
    if (groups.length > LIMITS.groupsPerPinMax) {
      return { code: ERR.CONFIG_LIMIT_EXCEEDED, message: `灯组数超过上限（≤${LIMITS.groupsPerPinMax}）` }
    }
    for (const g of groups) {
      // 255 哨兵：ledStart == ledEnd == 255 表示空组（未选灯珠），跳过范围校验。
      // 镜像 firmware config.cpp config_validate。
      if (g.ledStart === 0xff && g.ledEnd === 0xff) {
        // 空组：仍需校验 step/layer 结构，下方继续。
      } else {
        if (!(g.ledStart >= 0 && g.ledStart <= LIMITS.ledRangeMax)) {
          return { code: ERR.INVALID_PARAMETER, message: '灯珠起点越界' }
        }
        if (!(g.ledEnd >= 0 && g.ledEnd <= LIMITS.ledRangeMax && g.ledEnd >= g.ledStart)) {
          return { code: ERR.INVALID_PARAMETER, message: '灯珠终点越界或小于起点' }
        }
      }
      const steps = Array.isArray(g.steps) ? g.steps : []
      if (steps.length < 1 || steps.length > LIMITS.stepsPerGroupMax) {
        return { code: ERR.CONFIG_LIMIT_EXCEEDED, message: `步骤数需在 1~${LIMITS.stepsPerGroupMax}` }
      }
      for (const s of steps) {
        if (!(s.duration >= LIMITS.stepDurationMin && s.duration <= LIMITS.stepDurationMax)) {
          return { code: ERR.INVALID_PARAMETER, message: `步骤时长需在 ${LIMITS.stepDurationMin}~${LIMITS.stepDurationMax} 秒` }
        }
        if (!(s.transition >= 0 && s.transition <= 2)) {
          return { code: ERR.INVALID_PARAMETER, message: '过渡模式非法' }
        }
        if (!(s.loopMode >= 0 && s.loopMode <= 2)) {
          return { code: ERR.INVALID_PARAMETER, message: '循环模式非法' }
        }
        const layers = Array.isArray(s.layers) ? s.layers : []
        if (layers.length < 1 || layers.length > LIMITS.layersPerStepMax) {
          return { code: ERR.CONFIG_LIMIT_EXCEEDED, message: `图层数需在 1~${LIMITS.layersPerStepMax}` }
        }
        for (const l of layers) {
          const name = effectName(l.effect)
          if (!name || !EFFECT_PARAMS[name]) {
            return { code: ERR.INVALID_PARAMETER, message: '未知灯效' }
          }
        }
      }
    }
  }
  return null
}

// ---- 参数块编解码（按 EFFECT_PARAMS schema 顺序拼接） ------------------------

function clampInt(v, min, max) {
  const n = Math.round(Number(v))
  if (!isFinite(n)) return min
  return n < min ? min : n > max ? max : n
}

function encodeParams(effectId, params) {
  const name = effectName(effectId)
  const spec = EFFECT_PARAMS[name] || []
  const src = params || {}
  const out = []
  for (const p of spec) {
    const v = src[p.name]
    if (p.type === 'rgb') {
      const arr = Array.isArray(v) ? v : [0, 0, 0]
      out.push(clampInt(arr[0], 0, 255), clampInt(arr[1], 0, 255), clampInt(arr[2], 0, 255))
    } else if (p.type === 'u16') {
      const n = clampInt(v, 0, 0xffff)
      out.push(n & 0xff, (n >> 8) & 0xff)
    } else if (p.type === 'u32') {
      const n = clampInt(v, 0, 0xffffffff)
      out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff)
    } else {
      out.push(clampInt(v, 0, 255)) // u8
    }
  }
  return out
}

// 某效果的参数块字节数（schema 求和，镜像 firmware config_effect_param_size）。
function paramSize(effectId) {
  const spec = EFFECT_PARAMS[effectName(effectId)] || []
  let n = 0
  for (const p of spec) n += p.type === 'rgb' ? 3 : p.type === 'u16' ? 2 : p.type === 'u32' ? 4 : 1
  return n
}

function decodeParams(effectId, bytes) {
  const name = effectName(effectId)
  const spec = EFFECT_PARAMS[name] || []
  const params = {}
  let off = 0
  for (const p of spec) {
    if (p.type === 'rgb') {
      params[p.name] = [bytes[off], bytes[off + 1], bytes[off + 2]]
      off += 3
    } else if (p.type === 'u16') {
      params[p.name] = bytes[off] | (bytes[off + 1] << 8)
      off += 2
    } else if (p.type === 'u32') {
      params[p.name] = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
      off += 4
    } else {
      params[p.name] = bytes[off]
      off += 1
    }
  }
  return params
}

// ---- 编码：配置对象 → blob（镜像 config_encode） -----------------------------

function encodeConfigBlob(config) {
  const verr = validateConfig(config)
  if (verr) throw configError(verr.code, verr.message)

  const srcPins = config && Array.isArray(config.pins) ? config.pins : []
  const body = []
  for (let pin = 0; pin < PIN_COUNT; pin++) {
    const entry = srcPins.find((p) => p && p.pin === pin)
    const groups = entry && Array.isArray(entry.groups) ? entry.groups : []
    body.push(groups.length & 0xff)
    for (const g of groups) {
      body.push(g.ledStart & 0xff, g.ledEnd & 0xff)
      const steps = Array.isArray(g.steps) ? g.steps : []
      body.push(steps.length & 0xff)
      for (const s of steps) {
        body.push(s.duration & 0xff, (s.duration >> 8) & 0xff)
        body.push(s.transition & 0xff, s.loopMode & 0xff)
        const layers = Array.isArray(s.layers) ? s.layers : []
        body.push(layers.length & 0xff)
        for (const l of layers) {
          const params = encodeParams(l.effect, l.params)
          body.push(l.effect & 0xff, params.length & 0xff)
          for (const b of params) body.push(b)
        }
      }
    }
  }

  const bodyLen = body.length
  if (bodyLen > CONFIG_BODY_MAX) {
    throw configError(ERR.CONFIG_LIMIT_EXCEEDED, '配置超出单帧上限')
  }
  const out = []
  out.push(CONFIG_MAGIC_LE & 0xff, (CONFIG_MAGIC_LE >> 8) & 0xff, (CONFIG_MAGIC_LE >> 16) & 0xff, (CONFIG_MAGIC_LE >> 24) & 0xff)
  out.push(CONFIG_VERSION, 0) // version, flags
  out.push(bodyLen & 0xff, (bodyLen >> 8) & 0xff)
  for (const b of body) out.push(b)

  const crc = crc16Ccitt(Uint8Array.from(out))
  out.push(crc & 0xff, (crc >> 8) & 0xff)
  return Uint8Array.from(out)
}

// ---- 解码：blob → 配置对象（镜像 config_decode） ----------------------------

function decodeConfigBlob(bytes) {
  const inBytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
  const inLen = inBytes.length
  if (inLen < CONFIG_BLOB_OVERHEAD) {
    throw configError(ERR.INTERNAL_ERROR, '配置 blob 过短')
  }
  const magic =
    (inBytes[0] | (inBytes[1] << 8) | (inBytes[2] << 16) | (inBytes[3] << 24)) >>> 0
  if (magic !== CONFIG_MAGIC_LE) throw configError(ERR.INTERNAL_ERROR, 'magic 不符')
  if (inBytes[4] !== CONFIG_VERSION) throw configError(ERR.INVALID_PARAMETER, '配置版本不符')

  const bodyLen = inBytes[6] | (inBytes[7] << 8)
  const total = CONFIG_BLOB_OVERHEAD + bodyLen
  if (total > inLen) throw configError(ERR.BUFFER_OVERFLOW, '配置 blob 被截断')

  const wantCrc = inBytes[total - 2] | (inBytes[total - 1] << 8)
  const gotCrc = crc16Ccitt(inBytes.subarray(0, total - 2))
  if (wantCrc !== gotCrc) throw configError(ERR.CRC_ERROR, 'CRC 校验失败')

  const pins = []
  let off = 8
  const bodyEnd = 8 + bodyLen
  for (let pin = 0; pin < PIN_COUNT; pin++) {
    if (off >= bodyEnd) throw configError(ERR.INTERNAL_ERROR, 'body 提前结束')
    const groupCount = inBytes[off++]
    if (groupCount > LIMITS.groupsPerPinMax) throw configError(ERR.CONFIG_LIMIT_EXCEEDED, '灯组数超限')
    if (groupCount === 0) continue // 未配置引脚不进模型
    const groups = []
    for (let gi = 0; gi < groupCount; gi++) {
      if (off + 3 > bodyEnd) throw configError(ERR.INTERNAL_ERROR, '灯组头越界')
      const ledStart = inBytes[off++]
      const ledEnd = inBytes[off++]
      const stepCount = inBytes[off++]
      if (stepCount < 1 || stepCount > LIMITS.stepsPerGroupMax) {
        throw configError(ERR.CONFIG_LIMIT_EXCEEDED, '步骤数超限')
      }
      const steps = []
      for (let si = 0; si < stepCount; si++) {
        if (off + 5 > bodyEnd) throw configError(ERR.INTERNAL_ERROR, '步骤头越界')
        const duration = inBytes[off] | (inBytes[off + 1] << 8)
        const transition = inBytes[off + 2]
        const loopMode = inBytes[off + 3]
        const layerCount = inBytes[off + 4]
        off += 5
        if (layerCount < 1 || layerCount > LIMITS.layersPerStepMax) {
          throw configError(ERR.CONFIG_LIMIT_EXCEEDED, '图层数超限')
        }
        const layers = []
        for (let li = 0; li < layerCount; li++) {
          if (off + 2 > bodyEnd) throw configError(ERR.INTERNAL_ERROR, '图层头越界')
          const effect = inBytes[off++]
          const paramLen = inBytes[off++]
          const name = effectName(effect)
          if (!name || !EFFECT_PARAMS[name]) throw configError(ERR.INVALID_PARAMETER, '未知灯效')
          if (paramLen !== paramSize(effect)) throw configError(ERR.INVALID_PARAMETER, '参数块长度不符')
          if (off + paramLen > bodyEnd) throw configError(ERR.INTERNAL_ERROR, '参数块越界')
          const params = decodeParams(effect, inBytes.subarray(off, off + paramLen))
          off += paramLen
          layers.push({ effect, params })
        }
        steps.push({ duration, transition, loopMode, layers })
      }
      groups.push({ ledStart, ledEnd, steps })
    }
    pins.push({ pin, groups })
  }
  if (off !== bodyEnd) throw configError(ERR.INTERNAL_ERROR, 'body 未对齐')

  // 结构级 + 范围校验（镜像 firmware config_decode 末尾的 config_validate）。
  const config = { version: CONFIG_VERSION, pins }
  const verr = validateConfig(config)
  if (verr) throw configError(verr.code, verr.message)
  return config
}

module.exports = {
  CONFIG_VERSION,
  CONFIG_MAGIC_LE,
  CONFIG_BLOB_OVERHEAD,
  effectName,
  clampInt,
  validateConfig,
  encodeConfigBlob,
  decodeConfigBlob,
}