// Jest 单测：miniprogram/utils/errorHandler.js（#28 / T8，ADR-0026）。
//
// 错误码 → 友好提示 + 本地日志（error_log）。覆盖：
//   - friendlyMessage：协议错误码（ERR_*）/ wx 蓝牙错误码 / Error / 未知码兜底
//   - logError / getErrorLog：环形缓冲、上限裁剪、按 context 记录
//   - clearErrorLog：清空
//
// 文案映射消费 protocol_gen 的 ERR（与固件 errors.csv 同源，ADR-0011/0026），
// 故断言用稳定文案字面量而非重算。

'use strict'

const { installWxMock } = require('./wx-mock')
const { ERR } = require('../utils/protocol_gen')
const {
  friendlyMessage,
  logError,
  getErrorLog,
  clearErrorLog,
  ERROR_LOG_KEY,
  ERROR_LOG_MAX,
} = require('../utils/errorHandler')

describe('errorHandler（#28 / ADR-0026）', () => {
  let wx

  beforeEach(() => {
    wx = installWxMock()
    clearErrorLog()
  })

  describe('friendlyMessage：协议错误码 → 友好文案', () => {
    test('每个 ERR_* 码都有非空中文文案（不泄露裸码）', () => {
      for (const name of Object.keys(ERR)) {
        const msg = friendlyMessage(ERR[name])
        expect(typeof msg).toBe('string')
        expect(msg.length).toBeGreaterThan(0)
        // 不应把数字错误码直接抛给用户。
        expect(msg).not.toContain('0x')
      }
    })

    test('CRC 错误 → 数据校验失败类文案', () => {
      expect(friendlyMessage(ERR.CRC_ERROR)).toMatch(/校验|数据/)
    })

    test('不支持命令 → 升级类文案', () => {
      expect(friendlyMessage(ERR.UNSUPPORTED_COMMAND)).toMatch(/不支持|升级|固件/)
    })

    test('配置超限 → 超限类文案', () => {
      expect(friendlyMessage(ERR.CONFIG_LIMIT_EXCEEDED)).toMatch(/超限|上限|超出/)
    })

    test('协议版本不兼容 → 升级类文案', () => {
      expect(friendlyMessage(ERR.PROTOCOL_VERSION_INCOMPATIBLE)).toMatch(/版本|升级/)
    })

    test('未知错误码 → 兜底文案含码值', () => {
      const msg = friendlyMessage(0x7f)
      expect(msg).toMatch(/未知|错误/)
      expect(msg).toContain('127') // 十进制兜底，便于排障
    })
  })

  describe('friendlyMessage：wx / Error 输入', () => {
    test('wx errCode 10001（蓝牙未开）→ 引导开启蓝牙', () => {
      expect(friendlyMessage({ errCode: 10001 })).toMatch(/蓝牙/)
    })

    test('wx 拒绝授权（auth deny）→ 引导去设置开启权限', () => {
      expect(friendlyMessage({ errMsg: 'openBluetoothAdapter:fail auth deny' })).toMatch(/权限|设置|授权/)
    })

    test('Error 实例 → 用其 message', () => {
      expect(friendlyMessage(new Error('连接超时'))).toBe('连接超时')
    })

    test('字符串 → 原样返回', () => {
      expect(friendlyMessage('设备未连接')).toBe('设备未连接')
    })

    test('空 / null → 兜底未知错误文案', () => {
      expect(friendlyMessage(null)).toMatch(/未知|错误/)
      expect(friendlyMessage(undefined)).toMatch(/未知|错误/)
    })
  })

  describe('本地日志 error_log', () => {
    test('logError 写入一条记录（含 context / 文案 / 时间戳）', () => {
      logError(ERR.CRC_ERROR, '下发配置')
      const log = getErrorLog()
      expect(log).toHaveLength(1)
      expect(log[0].context).toBe('下发配置')
      expect(log[0].code).toBe(ERR.CRC_ERROR)
      expect(log[0].message).toMatch(/校验|数据/)
      expect(typeof log[0].ts).toBe('number')
    })

    test('多条记录按时间顺序追加，存 Storage 可回读', () => {
      logError(ERR.CRC_ERROR, 'a')
      logError(ERR.INVALID_STATE, 'b')
      const log = getErrorLog()
      expect(log.map((e) => e.context)).toEqual(['a', 'b'])
      // 已落盘到 error_log（JSON）。
      const raw = wx.getStorageSync(ERROR_LOG_KEY)
      expect(JSON.parse(raw)).toHaveLength(2)
    })

    test('超过上限裁剪最旧记录（环形，保留最近 ERROR_LOG_MAX 条）', () => {
      for (let i = 0; i < ERROR_LOG_MAX + 5; i++) logError(ERR.INTERNAL_ERROR, `e${i}`)
      const log = getErrorLog()
      expect(log).toHaveLength(ERROR_LOG_MAX)
      // 保留的是最近的：最后一条是 e(max+4)。
      expect(log[log.length - 1].context).toBe(`e${ERROR_LOG_MAX + 4}`)
      expect(log[0].context).toBe('e5')
    })

    test('clearErrorLog 清空', () => {
      logError(ERR.CRC_ERROR, 'a')
      clearErrorLog()
      expect(getErrorLog()).toEqual([])
    })

    test('error_log 损坏（非 JSON）按空表容错（ADR-0026）', () => {
      wx.setStorageSync(ERROR_LOG_KEY, '{坏数据')
      expect(getErrorLog()).toEqual([])
    })

    test('logError 不依赖传入 wx：模块内自取全局 wx', () => {
      // 不传 wx 也能写（mobile 运行时只有全局 wx）。
      logError(ERR.INTERNAL_ERROR, '无 wx 参数')
      expect(getErrorLog()).toHaveLength(1)
    })
  })
})