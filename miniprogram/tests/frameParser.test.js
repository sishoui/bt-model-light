// Jest 单测：miniprogram/utils/frameParser.js（ADR-0005 / 0006 / 0012）。
//
// 覆盖：
//   - CRC-16/CCITT 已知向量（"123456789" = 0x29B1）
//   - encodeFrame 编解码往返
//   - decodeFrame 一次性解析：合法帧 / 坏 CRC / 未知命令 / 半帧 / 无帧头 / len 超限
//   - FrameParser 流式重组：单帧 / 逐字节 / 一次两帧 / 帧前垃圾 / 坏帧+好帧 / len=1500 / len=1501
//   - isKnownCmd
//
// 注意：帧内容与固件 Unity 单测（firmware/test/test_protocol_parser/）同构，
// 两端用同一套向量，避免两端漂移。

'use strict'

const {
  HEADER,
  LEN_MAX,
  OVERHEAD,
  PARSE_OK,
  PARSE_INCOMPLETE,
  PARSE_INVALID_CRC,
  PARSE_UNKNOWN_COMMAND,
  PARSE_LEN_OVERFLOW,
  PARSE_BUFFER_OVERFLOW,
  PARSE_NO_HEADER,
  crc16Ccitt,
  encodeFrame,
  decodeFrame,
  isKnownCmd,
  FrameParser,
} = require('../utils/frameParser')
const { CMD } = require('../utils/protocol_gen')

// 独立构造一个合法帧的字节序列（不依赖被测 encodeFrame，避免重复逻辑掩盖漂移）。
// 仅用于生成测试向量；如果 encodeFrame 与手工构造不一致，应让测试失败而不是被掩盖。
function buildFrameBytes(cmd, seq, payload) {
  const bytes = payload || []
  const frame = new Uint8Array(OVERHEAD + bytes.length)
  frame[0] = HEADER
  frame[1] = bytes.length & 0xff
  frame[2] = (bytes.length >> 8) & 0xff
  frame[3] = cmd
  frame[4] = seq
  for (let i = 0; i < bytes.length; i++) frame[5 + i] = bytes[i]
  // 独立实现 CRC（不复用 frameParser.crc16Ccitt），形成对 encodeFrame 的独立检验。
  let crc = 0xffff
  for (let i = 0; i < 5 + bytes.length; i++) {
    crc ^= frame[i] << 8
    crc &= 0xffff
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  frame[5 + bytes.length] = crc & 0xff
  frame[6 + bytes.length] = (crc >> 8) & 0xff
  return frame
}

// 把 Uint8Array 切成给定长度的分片，模拟任意 BLE 分包。
function splitIntoChunks(arr, sizes) {
  const chunks = []
  let offset = 0
  let i = 0
  while (offset < arr.length) {
    const size = Math.min(sizes[i % sizes.length], arr.length - offset)
    chunks.push(arr.slice(offset, offset + size))
    offset += size
    i++
  }
  return chunks
}

describe('crc16Ccitt', () => {
  test('已知向量 "123456789" = 0x29B1 (CRC-16/CCITT-FALSE)', () => {
    const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])
    expect(crc16Ccitt(data)).toBe(0x29b1)
  })

  test('空输入 = 0xFFFF (init 值)', () => {
    expect(crc16Ccitt(new Uint8Array(0))).toBe(0xffff)
  })

  test('数组字面量与 Uint8Array 结果一致', () => {
    expect(crc16Ccitt([1, 2, 3, 4])).toBe(crc16Ccitt(new Uint8Array([1, 2, 3, 4])))
  })
})

describe('encodeFrame / decodeFrame 往返', () => {
  test('GET_VERSION 无 payload 往返', () => {
    const frame = encodeFrame(CMD.GET_VERSION, 7)
    const out = {}
    expect(decodeFrame(frame, out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.GET_VERSION)
    expect(out.seq).toBe(7)
    expect(out.len).toBe(0)
    expect(out.payload.length).toBe(0)
  })

  test('WRITE_CONFIG 带 payload 往返', () => {
    const payload = [0xde, 0xad, 0xbe, 0xef]
    const frame = encodeFrame(CMD.WRITE_CONFIG, 1, payload)
    const out = {}
    expect(decodeFrame(frame, out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.WRITE_CONFIG)
    expect(out.seq).toBe(1)
    expect(out.len).toBe(4)
    expect(Array.from(out.payload)).toEqual(payload)
  })

  test('encode 输出的帧头与 len 字段正确', () => {
    const frame = encodeFrame(CMD.STOP, 0, [0x11, 0x22, 0x33])
    expect(frame[0]).toBe(HEADER)
    expect(frame[1]).toBe(3) // len LE 低字节
    expect(frame[2]).toBe(0) // len LE 高字节
    expect(frame[3]).toBe(CMD.STOP)
    expect(frame[4]).toBe(0) // seq
    expect(frame.length).toBe(OVERHEAD + 3)
  })

  test('encodeFrame 与独立 buildFrameBytes 字节一致（互检）', () => {
    const cases = [
      [CMD.GET_VERSION, 0, []],
      [CMD.WRITE_CONFIG, 1, [0xde, 0xad, 0xbe, 0xef]],
      [CMD.READ_STATUS, 9, [1, 2, 3, 4, 5]],
    ]
    for (const [cmd, seq, payload] of cases) {
      const a = encodeFrame(cmd, seq, payload)
      const b = buildFrameBytes(cmd, seq, payload)
      expect(Array.from(a)).toEqual(Array.from(b))
    }
  })

  test('encode payload 超 1500 抛 RangeError', () => {
    const big = new Uint8Array(LEN_MAX + 1)
    expect(() => encodeFrame(CMD.WRITE_CONFIG, 0, big)).toThrow(/exceeds frame cap/)
  })
})

describe('decodeFrame 一次性解析错误路径', () => {
  test('坏 CRC → PARSE_INVALID_CRC', () => {
    const frame = encodeFrame(CMD.GET_VERSION, 0)
    frame[frame.length - 1] ^= 0xff // 破坏 CRC 低字节
    const out = {}
    expect(decodeFrame(frame, out)).toBe(PARSE_INVALID_CRC)
    expect(out.cmd).toBeUndefined() // 不填充
  })

  test('未知命令 → PARSE_UNKNOWN_COMMAND', () => {
    const frame = encodeFrame(0x55, 0) // 0x55 不在命令表
    const out = {}
    expect(decodeFrame(frame, out)).toBe(PARSE_UNKNOWN_COMMAND)
  })

  test('半帧 → PARSE_INCOMPLETE', () => {
    const frame = encodeFrame(CMD.GET_VERSION, 0)
    const out = {}
    // 缺最后 1 字节（CRC 高字节）
    expect(decodeFrame(frame.slice(0, frame.length - 1), out)).toBe(PARSE_INCOMPLETE)
    // 只剩 header + len 低 + len 高（3 字节）
    expect(decodeFrame(frame.slice(0, 3), out)).toBe(PARSE_INCOMPLETE)
    // 空
    expect(decodeFrame(new Uint8Array(0), out)).toBe(PARSE_INCOMPLETE)
  })

  test('无帧头 → PARSE_NO_HEADER', () => {
    const frame = encodeFrame(CMD.GET_VERSION, 0)
    frame[0] = 0x00
    const out = {}
    expect(decodeFrame(frame, out)).toBe(PARSE_NO_HEADER)
  })

  test('len 超 1500 → PARSE_LEN_OVERFLOW', () => {
    // 帧头 + len=1501 (LE: 0xDD, 0x05) + 补齐到 7 字节最小帧
    // decodeFrame 与 firmware parser_parse_one 一致：先判整帧 overhead，再判 len。
    const bogus = new Uint8Array([HEADER, 0xdd, 0x05, 0x00, 0x00, 0x00, 0x00])
    const out = {}
    expect(decodeFrame(bogus, out)).toBe(PARSE_LEN_OVERFLOW)
  })
})

describe('FrameParser 流式重组', () => {
  test('单帧一次 feed 解析成功', () => {
    const frame = buildFrameBytes(CMD.READ_STATUS, 42, [])
    const p = new FrameParser()
    expect(p.feed(frame)).toBe(PARSE_OK)
    const out = {}
    expect(p.next(out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.READ_STATUS)
    expect(out.seq).toBe(42)
    expect(out.len).toBe(0)
  })

  test('逐字节 feed 也能重组（任意 BLE 分包）', () => {
    const frame = buildFrameBytes(CMD.APPLY, 9, [1, 2, 3])
    const p = new FrameParser()
    const out = {}
    let result = PARSE_INCOMPLETE
    for (let i = 0; i < frame.length; i++) {
      expect(p.feed(frame.slice(i, i + 1))).toBe(PARSE_OK)
      result = p.next(out)
      if (i + 1 < frame.length) {
        expect(result).toBe(PARSE_INCOMPLETE)
      }
    }
    expect(result).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.APPLY)
    expect(out.seq).toBe(9)
    expect(out.len).toBe(3)
    expect(Array.from(out.payload)).toEqual([1, 2, 3])
  })

  test('随机分片序列能还原完整帧', () => {
    const payload = []
    for (let i = 0; i < 40; i++) payload.push(i & 0xff)
    const frame = buildFrameBytes(CMD.WRITE_CONFIG, 5, payload)
    const chunks = splitIntoChunks(frame, [1, 3, 7, 2, 5])
    const p = new FrameParser()
    const out = {}
    let result = PARSE_INCOMPLETE
    for (const chunk of chunks) {
      expect(p.feed(chunk)).toBe(PARSE_OK)
      result = p.next(out)
    }
    expect(result).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.WRITE_CONFIG)
    expect(out.seq).toBe(5)
    expect(out.len).toBe(40)
    expect(Array.from(out.payload)).toEqual(payload)
  })

  test('一次 feed 两帧：payload 不被覆盖（读游标设计回归）', () => {
    const payload1 = [0x11, 0x22, 0x33, 0x44]
    const frame1 = buildFrameBytes(CMD.WRITE_CONFIG, 1, payload1)
    const frame2 = buildFrameBytes(CMD.READ_STATUS, 2, [])
    const stream = new Uint8Array(frame1.length + frame2.length)
    stream.set(frame1, 0)
    stream.set(frame2, frame1.length)

    const p = new FrameParser()
    expect(p.feed(stream)).toBe(PARSE_OK)
    const out = {}
    // 第一帧带 payload
    expect(p.next(out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.WRITE_CONFIG)
    expect(out.seq).toBe(1)
    expect(Array.from(out.payload)).toEqual(payload1)
    // 第二帧
    expect(p.next(out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.READ_STATUS)
    expect(out.seq).toBe(2)
    // 无更多帧
    expect(p.next(out)).toBe(PARSE_NO_HEADER)
  })

  test('帧前有垃圾字节被跳过', () => {
    const frame = buildFrameBytes(CMD.GET_VERSION, 3, [])
    const p = new FrameParser()
    // 垃圾前缀 0x00 0x11
    expect(p.feed(new Uint8Array([0x00, 0x11]))).toBe(PARSE_OK)
    expect(p.feed(frame)).toBe(PARSE_OK)
    const out = {}
    expect(p.next(out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.GET_VERSION)
    expect(out.seq).toBe(3)
  })

  test('坏 CRC 帧被丢弃后能解析下一好帧', () => {
    const bad = buildFrameBytes(CMD.GET_VERSION, 5, [])
    bad[bad.length - 1] ^= 0xff // 破坏 CRC
    const good = buildFrameBytes(CMD.READ_STATUS, 6, [])
    const p = new FrameParser()
    expect(p.feed(bad)).toBe(PARSE_OK)
    expect(p.feed(good)).toBe(PARSE_OK)
    const out = {}
    // 第一帧 CRC 坏，被丢弃
    expect(p.next(out)).toBe(PARSE_INVALID_CRC)
    // 第二帧好
    expect(p.next(out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.READ_STATUS)
    expect(out.seq).toBe(6)
  })

  test('未知命令帧被丢弃后能解析下一好帧', () => {
    const unknown = buildFrameBytes(0x55, 1, [])
    const good = buildFrameBytes(CMD.STOP, 2, [])
    const p = new FrameParser()
    expect(p.feed(unknown)).toBe(PARSE_OK)
    expect(p.feed(good)).toBe(PARSE_OK)
    const out = {}
    expect(p.next(out)).toBe(PARSE_UNKNOWN_COMMAND)
    expect(p.next(out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.STOP)
    expect(out.seq).toBe(2)
  })

  test('len = 1500 的合法帧可解析', () => {
    const payload = new Uint8Array(LEN_MAX)
    for (let i = 0; i < LEN_MAX; i++) payload[i] = i & 0xff
    const frame = buildFrameBytes(CMD.WRITE_CONFIG, 0x42, payload)
    const p = new FrameParser()
    expect(p.feed(frame)).toBe(PARSE_OK)
    const out = {}
    expect(p.next(out)).toBe(PARSE_OK)
    expect(out.cmd).toBe(CMD.WRITE_CONFIG)
    expect(out.seq).toBe(0x42)
    expect(out.len).toBe(LEN_MAX)
    expect(out.payload[0]).toBe(0)
    expect(out.payload[LEN_MAX - 1]).toBe((LEN_MAX - 1) & 0xff)
  })

  test('len = 1501 被拒绝为 LEN_OVERFLOW，帧头丢弃', () => {
    const bogus = new Uint8Array([HEADER, 0xdd, 0x05]) // len = 1501
    const p = new FrameParser()
    expect(p.feed(bogus)).toBe(PARSE_OK)
    const out = {}
    expect(p.next(out)).toBe(PARSE_LEN_OVERFLOW)
    // 帧头字节被丢弃（pos 前移 1）
    expect(p.pos).toBe(1)
  })

  test('feed 超过单帧上限返回 BUFFER_OVERFLOW', () => {
    const p = new FrameParser()
    const tooBig = new Uint8Array(OVERHEAD + LEN_MAX + 16) // 超过 1507
    expect(p.feed(tooBig)).toBe(PARSE_BUFFER_OVERFLOW)
  })

  test('reset 清空缓冲', () => {
    const frame = buildFrameBytes(CMD.GET_VERSION, 0)
    const p = new FrameParser()
    expect(p.feed(frame)).toBe(PARSE_OK)
    expect(p.pending).toBe(frame.length)
    p.reset()
    expect(p.pending).toBe(0)
    expect(p.pos).toBe(0)
  })
})

describe('isKnownCmd', () => {
  test('已知命令返回 true', () => {
    expect(isKnownCmd(CMD.GET_VERSION)).toBe(true)
    expect(isKnownCmd(CMD.WRITE_CONFIG)).toBe(true)
    expect(isKnownCmd(CMD.OTA)).toBe(true) // OTA 预留但已在命令表
  })

  test('未知命令返回 false', () => {
    expect(isKnownCmd(0x55)).toBe(false)
    expect(isKnownCmd(0x00)).toBe(false)
  })
})