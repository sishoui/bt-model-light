// 后端 API 客户端（ADR-0035）：小程序与 bt-model-light 后端之间唯一的网络出口。
//
// 与 otaClient 的分工：
//   - otaClient 用 wx.downloadFile 拉二进制镜像（大文件、要拿 tempFilePath）；
//   - 这里用 wx.request 打 JSON API（登录、资料、设备归属）。
//
// 基地址优先级：Storage `bt_api_base_url` → DEFAULT_BASE_URL。
// 与 `bt_firmware_base_url` 同一个覆盖机制：换域名/换环境只改 Storage，不动代码。
//
// 错误契约：后端返回 { error: { code, message } }；这里把 message 当 Error.message
// 抛出（页面直接展示），并把 status 挂在 err.status 上供调用方分流（401 → 清 token）。
//
// 仅依赖 ES2017 + 全局 wx（不 import wx），Jest 通过 wx-mock 注入。

'use strict'

// 开发期用 HTTP + IP：微信"体验版/正式版"要求 HTTPS + 备案域名，
// IP 直连只在开发者工具与"真机调试"下可用（与 ADR-0034 §9 同一限制）。
const DEFAULT_BASE_URL = 'http://117.72.163.247/api'
const BASE_URL_KEY = 'bt_api_base_url'

const TOKEN_KEY = 'bt_auth_token'
const USER_KEY = 'bt_user'

// 请求超时：登录要等微信侧，给宽一点；其它接口正常 <200ms。
const TIMEOUT_MS = 15000

function _wx() {
  if (typeof wx === 'undefined') {
    throw new Error('apiClient requires the wx runtime (call it inside miniprogram or install wx-mock in tests)')
  }
  return wx
}

// 去掉末尾斜杠，避免拼出 `//auth/wx-login`。
function normalizeBaseUrl(url) {
  const s = String(url || '').trim()
  return s ? s.replace(/\/+$/, '') : ''
}

// 当前基地址：Storage 覆盖优先，空值回落默认。
function getBaseUrl() {
  const override = normalizeBaseUrl(_wx().getStorageSync(BASE_URL_KEY))
  return override || DEFAULT_BASE_URL
}

function setBaseUrl(url) {
  const s = normalizeBaseUrl(url)
  if (s) _wx().setStorageSync(BASE_URL_KEY, s)
  else _wx().removeStorageSync(BASE_URL_KEY)
  return getBaseUrl()
}

// ---- token / 用户快照 -------------------------------------------------------

function getToken() {
  const raw = _wx().getStorageSync(TOKEN_KEY)
  return typeof raw === 'string' ? raw : ''
}

function setToken(token) {
  if (token) _wx().setStorageSync(TOKEN_KEY, String(token))
  else _wx().removeStorageSync(TOKEN_KEY)
}

// 缓存的用户资料（离线时「我的」页仍能显示头像昵称）。
// 读不到/损坏返回 null（Storage 容错，同 deviceStore 的处理）。
function getUser() {
  const raw = _wx().getStorageSync(USER_KEY)
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.id ? parsed : null
  } catch (e) {
    return null
  }
}

function setUser(user) {
  if (user && user.id) _wx().setStorageSync(USER_KEY, JSON.stringify(user))
  else _wx().removeStorageSync(USER_KEY)
}

function clearAuth() {
  setToken('')
  setUser(null)
}

// ---- 核心请求 --------------------------------------------------------------

// 把 fetch 风格调用收敛成 Promise<data>；失败抛 Error（带 status / code）。
function request(path, opts) {
  const options = opts || {}
  const method = String(options.method || 'GET').toUpperCase()
  const url = getBaseUrl() + (path.charAt(0) === '/' ? path : '/' + path)
  const token = getToken()

  return new Promise((resolve, reject) => {
    _wx().request({
      url,
      method,
      data: options.data,
      timeout: options.timeout || TIMEOUT_MS,
      header: Object.assign(
        { 'content-type': 'application/json' },
        token ? { authorization: `Bearer ${token}` } : {},
        options.header || {}
      ),
      success: (res) => {
        const status = res.statusCode || 0
        const body = _parseBody(res.data)
        if (status >= 200 && status < 300) {
          resolve(body)
          return
        }
        const message =
          (body && body.error && body.error.message) || `请求失败（HTTP ${status}）`
        const err = new Error(message)
        err.status = status
        err.code = (body && body.error && body.error.code) || ''
        // 401 = token 失效/被禁用：清掉本地凭据，页面据此显示未登录。
        if (status === 401) clearAuth()
        reject(err)
      },
      fail: (e) => {
        const err = new Error(_networkMessage(e))
        err.status = 0
        reject(err)
      },
    })
  })
}

// wx.request 的 data 在 JSON content-type 下已是对象；字符串（老版本/异常）再解析一次。
function _parseBody(data) {
  if (!data) return null
  if (typeof data === 'object') return data
  try {
    return JSON.parse(data)
  } catch (e) {
    return null
  }
}

// 网络层失败 → 中文文案（与 errorHandler 的口径一致：绝不把 errMsg 原文丢给用户）。
function _networkMessage(e) {
  const raw = String((e && (e.errMsg || e.message)) || '')
  if (/timeout/i.test(raw)) return '网络超时，请稍后重试'
  if (/domain|合法域名|url not in/i.test(raw)) return '服务器域名未配置，请在微信后台添加 request 合法域名'
  return '网络不可用，请检查手机网络后重试'
}

module.exports = {
  DEFAULT_BASE_URL,
  BASE_URL_KEY,
  TOKEN_KEY,
  USER_KEY,
  TIMEOUT_MS,
  getBaseUrl,
  setBaseUrl,
  getToken,
  setToken,
  getUser,
  setUser,
  clearAuth,
  request,
}
