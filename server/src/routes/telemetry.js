// 路由：遥测上报（ADR-0037）。
//
// 定位：小程序在关键路径打点（BLE 连接、配置下发、OTA、错误），后台据此做图表。
// 与 devices 一样是 best-effort：失败不影响 BLE 主流程，客户端不 await。
//
// 隐私：只收指标名 + 数值 + 维度（deviceId 之类），**不收**配置内容、
// 不收 openid、不收页面输入。user_id 由 token 推出。

'use strict'

const { ok, fail, handleError } = require('../http')
const telemetry = require('../telemetry')

// 单批上限：客户端攒批上报，超过就截断（避免误传整份日志）。
const BATCH_MAX = 200

function installTelemetryRoutes(app, ctx) {
  const { db, log } = ctx

  // 指标白名单：后台"遥测字典"页直接用（前端不用硬编码指标名）。
  app.get('/telemetry/metrics', (_req, res) => {
    try {
      const items = Object.keys(telemetry.METRICS).map((k) =>
        Object.assign({ metric: k }, telemetry.METRICS[k]),
      )
      return ok(res, { items, ttlDays: telemetry.TELEMETRY_TTL_DAYS })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // POST /telemetry { events: [{ metric, dim?, value?, at? }] }
  // token 可选：未登录也能上报（登录前的启动/扫描数据同样有价值），
  // 只是 user_id 为空 —— 这样不会因为"没登录"丢掉首批诊断数据。
  app.post('/telemetry', (req, res) => {
    try {
      const body = req.body || {}
      const events = Array.isArray(body.events) ? body.events.slice(0, BATCH_MAX) : null
      if (!events) return fail(res, 400, 'INVALID_PARAMETER', 'events 需为数组')
      const session = ctx.sessionOf(req)
      const userId = session ? session.user.id : null
      const r = telemetry.ingest(db, userId, events)
      telemetry.pruneTelemetry(db)
      return ok(res, r)
    } catch (err) {
      handleError(res, err, log)
    }
  })
}

module.exports = { installTelemetryRoutes, BATCH_MAX }
