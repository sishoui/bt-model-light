// 认证（ADR-0035）：微信 code2Session、会话 token、管理员密码。
//
// token 是数据库里的随机串而不是 JWT：吊销（禁用用户/退出登录）必须是
// 即时的，JWT 的"签发后不可撤销"在这里是缺点。代价是每请求一次索引查询，
// 这个量级无感。

'use strict'

const crypto = require('node:crypto')
const { nowSec } = require('./db')

const WX_CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session'

// 微信返回的 errcode → 可读中文（不把裸码抛给用户，对齐 errorHandler 的思路）。
const WX_ERRORS = {
  '-1': '微信服务繁忙，请稍后重试',
  40029: '登录凭证无效，请重试',
  45011: '登录过于频繁，请稍后重试',
  40226: '当前微信账号存在风险，暂时无法登录',
  40163: '登录凭证已被使用，请重试',
}

// 会话 token：32 字节随机数的 hex，不可猜、无内嵌信息。
function newToken() {
  return crypto.randomBytes(32).toString('hex')
}

// ---- 微信 code2Session -----------------------------------------------------

// 用 code 换 openid。resolve { openid, unionid }，reject { status, message }。
// errcode 40163（code 已被使用）等统一按 400 处理：属于客户端凭证问题。
async function code2Session(appId, appSecret, code, deps) {
  const fetchImpl = (deps && deps.fetch) || globalThis.fetch
  if (!appId || !appSecret) {
    const e = new Error('服务端未配置微信凭据，无法登录')
    e.status = 500
    throw e
  }
  const jsCode = String(code || '').trim()
  if (!jsCode) {
    const e = new Error('缺少登录凭证 code')
    e.status = 400
    throw e
  }
  const url =
    `${WX_CODE2SESSION_URL}?appid=${encodeURIComponent(appId)}` +
    `&secret=${encodeURIComponent(appSecret)}` +
    `&js_code=${encodeURIComponent(jsCode)}` +
    '&grant_type=authorization_code'

  let payload
  try {
    const res = await fetchImpl(url, { method: 'GET' })
    if (!res.ok) {
      const e = new Error(`微信服务不可用（HTTP ${res.status}）`)
      e.status = 502
      throw e
    }
    payload = await res.json()
  } catch (err) {
    if (err.status) throw err
    const e = new Error('无法连接微信服务器，请检查网络后重试')
    e.status = 502
    throw e
  }

  if (payload && payload.errcode) {
    const code2 = String(payload.errcode)
    const e = new Error(WX_ERRORS[code2] || `微信登录失败（${code2}）`)
    e.status = 400
    e.wxErrcode = payload.errcode
    throw e
  }
  if (!payload || !payload.openid) {
    const e = new Error('微信未返回 openid，请重试')
    e.status = 502
    throw e
  }
  return { openid: payload.openid, unionid: payload.unionid || null }
}

// ---- 会话 ------------------------------------------------------------------

function createSession(db, userId, ttlDays) {
  const token = newToken()
  const now = nowSec()
  const expiresAt = now + Math.max(1, ttlDays) * 86400
  db.prepare('insert into sessions (token, user_id, created_at, expires_at) values (?, ?, ?, ?)').run(
    token,
    userId,
    now,
    expiresAt,
  )
  return { token, expiresAt }
}

function deleteSession(db, token) {
  db.prepare('delete from sessions where token = ?').run(token)
}

function deleteSessionsForUser(db, userId) {
  db.prepare('delete from sessions where user_id = ?').run(userId)
}

function purgeExpiredSessions(db) {
  db.prepare('delete from sessions where expires_at <= ?').run(nowSec())
}

// token → { user } | null。用户被封禁视为无会话（token 立即失效）。
function resolveSession(db, token) {
  if (!token) return null
  const row = db
    .prepare(
      `select s.token, s.expires_at, u.id, u.openid, u.nickname, u.avatar, u.role, u.status
         from sessions s join users u on u.id = s.user_id
        where s.token = ?`,
    )
    .get(token)
  if (!row) return null
  if (row.expires_at <= nowSec()) {
    deleteSession(db, token)
    return null
  }
  if (row.status !== 'active') return null
  return {
    token: row.token,
    user: {
      id: row.id,
      openid: row.openid,
      nickname: row.nickname,
      avatar: row.avatar,
      role: row.role,
      status: row.status,
    },
  }
}

// ---- 管理员密码（scrypt） ---------------------------------------------------
//
// 存 `scrypt$<saltHex>$<hashHex>`。scrypt 是 Node 内置，不引入 bcrypt 原生模块
// （服务器 npm ci 不编译）。N=16384 是 Node 默认，单次 ~50ms，够用。

const SCRYPT_N = 16384
const SCRYPT_KEYLEN = 32

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N })
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  if (!salt.length || !expected.length) return false
  const actual = crypto.scryptSync(String(password), salt, expected.length, { N: SCRYPT_N })
  return crypto.timingSafeEqual(actual, expected)
}

module.exports = {
  newToken,
  code2Session,
  createSession,
  deleteSession,
  deleteSessionsForUser,
  purgeExpiredSessions,
  resolveSession,
  hashPassword,
  verifyPassword,
  WX_ERRORS,
}
