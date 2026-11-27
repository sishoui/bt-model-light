// 后端配置：全部来自环境变量（部署时写 /etc/bt-light/api.env，见 backend_deploy.py）。
//
// 密钥只在这里读，永远不写日志、不进错误文案、不回显给客户端。

'use strict'

const path = require('node:path')

function str(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : String(v).trim()
}

function int(name, fallback) {
  const n = Number(str(name, ''))
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

const rootDir = path.resolve(__dirname, '..')

const config = {
  // 只监听回环：对外一律经 nginx 反代（location /api/）。
  port: int('PORT', 3000),
  bind: str('BIND', '127.0.0.1'),
  dbPath: str('DB_PATH', path.join(rootDir, 'data', 'bt-light.db')),
  // 微信小程序凭据：code2Session 用。空 = 拒绝登录（不静默放行）。
  wxAppId: str('WX_APP_ID', ''),
  wxAppSecret: str('WX_APP_SECRET', ''),
  // 会话有效期（天）。过期即要求重新 wx.login。
  tokenTtlDays: int('TOKEN_TTL_DAYS', 30),
  // 管理后台初始账号：仅在 users 表为空时创建（幂等）。
  adminInitUser: str('ADMIN_INIT_USER', ''),
  adminInitPassword: str('ADMIN_INIT_PASSWORD', ''),
  // 头像 base64 上限：小程序端按 128KB 截断，这里留一点余量兜底。
  avatarMaxBytes: int('AVATAR_MAX_BYTES', 200 * 1024),
  // 日志级别：debug|info|warn|error。
  logLevel: str('LOG_LEVEL', 'info'),
}

// 测试可覆写（node --test 里用临时 DB 与固定凭据）。
function withOverrides(overrides) {
  return Object.assign({}, config, overrides || {})
}

module.exports = { config, withOverrides }
