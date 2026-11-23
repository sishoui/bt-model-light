// JS 帧编解码 + 流式重组（ADR-0005 / ADR-0006 / ADR-0012）。
//
// 帧格式: [0xAA][len:2 LE][cmd:1][seq:1][payload:len][crc16:2 LE]
// 整帧 = 7 + len 字节。CRC-16/CCITT (poly 0x1021, init 0xFFFF, 无反射, 无最终异或)
// 覆盖 header..payload，不含 crc16 自身。
//
// 与固件 `firmware/src/protocol_parser.c` 同构：读游标（pos）流式重组、
// 帧头 0xAA 定位、len 上限 FRAME_LEN_MAX(1500)、CRC 校验、未知命令检测。
// 结果码复用 protocol_gen.js 的 ERR_* 值，避免两端漂移。
//
// 仅依赖 ES2017+ 标准 API（Uint8Array / Array），不依赖 wx / Node 内置模块，
// 便于在微信小程序运行时与 Jest(Node) 双端运行。

'use strict'

// 协议常量（codegen 产物，单一真相源见 protocol/*.csv）。
// 注意：protocol_gen.js 用 module.exports，微信运行时与 Jest 均可 require。
const GEN = require('./protocol_gen')

const FRAME = GEN.FRAME
const CMD = GEN.CMD
const ERR = GEN.ERR

const HEADER = FRAME.header // 0xAA
const LEN_MAX = FRAME.lenMax // 1500
const OVERHEAD = FRAME.overhead // 7

// ---- 结果码（与 firmware/src/protocol_parser.h 的 parse_result_t 对齐）------
// 0 == 成功。非零值复用 ERR_* 表（ADR-0026），parser-local 状态另立。
const PARSE_OK = 0
const PARSE_INCOMPLETE = 1 // 需要更多字节（半帧，parser-local）
const PARSE_INVALID_CRC = ERR.CRC_ERROR // 0x01
const PARSE_UNKNOWN_COMMAND = ERR.UNSUPPORTED_COMMAND // 0x02
const PARSE_LEN_OVERFLOW = ERR.INVALID_PARAMETER // 0x04 (len > LEN_MAX)
const PARSE_BUFFER_OVERFLOW = ERR.BUFFER_OVERFLOW // 0x06
const PARSE_NO_HEADER = ERR.INTERNAL_ERROR // 0x07 (缓冲内无 0xAA；parser-local)

// ---- 已知命令码集合（未知命令检测用） -------------------------------------
// 与 firmware 的 CMD_TABLE 对齐：commands.csv 的全部命令。
const KNOWN_CMDS = new Set(Object.values(CMD))

// ---------------------------------------------------------------------------
// CRC-16/CCITT (poly 0x1021, init 0xFFFF, MSB 优先, 无最终异或)
// data 支持 Uint8Array / Array / ArrayBuffer 视图（按字节索引取值）。
// ---------------------------------------------------------------------------
function crc16Ccitt(data) {
  let crc = 0xffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8
    crc &= 0xffff
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return crc
}

// ---------------------------------------------------------------------------
// 编码：把 (cmd, seq, payload) 编成一帧，返回 Uint8Array。
// 不校验 cmd 是否在已知表中——编码侧保持薄，交给固件/解析侧裁决。
// ---------------------------------------------------------------------------
function encodeFrame(cmd, seq, payload) {
  const bytes = payload ? payload : []
  const len = bytes.length
  if (len > LEN_MAX) {
    throw new RangeError(`payload length ${len} exceeds frame cap ${LEN_MAX}`)
  }
  const frame = new Uint8Array(OVERHEAD + len)
  frame[0] = HEADER
  frame[1] = len & 0xff
  frame[2] = (len >> 8) & 0xff
  frame[3] = cmd & 0xff
  frame[4] = seq & 0xff
  for (let i = 0; i < len; i++) {
    frame[5 + i] = bytes[i] & 0xff
  }
  // CRC 覆盖 header..payload = 前 5+len 字节。
  const crc = crc16Ccitt(frame.subarray(0, 5 + len))
  frame[5 + len] = crc & 0xff
  frame[6 + len] = (crc >> 8) & 0xff
  return frame
}

// ---------------------------------------------------------------------------
// 一次性解析：从单个缓冲区解析完整帧（对应固件 parser_parse_one）。
// out 可选；填充 { cmd, seq, len, payload(Uint8Array 拷贝) }。
// 返回 PARSE_OK 或错误码。
// ---------------------------------------------------------------------------
function decodeFrame(data, out) {
  const n = data.length
  // 与 firmware parser_parse_one 一致：先判整帧 overhead，再判帧头，再读 len。
  if (n < OVERHEAD) {
    return PARSE_INCOMPLETE
  }
  if (data[0] !== HEADER) {
    return PARSE_NO_HEADER
  }
  const payloadLen = data[1] | (data[2] << 8)
  if (payloadLen > LEN_MAX) {
    return PARSE_LEN_OVERFLOW
  }
  const total = OVERHEAD + payloadLen
  if (n < total) {
    return PARSE_INCOMPLETE
  }
  const cmd = data[3]
  const seq = data[4]
  const crcHiLo = data[5 + payloadLen] | (data[6 + payloadLen] << 8)
  const crcCalc = crc16Ccitt(data.subarray(0, 5 + payloadLen))
  if (crcCalc !== crcHiLo) {
    return PARSE_INVALID_CRC
  }
  if (!KNOWN_CMDS.has(cmd)) {
    return PARSE_UNKNOWN_COMMAND
  }
  if (out) {
    out.cmd = cmd
    out.seq = seq
    out.len = payloadLen
    out.payload = data.slice(5, 5 + payloadLen) // 拷贝，避免缓冲区复用踩坑
  }
  return PARSE_OK
}

// ---------------------------------------------------------------------------
// 流式重组（对应固件 parser_t + parser_feed/parser_next，ADR-0006）。
//
// 接收端按字节流喂入，不假定 BLE 分包边界。维护一个读游标 pos：
//   - buf 保存已喂入的全部字节，未读区间为 [pos, buf.length)
//   - feed() 先丢弃已消费前缀（等价 C 的 compaction），再追加新字节
//   - next() 从 pos 起找 0xAA 帧头，读 len、校验上限、等齐整帧、验 CRC、
//     校验命令已知，命中则前进 pos 并填充 out；否则按错误码返回
//
// 设计说明：JS 侧 payload 一律拷贝返回（Uint8Array），比 C 的"指针有效期到
// 下次 feed/next"语义更安全，避免调用方在缓冲复用后读到脏数据。
// ---------------------------------------------------------------------------
class FrameParser {
  constructor() {
    this._buf = []
    this.pos = 0 // 读游标：[0, pos) 已消费
  }

  // 已缓冲字节数（含已消费前缀，用于诊断；未读字节数 = buf.length - pos）。
  get len() {
    return this._buf.length
  }

  // 尚未消费的字节数。
  get pending() {
    return this._buf.length - this.pos
  }

  // 丢弃已消费前缀，清空缓冲。
  reset() {
    this._buf = []
    this.pos = 0
  }

  // 喂入字节。data 支持 Uint8Array / Array。
  feed(data) {
    // 先丢弃已消费前缀，保持缓冲紧凑（对应 C 的 parser_compact）。
    if (this.pos > 0) {
      this._buf = this._buf.slice(this.pos)
      this.pos = 0
    }
    const limit = OVERHEAD + LEN_MAX + 1 // 与固件 PARSER_BUF_SIZE (FRAME_TOTAL_MAX + 1) 对齐
    if (this._buf.length + data.length > limit) {
      return PARSE_BUFFER_OVERFLOW
    }
    for (let i = 0; i < data.length; i++) {
      this._buf.push(data[i] & 0xff)
    }
    return PARSE_OK
  }

  // 尝试从缓冲提取一帧。
  // 返回 PARSE_OK 并填充 out；或 PARSE_INCOMPLETE / 错误码。
  next(out) {
    const buf = this._buf
    const n = buf.length

    // 步骤 1：从 pos 找 0xAA 帧头。
    let headerPos = this.pos
    while (headerPos < n && buf[headerPos] !== HEADER) {
      headerPos++
    }
    if (headerPos >= n) {
      // 缓冲 [pos, n) 内无 0xAA：保留末尾一个 0xAA（可能是半个帧头），其余丢弃。
      if (n > this.pos && buf[n - 1] === HEADER) {
        this.pos = n - 1
      } else {
        this.pos = n
      }
      return PARSE_NO_HEADER
    }
    this.pos = headerPos

    // 步骤 2：至少 3 字节（帧头 + 2 字节 len）才能读 len。
    if (this.pos + 3 > n) {
      return PARSE_INCOMPLETE
    }

    // 步骤 3：读 len（LE），校验上限。
    const payloadLen = buf[this.pos + 1] | (buf[this.pos + 2] << 8)
    if (payloadLen > LEN_MAX) {
      // 丢弃这个候选帧头（1 字节）后重试。
      this.pos++
      return PARSE_LEN_OVERFLOW
    }

    // 步骤 4：等齐整帧 = 7 + len 字节。
    const total = OVERHEAD + payloadLen
    if (this.pos + total > n) {
      return PARSE_INCOMPLETE
    }

    const cmd = buf[this.pos + 3]
    const seq = buf[this.pos + 4]
    const payloadStart = this.pos + 5
    const crcHiLo =
      buf[payloadStart + payloadLen] | (buf[payloadStart + payloadLen + 1] << 8)
    const crcCalc = crc16Ccitt(buf.slice(this.pos, payloadStart + payloadLen))

    // 消费整帧（无论 CRC/命令对错，字节都不回退）。
    const payloadCopy = buf.slice(payloadStart, payloadStart + payloadLen)
    this.pos += total

    // 步骤 5：校验 CRC。
    if (crcCalc !== crcHiLo) {
      return PARSE_INVALID_CRC
    }
    // 步骤 6：未知命令检测。
    if (!KNOWN_CMDS.has(cmd)) {
      return PARSE_UNKNOWN_COMMAND
    }

    if (out) {
      out.cmd = cmd
      out.seq = seq
      out.len = payloadLen
      out.payload = payloadCopy
    }
    return PARSE_OK
  }
}

// ---------------------------------------------------------------------------
// 便捷工具：判断是否已知命令（对应固件 parser_cmd_known）。
// ---------------------------------------------------------------------------
function isKnownCmd(cmd) {
  return KNOWN_CMDS.has(cmd)
}

module.exports = {
  // 常量
  HEADER,
  LEN_MAX,
  OVERHEAD,
  // 结果码
  PARSE_OK,
  PARSE_INCOMPLETE,
  PARSE_INVALID_CRC,
  PARSE_UNKNOWN_COMMAND,
  PARSE_LEN_OVERFLOW,
  PARSE_BUFFER_OVERFLOW,
  PARSE_NO_HEADER,
  // 纯函数
  crc16Ccitt,
  encodeFrame,
  decodeFrame,
  isKnownCmd,
  // 流式重组
  FrameParser,
}