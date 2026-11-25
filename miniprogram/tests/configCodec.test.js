// Jest 单测：miniprogram/utils/configCodec.js（T7 / #27）。
//
// configCodec 是 WRITE_CONFIG 负载的 JS 编码器/解码器，必须与固件
// firmware/src/config.cpp 的 config_encode/config_decode 字节级一致
// （blob 布局见 protocol/frame-spec.md "配置负载"）。
//
// 策略（避免自证）：
//   - 结构 golden：头部 + body 用独立手算字面量断言（不含 CRC）。
//   - 往返：encode → decode 深比对（编解码互为独立实现，交叉校验）。
//   - CRC：翻转 body 字节 → decode 抛 CRC 错误，证明 CRC 覆盖范围正确。
//   - CRC 算法本身复用 frameParser.crc16Ccitt（其正确性已由 frameParser.test.js
//     对独立实现 buildFrameBytes 验证）。

'use strict'

const { encodeConfigBlob, decodeConfigBlob, validateConfig, CONFIG_BLOB_OVERHEAD } = require('../utils/configCodec')
const { crc16Ccitt } = require('../utils/frameParser')
const { ERR, EFF, EFFECT_PARAMS } = require('../utils/protocol_gen')

// 最小合法配置：1 引脚 / 1 灯组 / 1 步骤 / 1 图层（SOLID）。灯带开关为开
// （power=false 的编码见下方"灯带开关"用例）。
function minimalConfig() {
  return {
    version: 1,
    pins: [
      {
        pin: 0,
        name: '灯带',
        power: true,
        configured: true,
        groups: [
          {
            name: 'G1',
            ledStart: 0,
            ledEnd: 9,
            steps: [
              {
                duration: 5,
                transition: 0,
                loopMode: 1,
                layers: [{ effect: EFF.SOLID, params: { color: [0x12, 0x34, 0x56], brightness: 200 } }],
              },
            ],
          },
        ],
      },
    ],
  }
}

// 重算 CRC（独立实现，复用 frameParser.crc16Ccitt），使改坏字节能过 CRC 校验，
// 从而验证 CRC 之后的结构/枚举校验。
function fixCrc(bytes) {
  const crc = crc16Ccitt(bytes.subarray(0, bytes.length - 2))
  bytes[bytes.length - 2] = crc & 0xff
  bytes[bytes.length - 1] = (crc >> 8) & 0xff
  return bytes
}

describe('configCodec（T7）', () => {
  test('编码：头部 + body 字节与 frame-spec 手算一致', () => {
    const bytes = encodeConfigBlob(minimalConfig())
    // 头部：magic "BTLC"(42 54 4C 43) + version(1) + flags(0) + body_len(22 LE)
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x42, 0x54, 0x4c, 0x43, 1, 0, 22, 0])
    // body(22B)：pin0 组 + 7 个空引脚
    expect(Array.from(bytes.slice(8, 8 + 22))).toEqual([
      0x01, // pin0 group_count = 1
      0x00, 0x09, 0x01, // led_start=0, led_end=9, step_count=1
      0x05, 0x00, 0x00, 0x01, 0x01, // duration=5 LE, transition=0, loop=1, layer_count=1
      0x01, 0x04, 0x12, 0x34, 0x56, 0xc8, // effect=1, param_len=4, R,G,B, brightness=200
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // pin1..7 group_count=0
    ])
    // 总长 = 10(overhead) + 22(body)，末尾 2 字节 CRC
    expect(bytes.length).toBe(CONFIG_BLOB_OVERHEAD + 22)
  })

  test('灯带开关关闭（power=false，ADR-0028）：该引脚不下发灯组，固件侧即清空灯带', () => {
    const cfg = minimalConfig()
    cfg.pins[0].power = false
    const bytes = encodeConfigBlob(cfg)
    // body 只剩 8 个引脚的 group_count 字节，pin0 也是 0（灯组不下发）。
    expect(Array.from(bytes.slice(8, 8 + 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(bytes.length).toBe(CONFIG_BLOB_OVERHEAD + 8)
    // 无灯组的引脚不进解码模型（固件 config_decode 同语义）→ 该灯带无内容可渲染。
    expect(decodeConfigBlob(bytes).pins).toEqual([])
  })

  test('灯带开关打开：同一份 Storage 配置恢复下发全部灯组', () => {
    const cfg = minimalConfig()
    cfg.pins[0].power = false
    expect(decodeConfigBlob(encodeConfigBlob(cfg)).pins).toEqual([])
    cfg.pins[0].power = true
    const decoded = decodeConfigBlob(encodeConfigBlob(cfg))
    expect(decoded.pins).toHaveLength(1)
    expect(decoded.pins[0].groups[0].ledEnd).toBe(9)
  })

  test('未显式关闭（无 power 字段）视为开：老配置保持配好就亮', () => {
    const cfg = minimalConfig()
    delete cfg.pins[0].power
    expect(decodeConfigBlob(encodeConfigBlob(cfg)).pins).toHaveLength(1)
  })

  test('往返：encode → decode 保留全部字段', () => {
    const cfg = minimalConfig()
    const decoded = decodeConfigBlob(encodeConfigBlob(cfg))
    expect(decoded.version).toBe(1)
    expect(decoded.pins).toHaveLength(1)
    const p = decoded.pins[0]
    expect(p.pin).toBe(0)
    const g = p.groups[0]
    expect(g.ledStart).toBe(0)
    expect(g.ledEnd).toBe(9)
    const s = g.steps[0]
    expect(s.duration).toBe(5)
    expect(s.transition).toBe(0)
    expect(s.loopMode).toBe(1)
    const l = s.layers[0]
    expect(l.effect).toBe(EFF.SOLID)
    expect(l.params.color).toEqual([0x12, 0x34, 0x56])
    expect(l.params.brightness).toBe(200)
  })

  test('8 种灯效参数块按 schema 编码并往返一致（含 pin 索引定位）', () => {
    for (const name of Object.keys(EFF)) {
      const effect = EFF[name]
      const params = {}
      for (const p of EFFECT_PARAMS[name]) {
        if (p.type === 'rgb') params[p.name] = [1, 2, 3]
        else if (p.type === 'u16' || p.type === 'u32') params[p.name] = 300
        else params[p.name] = 7
      }
      const cfg = {
        version: 1,
        pins: [
          {
            pin: 3, // 非 0 引脚：验证按 pin 索引定位
            groups: [
              {
                ledStart: 2,
                ledEnd: 5,
                steps: [{ duration: 10, transition: 1, loopMode: 2, layers: [{ effect, params }] }],
              },
            ],
          },
        ],
      }
      const decoded = decodeConfigBlob(encodeConfigBlob(cfg))
      expect(decoded.pins).toHaveLength(1)
      expect(decoded.pins[0].pin).toBe(3)
      const dl = decoded.pins[0].groups[0].steps[0].layers[0]
      expect(dl.effect).toBe(effect)
      expect(dl.params).toEqual(params)
    }
  })

  test('CRC：翻转 body 字节 → 解码报 CRC 错误', () => {
    const bytes = encodeConfigBlob(minimalConfig())
    bytes[10] ^= 0xff // body 内
    let err = null
    try {
      decodeConfigBlob(bytes)
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(err.code).toBe(ERR.CRC_ERROR)
  })

  test('坏 magic → 解码报内部错误', () => {
    const bytes = encodeConfigBlob(minimalConfig())
    bytes[0] = 0x00
    let err = null
    try {
      decodeConfigBlob(bytes)
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(err.code).toBe(ERR.INTERNAL_ERROR)
  })

  test('未知灯效（CRC 修正后）→ 解码报参数非法', () => {
    const bytes = encodeConfigBlob(minimalConfig())
    bytes[17] = 0x7f // 首图层 effect_id 偏移（见 golden 布局）
    fixCrc(bytes)
    let err = null
    try {
      decodeConfigBlob(bytes)
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(err.code).toBe(ERR.INVALID_PARAMETER)
  })

  test('param_len 与 schema 不符（CRC 修正后）→ 解码报参数非法', () => {
    const bytes = encodeConfigBlob(minimalConfig())
    bytes[18] = 0x03 // param_len 偏移；SOLID 应为 4
    fixCrc(bytes)
    let err = null
    try {
      decodeConfigBlob(bytes)
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect(err.code).toBe(ERR.INVALID_PARAMETER)
  })

  test('校验：led_end < led_start → 参数非法', () => {
    const c = minimalConfig()
    c.pins[0].groups[0].ledStart = 5
    c.pins[0].groups[0].ledEnd = 0
    expect(validateConfig(c).code).toBe(ERR.INVALID_PARAMETER)
    expect(() => encodeConfigBlob(c)).toThrow()
  })

  test('校验：未知灯效 → 参数非法', () => {
    const c = minimalConfig()
    c.pins[0].groups[0].steps[0].layers[0].effect = 0x7f
    expect(validateConfig(c).code).toBe(ERR.INVALID_PARAMETER)
  })

  test('校验：时长越界（0 / 61）→ 参数非法', () => {
    const c = minimalConfig()
    c.pins[0].groups[0].steps[0].duration = 0
    expect(validateConfig(c).code).toBe(ERR.INVALID_PARAMETER)
    c.pins[0].groups[0].steps[0].duration = 61
    expect(validateConfig(c).code).toBe(ERR.INVALID_PARAMETER)
  })

  test('校验：图层数为 0 → 配置超限', () => {
    const c = minimalConfig()
    c.pins[0].groups[0].steps[0].layers = []
    expect(validateConfig(c).code).toBe(ERR.CONFIG_LIMIT_EXCEEDED)
  })

  test('校验：灯组数 > 5 → 配置超限', () => {
    const c = minimalConfig()
    const g = c.pins[0].groups[0]
    c.pins[0].groups = []
    for (let i = 0; i < 6; i++) c.pins[0].groups.push(JSON.parse(JSON.stringify(g)))
    expect(validateConfig(c).code).toBe(ERR.CONFIG_LIMIT_EXCEEDED)
  })

  test('校验通过时返回 null', () => {
    expect(validateConfig(minimalConfig())).toBeNull()
  })

  test('校验：pin 索引越界（≥8）→ 参数非法', () => {
    const c = minimalConfig()
    c.pins[0].pin = 8
    expect(validateConfig(c).code).toBe(ERR.INVALID_PARAMETER)
  })

  test('校验：pin 索引重复 → 参数非法', () => {
    const c = minimalConfig()
    const dup = JSON.parse(JSON.stringify(c.pins[0]))
    c.pins.push(dup) // 两个 pin 0
    expect(validateConfig(c).code).toBe(ERR.INVALID_PARAMETER)
  })
})