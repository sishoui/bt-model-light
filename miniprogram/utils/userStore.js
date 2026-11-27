// 用户身份（ADR-0035）：微信登录 → 后端会话 token → 本地快照。
//
// 设计取舍：登录是**可选**的。不登录照常连 BLE、改配置（本地 Storage 是真相源），
// 只是没有云端设备归属同步。这样无网/微信接口故障时小程序不会变砖。
//
// 会话由后端签发（随机串 + DB），不是 JWT：禁用用户要即时生效。

'use strict'

const api = require('./apiClient')
const { logError } = require('./errorHandler')
const telemetry = require('./telemetry')

// 进程内事件：登录态变化时通知页面刷新（不引入状态库，同 ADR-0023）。
const EVENT_KEY = '__btUserListeners'

function _root() {
  return typeof globalThis !== 'undefined' ? globalThis : global
}

function _listeners() {
  const root = _root()
  if (!root[EVENT_KEY]) root[EVENT_KEY] = []
  return root[EVENT_KEY]
}

// 订阅登录态变化（页面 onLoad 订阅，onUnload 退订）。返回退订函数。
function subscribe(fn) {
  const list = _listeners()
  list.push(fn)
  return () => {
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
}

function _emit(user) {
  for (const fn of _listeners().slice()) {
    try {
      fn(user)
    } catch (e) {
      /* 页面回调异常不应影响登录流程 */
    }
  }
}

// ---- 状态读取 --------------------------------------------------------------

function isLoggedIn() {
  return !!api.getToken()
}

// 当前用户（本地快照，可能为 null）。
function currentUser() {
  return api.getUser()
}

// ---- 登录 / 退出 -----------------------------------------------------------

// wx.login 拿 code → 后端 code2Session 换 token + 用户资料。
// 返回 user；失败抛可读 Error（status 已挂好）。
function login() {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined') {
      reject(new Error('userStore requires the wx runtime'))
      return
    }
    wx.login({
      success: (res) => {
        if (!res || !res.code) {
          reject(new Error('微信登录失败：未获取到 code'))
          return
        }
        api
          .request('/auth/wx-login', { method: 'POST', data: { code: res.code } })
          .then((body) => {
            const user = (body && body.user) || null
            api.setToken((body && body.token) || '')
            api.setUser(user)
            telemetry.track('user.login.ok')
            _emit(user)
            resolve(user)
          })
          .catch((err) => {
            logError(err, '微信登录')
            // dim = 后端状态码（400 凭证无效 / 502 微信不可用…），后台能看分布。
            telemetry.track('user.login.fail', { dim: err && err.status ? String(err.status) : '' })
            telemetry.trackError((err && err.code) || 'login', '微信登录')
            reject(err)
          })
      },
      fail: (e) => {
        const err = new Error('微信登录失败，请稍后重试')
        err.status = 0
        err.raw = e
        reject(err)
      },
    })
  })
}

// 退出：先吊销服务端会话（失败也继续清本地，不能把用户锁在已登录态）。
function logout() {
  const had = isLoggedIn()
  return api
    .request('/auth/logout', { method: 'POST' })
    .catch(() => {
      /* 离线/会话已失效：本地照常清 */
    })
    .then(() => {
      api.clearAuth()
      _emit(null)
      return had
    })
}

// ---- 资料 ------------------------------------------------------------------

// 拉服务端资料并刷新本地快照。未登录直接返回 null（不发请求）。
function refreshProfile() {
  if (!isLoggedIn()) return Promise.resolve(null)
  return api.request('/me').then((body) => {
    const user = (body && body.user) || null
    if (user) api.setUser(user)
    else api.clearAuth()
    _emit(user)
    return user
  })
}

// 改昵称/头像。patch: { nickname?, avatar? }（avatar 为 data URL）。
function updateProfile(patch) {
  if (!isLoggedIn()) return Promise.reject(new Error('请先登录'))
  return api.request('/me', { method: 'PATCH', data: patch }).then((body) => {
    const user = (body && body.user) || null
    if (user) api.setUser(user)
    _emit(user)
    return user
  })
}

module.exports = {
  EVENT_KEY,
  isLoggedIn,
  currentUser,
  subscribe,
  login,
  logout,
  refreshProfile,
  updateProfile,
}
