// 路由：管理后台（ADR-0036）。
//
// 权限：所有 /admin/* 除 /admin/login 外都要求 role=admin 的会话。
// 每次写操作落 audit_log（谁、做了什么、对谁、什么 IP）。

'use strict'

const { ok, fail, handleError, audit, pageQuery, strField, intField, SEARCH_MAX } = require('../http')
const models = require('../models')
const auth = require('../auth')
const telemetry = require('../telemetry')

// 概览页一次要的指标（前端不硬编码，这里集中声明）。
const OVERVIEW_SERIES = ['app.launch', 'user.login.ok', 'ble.connect.ok', 'config.write', 'error']
const OVERVIEW_DIMS = ['error', 'user.login.fail', 'ble.connect.fail', 'config.write.fail', 'ota.fail']

function installAdminRoutes(app, ctx) {
  const { db, log } = ctx

  function requireAdmin(req, res) {
    const session = ctx.sessionOf(req)
    if (!session) {
      fail(res, 401, 'UNAUTHORIZED', '请先登录')
      return null
    }
    if (session.user.role !== 'admin') {
      fail(res, 403, 'FORBIDDEN', '需要管理员权限')
      return null
    }
    return session
  }

  // GET /admin/overview → 概览卡片 + 图表数据（一次返回，前端不打并发）
  //
  // 结构：
  //   { 卡片指标…,
  //     trend: { days[], series{metric[]} },      // 14 天时序
  //     userGrowth: { days[], total[] },          // 累计用户 / 每日新增
  //     dims: { metric: [{dim,c}] },              // Top 失败原因
  //     firmwareVersions: [{v,c}],
  //     mtuHistogram: { buckets[], total },       // 空口分片分布
  //     deviceTrend: { days[], newDevices[] } }
  app.get('/admin/overview', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const days = Math.max(1, Math.min(90, Number(req.query.days) || 14))
      const base = telemetry.summary(db)

      const dims = {}
      for (const m of OVERVIEW_DIMS) dims[m] = telemetry.topDims(db, m, { days, limit: 6 })

      return ok(
        res,
        Object.assign(base, {
          trend: telemetry.dailySeries(db, OVERVIEW_SERIES, days),
          userGrowth: models.userGrowth(db, days),
          deviceGrowth: models.deviceGrowth(db, days),
          dims,
          mtuHistogram: telemetry.histogram(db, 'ble.mtu', { days, min: 20, max: 520, buckets: 8 }),
          errorHistogram: telemetry.histogram(db, 'ble.rssi', { days, min: -100, max: -30, buckets: 8 }),
        }),
      )
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // GET /admin/telemetry?metrics=a,b&days=14 → 任选指标的时序（"遥测"页）
  // 返回 { days, metrics, series:{metric[]}, seriesDays[], dims }：
  // series 只装指标数组，日期轴单独放 seriesDays，避免"series.days"这种
  // 与指标名可能撞车的嵌套（前端少一层取值也少一类 bug）。
  app.get('/admin/telemetry', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 14))
      const raw = String(req.query.metrics || '')
      const wanted = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
      const metrics = wanted.length ? wanted.filter((m) => telemetry.isValidMetric(m)) : OVERVIEW_SERIES
      if (!metrics.length) return fail(res, 400, 'INVALID_PARAMETER', '没有合法指标')
      const full = telemetry.dailySeries(db, metrics, days)
      const dims = {}
      for (const m of metrics) dims[m] = telemetry.topDims(db, m, { days, limit: 8 })
      return ok(res, { days, metrics, seriesDays: full.days, series: full.series, dims })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // GET /admin/errors?days=7 → 错误码分布 + RSSI 直方图（"诊断"页）
  app.get('/admin/errors', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 7))
      const full = telemetry.dailySeries(
        db,
        ['error', 'ble.connect.fail', 'config.write.fail', 'ota.fail', 'user.login.fail'],
        days,
      )
      const startSec = telemetry.dayStartSec(full.days[0]) || 0
      return ok(res, {
        days,
        seriesDays: full.days,
        series: full.series,
        codes: telemetry.topDims(db, 'error', { days, limit: 12 }),
        mtu: telemetry.histogram(db, 'ble.mtu', { days, min: 20, max: 520, buckets: 8 }),
        rssi: telemetry.histogram(db, 'ble.rssi', { days, min: -100, max: -30, buckets: 8 }),
        otaBytes: db
          .prepare(
            "select substr(datetime(at,'unixepoch'),1,10) d, sum(value) v from telemetry " +
              "where metric='ota.bytes' and at>=? group by d order by d",
          )
          .all(startSec),
      })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // GET /admin/overview 的历史版本（无图表）保留给脚本/curl 快速核对。
  app.get('/admin/counts', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      return ok(res, models.overviewCounts(db))
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // POST /admin/rollup { day? } → 手动触发日汇总（幂等；也可由 cron 调）
  app.post('/admin/rollup', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const day = req.body && req.body.day ? String(req.body.day) : undefined
      if (day && !telemetry.dayStartSec(day)) {
        return fail(res, 400, 'INVALID_PARAMETER', 'day 需为 YYYY-MM-DD')
      }
      const n = telemetry.rollupDay(db, day)
      audit(db, `admin:${session.user.id}`, 'telemetry.rollup', day || 'yesterday', `${n} metrics`, req.ip || '')
      return ok(res, { day: day || telemetry.yesterdayKey(), metrics: n })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // GET /admin/overview 的历史版本（无图表）保留给脚本/curl 快速核对。

  // GET /admin/users?keyword=&status=&page=&size= → { total, page, size, items }
  app.get('/admin/users', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const { page, size, offset } = pageQuery(req.query)
      const keyword = strField(req.query.keyword, { max: SEARCH_MAX, allowEmpty: true }) || ''
      const status = req.query.status === 'active' || req.query.status === 'disabled' ? req.query.status : ''
      const result = models.searchUsers(db, { keyword, status, limit: size, offset })
      return ok(res, { page, size, total: result.total, items: result.items })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // PATCH /admin/users/:id { status } → { user }
  app.patch('/admin/users/:id', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const id = intField(req.params.id, { min: 1 })
      if (!id) return fail(res, 400, 'INVALID_PARAMETER', '用户 id 非法')
      const status = req.body && req.body.status
      if (status !== 'active' && status !== 'disabled') {
        return fail(res, 400, 'INVALID_PARAMETER', '状态只能是 active 或 disabled')
      }
      const row = models.findUserById(db, id)
      if (!row) return fail(res, 404, 'NOT_FOUND', '用户不存在')
      if (row.role === 'admin' && status === 'disabled') {
        // 防止把最后一个管理员锁死（后台再也进不去）。
        const admins = db.prepare("select count(*) c from users where role='admin' and status='active'").get().c
        if (admins <= 1) return fail(res, 400, 'INVALID_PARAMETER', '不能停用唯一的管理员')
      }
      const updated = models.setUserStatus(db, id, status)
      // 禁用即踢下线：token 立即失效（这也是不用 JWT 的原因）。
      if (status === 'disabled') auth.deleteSessionsForUser(db, id)
      audit(db, `admin:${session.user.id}`, 'user.status', `user:${id}`, status, req.ip || '')
      return ok(res, { user: models.publicUser(updated) })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // GET /admin/devices?keyword=&userId=&page=&size=
  app.get('/admin/devices', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const { page, size, offset } = pageQuery(req.query)
      const keyword = strField(req.query.keyword, { max: SEARCH_MAX, allowEmpty: true }) || ''
      const userId = intField(req.query.userId, { min: 1, fallback: null })
      const result = models.searchDevices(db, { keyword, userId, limit: size, offset })
      return ok(res, { page, size, total: result.total, items: result.items })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // DELETE /admin/devices/:id → { ok }
  app.delete('/admin/devices/:id', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const id = intField(req.params.id, { min: 1 })
      if (!id) return fail(res, 400, 'INVALID_PARAMETER', '设备 id 非法')
      const row = models.findDeviceById(db, id)
      if (!row) return fail(res, 404, 'NOT_FOUND', '设备不存在')
      models.deleteDevice(db, id)
      audit(db, `admin:${session.user.id}`, 'device.delete', `device:${id}`, row.device_id, req.ip || '')
      return ok(res)
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // GET /admin/audit?page=&size=
  app.get('/admin/audit', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    try {
      const { page, size, offset } = pageQuery(req.query, { defaultSize: 50 })
      const result = models.listAudit(db, { limit: size, offset })
      return ok(res, { page, size, total: result.total, items: result.items })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // POST /admin/logout → 吊销会话
  app.post('/admin/logout', (req, res) => {
    const session = requireAdmin(req, res)
    if (!session) return
    auth.deleteSession(db, session.token)
    return ok(res)
  })
}

module.exports = { installAdminRoutes }
