// 错误处理：协议/wx 错误码 → 友好文案 + 本地日志（ADR-0026 / #28 / T8）。
//
// 两个职责：
//   1. friendlyMessage(err)：把各种错误输入（协议 ERR_* 码 / wx 蓝牙错误对象 /
//      Error / 字符串）归一成一句给用户的中文提示，绝不把裸错误码抛给用户。
//   2. 本地日志：logError/getErrorLog/clearErrorLog，关键错误写入 Storage
//      (error_log) 环形缓冲，便于现场排障（Storage 上限内自裁剪）。
//
// 文案表消费 protocol_gen 的 ERR（与固件 errors.csv 同源，ADR-0011），
// 不手写错误码数值。仅依赖 ES2017+ 标准 API 与全局 wx（不 import wx），
// Jest 通过 wx-mock 注入（与 deviceStore/frameParser 同约束，双端运行）。

'use strict'

const { ERR } = require('./protocol_gen')

// 本地日志 Storage 键与环形缓冲上限（真机 Storage 上限 10MB，这里按条数裁剪）。
const ERROR_LOG_KEY = 'error_log'
const ERROR_LOG_MAX = 50

// 协议错误码 → 友好文案。键用 ERR 的数值（反查），值用稳定中文文案。
// 文案面向用户：说清"发生了什么 / 怎么办"，不暴露协议细节。
const PROTOCOL_MESSAGES = {
  [ERR.CRC_ERROR]: '数据校验失败，请重试',
  [ERR.UNSUPPORTED_COMMAND]: '设备固件不支持该操作，请升级固件',
  [ERR.CONFIG_LIMIT_EXCEEDED]: '配置超出设备上限（灯珠/灯组/步骤/图层过多）',
  [ERR.INVALID_PARAMETER]: '参数无效，请检查后重试',
  [ERR.INVALID_STATE]: '设备当前状态不支持该操作',
  [ERR.BUFFER_OVERFLOW]: '数据量过大，设备无法处理',
  [ERR.INTERNAL_ERROR]: '设备内部错误，请重启设备后重试',
  [ERR.PROTOCOL_VERSION_INCOMPATIBLE]: '协议版本不兼容，请升级小程序或固件',
}

// wx 蓝牙错误码 → 友好文案（常见系统/权限路径，真机 smoke 覆盖，ADR-0026）。
const WX_MESSAGES = {
  10001: '请先开启手机蓝牙',
  10009: '设备连接失败，请靠近后重试',
  10012: '连接超时，请重试',
  10002: '未找到设备，请确认设备已开机',
}

// 从 wx 错误对象提取错误码。优先信任结构化 errCode 字段；
// 不从 errMsg 正则抠数字（errMsg 可能含 UUID 等无关长数字，会误映射）。
function _wxErrCode(err) {
  if (!err || typeof err !== 'object') return null
  return typeof err.errCode === 'number' ? err.errCode : null
}

// 核心：任意错误输入 → 友好文案。纯函数（除读取 protocol_gen 常量外无副作用）。
function friendlyMessage(err) {
  // 1. 协议错误码（数字）。
  if (typeof err === 'number' && Number.isFinite(err)) {
    return PROTOCOL_MESSAGES[err] || `未知错误（错误码 ${err}）`
  }
  // 2. 字符串：已是文案，原样返回。
  if (typeof err === 'string' && err) return err
  // 3. Error 实例：用其 message。
  if (err instanceof Error) return err.message || '未知错误'
  // 4. wx 错误对象：优先 errMsg 文案，其次按错误码映射。
  if (err && typeof err === 'object') {
    const code = _wxErrCode(err)
    if (code && WX_MESSAGES[code]) return WX_MESSAGES[code]
    const errMsg = String(err.errMsg || '')
    if (errMsg) {
      // 权限拒绝：引导去设置开启（真机常见路径）。
      if (/auth|deny|permission|authoriz/i.test(errMsg)) {
        return '请在设置中允许蓝牙与相关权限后重试'
      }
      // 去掉 "apiName:fail" 前缀，给一个不泄露内部调用名的兜底。
      return `操作失败（${errMsg.replace(/^[\w]+:fail\s*/, '') || '未知原因'}）`
    }
    if (err.message) return err.message
  }
  // 5. 兜底。
  return '未知错误'
}

// 取全局 wx；缺失返回 null（与 deviceStore 的 _wx throw 不同：日志是尽力而为，
// 无 wx 时静默降级而非崩溃）。
function _wxOrNull() {
  if (typeof wx === 'undefined') return null
  return wx
}

// 读本地日志（容错：损坏/缺失 → 空数组）。
function getErrorLog() {
  const wx = _wxOrNull()
  if (!wx) return []
  const raw = wx.getStorageSync(ERROR_LOG_KEY)
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

// 写一条错误日志（环形：超上限裁最旧）。context 标注发生场景（如"下发配置"）。
function logError(err, context) {
  const wx = _wxOrNull()
  const entry = {
    ts: Date.now(),
    context: context || '',
    code: typeof err === 'number' ? err : _wxErrCode(err),
    message: friendlyMessage(err),
  }
  if (!wx) return entry
  const log = getErrorLog()
  log.push(entry)
  while (log.length > ERROR_LOG_MAX) log.shift()
  wx.setStorageSync(ERROR_LOG_KEY, JSON.stringify(log))
  return entry
}

function clearErrorLog() {
  const wx = _wxOrNull()
  if (wx) wx.removeStorageSync(ERROR_LOG_KEY)
}

module.exports = {
  ERROR_LOG_KEY,
  ERROR_LOG_MAX,
  friendlyMessage,
  logError,
  getErrorLog,
  clearErrorLog,
  // 导出文案表便于测试/复用（如 home 版本不兼容弹窗复用）。
  PROTOCOL_MESSAGES,
  WX_MESSAGES,
}