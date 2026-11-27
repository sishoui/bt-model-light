// Express 应用组装（不 listen，便于测试直接注入 app）。
//
// 挂载点：
//   /api/*       线上唯一入口（nginx location /api/ 反代到 127.0.0.1:3000）
//   /*           同一套路由也挂在根，便于本机 curl 与测试直接调用
//   /api/health  健康检查（部署脚本 verify 用）
//
// 只监听回环地址，因此不配 CORS：后台 SPA 与 API 同源（/admin/ 静态目录
// 由同一 nginx server 提供），小程序侧也不需要跨域。

'use strict'

const express = require('express')
const { config } = require('./config')
const { open } = require('./db')
const { ok, fail, handleError, createLogger, createRateLimiter } = require('./http')
const auth = require('./auth')
const models = require('./models')
const { installAuthRoutes } = require('./routes/auth')
const { installDeviceRoutes } = require('./routes/devices')
const { installAdminRoutes } = require('./routes/admin')
const { installTelemetryRoutes } = require('./routes/telemetry')

// 通用请求限流：每 IP 每分钟 300 次（正常操作远低于此，只为挡住脚本刷接口）。
// 每个 app 实例一份：模块级单例会让多实例（测试/多进程）共用计数互相误伤。
const REQUEST_RATE = { limit: 300, windowMs: 60 * 1000 }

function createApp(overrides) {
  const cfg = Object.assign({}, config, overrides || {})
  const log = createLogger(cfg.logLevel)
  const db = open(cfg.dbPath)
  // cfg.rateLimit === false 时全部放行（测试用；线上永远开着）。
  const requestLimiter =
    cfg.rateLimit === false
      ? () => true
      : (cfg.requestLimiter || createRateLimiter)(REQUEST_RATE)

  // 初始管理员：仅当库里没有 admin 时创建（幂等，重启不覆盖已改过的密码）。
  const createdAdmin = models.ensureInitAdmin(db, cfg.adminInitUser, cfg.adminInitPassword, auth.hashPassword)
  if (createdAdmin) log.info('init admin created', { username: cfg.adminInitUser })

  const app = express()
  app.disable('x-powered-by')
  // 只信本机反代：req.ip 取 X-Forwarded-For 才有意义。
  app.set('trust proxy', 'loopback')
  app.use(express.json({ limit: '512kb' }))

  const ctx = {
    db,
    cfg,
    log,
    // 会话解析集中一处：路由里只拿 session 或 null。
    sessionOf(req) {
      const header = req.get('authorization') || ''
      const m = /^Bearer\s+(\S+)$/i.exec(header)
      return auth.resolveSession(db, m ? m[1] : '')
    },
  }

  app.use((req, res, next) => {
    if (!requestLimiter(req.ip || '')) return fail(res, 429, 'RATE_LIMITED', '操作过于频繁，请稍后重试')
    next()
  })

  // 同一套路由挂两处：/api（线上）与 /（本机调试、测试）。
  const api = express.Router()
  api.get('/health', (_req, res) =>
    ok(res, { ok: true, version: '0.1.0', now: Math.floor(Date.now() / 1000) }),
  )
  installAuthRoutes(api, ctx)
  installDeviceRoutes(api, ctx)
  installTelemetryRoutes(api, ctx)
  installAdminRoutes(api, ctx)

  app.use('/api', api)
  app.use('/', api)

  app.use((_req, res) => fail(res, 404, 'NOT_FOUND', '接口不存在'))
  app.use((err, _req, res) => handleError(res, err, log))

  app.locals.db = db
  app.locals.cfg = cfg
  app.locals.log = log
  app.locals.close = () => db.close()
  return app
}

module.exports = { createApp }
