// 后台 API 客户端：token 存 localStorage，401 直接回登录页。
//
// 与小程序 utils/apiClient.js 是两套（不同运行时），但错误体契约一致：
// 失败时后端返回 { error: { code, message } }，这里只把 message 抛给界面。

const TOKEN_KEY = 'bt_admin_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  let url = '/api' + path
  if (query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v)
    }
    const s = qs.toString()
    if (s) url += '?' + s
  }

  const headers = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new ApiError('网络错误，请检查后端是否已启动', 0, 'NETWORK')
  }

  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch (_e) {
      payload = null
    }
  }

  if (!res.ok) {
    const message = (payload && payload.error && payload.error.message) || `请求失败（HTTP ${res.status}）`
    if (res.status === 401) setToken('')
    throw new ApiError(message, res.status, payload && payload.error && payload.error.code)
  }
  return payload
}

export const admin = {
  login: (username, password) => api('/admin/login', { method: 'POST', body: { username, password } }),
  logout: () => api('/admin/logout', { method: 'POST' }),
  overview: (query) => api('/admin/overview', { query }),
  counts: () => api('/admin/counts'),
  users: (query) => api('/admin/users', { query }),
  setUserStatus: (id, status) => api(`/admin/users/${id}`, { method: 'PATCH', body: { status } }),
  devices: (query) => api('/admin/devices', { query }),
  deleteDevice: (id) => api(`/admin/devices/${id}`, { method: 'DELETE' }),
  audit: (query) => api('/admin/audit', { query }),
  telemetry: (query) => api('/admin/telemetry', { query }),
  errors: (query) => api('/admin/errors', { query }),
  metrics: () => api('/telemetry/metrics'),
  rollup: (day) => api('/admin/rollup', { method: 'POST', body: day ? { day } : {} }),
}
