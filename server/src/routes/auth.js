// 路由：登录 / 退出 / 个人资料（ADR-0035）。
//
// 前缀由 app.js 挂到 /api，这里只写相对路径。

'use strict'

const {
  ok,
  fail,
  handleError,
  strField,
  createRateLimiter,
  audit,
  NICKNAME_MAX,
} = require('../http')
const auth = require('../auth')
const models = require('../models')

// 登录接口限流：每 IP 每分钟 20 次（wx.login 正常不会更频繁）。
// 按 code 的维度不做限流——同一用户重试不该被挡。
// 每个 app 实例自己一份（模块级单例会让多实例/测试互相污染计数）。
const LOGIN_RATE = { limit: 20, windowMs: 60 * 1000 }

function installAuthRoutes(app, ctx) {
  const { db, cfg, log } = ctx
  const loginLimiter = cfg.rateLimit === false ? () => true : createRateLimiter(LOGIN_RATE)

  // POST /auth/wx-login { code } → { token, expiresAt, user }
  app.post('/auth/wx-login', async (req, res) => {
    const ip = req.ip || ''
    if (!loginLimiter(ip)) return fail(res, 429, 'RATE_LIMITED', '操作过于频繁，请稍后重试')
    try {
      const code = strField(req.body && req.body.code, { max: 256 })
      if (!code) return fail(res, 400, 'INVALID_PARAMETER', '缺少登录凭证 code')

      const { openid, unionid } = await auth.code2Session(cfg.wxAppId, cfg.wxAppSecret, code)
      const user = models.upsertUserByOpenid(db, openid, unionid)
      if (!user) return fail(res, 500, 'INTERNAL', '登录失败，请稍后重试')
      if (user.status !== 'active') {
        return fail(res, 403, 'USER_DISABLED', '账号已被停用，请联系管理员')
      }
      const session = auth.createSession(db, user.id, cfg.tokenTtlDays)
      auth.purgeExpiredSessions(db)
      log.info('wx-login ok', { userId: user.id })
      return ok(res, {
        token: session.token,
        expiresAt: session.expiresAt,
        user: models.publicUser(user),
      })
    } catch (err) {
      // 微信侧错误（400/502）面向用户可读；不把它们记成 5xx 噪声。
      handleError(res, err, Number(err && err.status) >= 500 ? log : null)
    }
  })

  // POST /auth/logout（需 token）→ 吊销当前会话。
  app.post('/auth/logout', (req, res) => {
    const session = ctx.sessionOf(req)
    if (!session) return fail(res, 401, 'UNAUTHORIZED', '请先登录')
    auth.deleteSession(db, session.token)
    return ok(res)
  })

  // GET /me → { user }（需 token；不含 openid）。
  app.get('/me', (req, res) => {
    const session = ctx.sessionOf(req)
    if (!session) return fail(res, 401, 'UNAUTHORIZED', '请先登录')
    const row = models.findUserById(db, session.user.id)
    if (!row) return fail(res, 401, 'UNAUTHORIZED', '请先登录')
    return ok(res, { user: models.publicUser(row) })
  })

  // PATCH /me { nickname?, avatar? }（需 token）→ { user }
  // 头像走 data URL base64（不引入 multipart；小程序端已按 128KB 截断）。
  app.patch('/me', (req, res) => {
    const session = ctx.sessionOf(req)
    if (!session) return fail(res, 401, 'UNAUTHORIZED', '请先登录')
    const body = req.body || {}
    const patch = {}
    try {
      if (body.nickname !== undefined) {
        const nickname = strField(body.nickname, { max: NICKNAME_MAX, allowEmpty: true })
        if (nickname === null) return fail(res, 400, 'INVALID_PARAMETER', '昵称格式不正确')
        patch.nickname = nickname
      }
      if (body.avatar !== undefined) {
        const avatar = body.avatar === null ? '' : body.avatar
        if (typeof avatar !== 'string') return fail(res, 400, 'INVALID_PARAMETER', '头像格式不正确')
        if (!avatar) patch.avatar = ''
        else if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
          return fail(res, 400, 'INVALID_PARAMETER', '头像需为图片 data URL')
        } else if (avatar.length > cfg.avatarMaxBytes) {
          return fail(res, 413, 'AVATAR_TOO_LARGE', '头像过大，请换一张图')
        } else patch.avatar = avatar
      }
      if (!Object.keys(patch).length) return fail(res, 400, 'INVALID_PARAMETER', '没有可更新字段')
      const row = models.updateUserProfile(db, session.user.id, patch)
      return ok(res, { user: models.publicUser(row) })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // POST /admin/login { username, password } → { token, user }
  // 管理后台用它换 token；与小程序 token 同一套会话表，角色区分权限。
  app.post('/admin/login', (req, res) => {
    const ip = req.ip || ''
    if (!loginLimiter(ip)) return fail(res, 429, 'RATE_LIMITED', '操作过于频繁，请稍后重试')
    try {
      const body = req.body || {}
      const username = strField(body.username, { max: 64 })
      const password = typeof body.password === 'string' ? body.password : ''
      if (!username || !password) return fail(res, 400, 'INVALID_PARAMETER', '请输入用户名与密码')
      const row = models.findUserByUsername(db, username)
      // 统一文案：不区分"用户不存在"与"密码错"，避免枚举用户名。
      if (!row || row.role !== 'admin' || row.status !== 'active') {
        audit(db, username, 'admin.login_failed', 'admin', 'no such admin or disabled', ip)
        return fail(res, 401, 'UNAUTHORIZED', '用户名或密码不正确')
      }
      if (!auth.verifyPassword(password, row.password_hash)) {
        audit(db, username, 'admin.login_failed', `user:${row.id}`, 'bad password', ip)
        return fail(res, 401, 'UNAUTHORIZED', '用户名或密码不正确')
      }
      const session = auth.createSession(db, row.id, cfg.tokenTtlDays)
      models.touchLogin(db, row.id)
      audit(db, username, 'admin.login', `user:${row.id}`, 'ok', ip)
      return ok(res, { token: session.token, expiresAt: session.expiresAt, user: models.publicUser(row) })
    } catch (err) {
      handleError(res, err, log)
    }
  })
}

module.exports = { installAuthRoutes, LOGIN_RATE }
