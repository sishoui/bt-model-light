// 遥测与统计（ADR-0037）：给后台管理提供"能看出趋势"的数据面。
//
// 设计取舍：**不**为每个指标建一张表（改一个指标就要改 schema + 迁移 + 前端），
// 而是用一张 `telemetry` 事件表：`(metric, dim, value, at)`。
//   - metric = 指标名（如 'ble.connect.ok'、'config.write'、'ota.bytes'）
//   - dim    = 维度（如 deviceId / platform / firmwareVersion / errorCode）
//   - value  = 数值（计数=1，耗时=ms，字节=bytes）
// 后台按 metric + dim 分组聚合，新增指标零迁移。
//
// 同时有 `daily_stats` 日汇总：事件表按天滚动的结果，用于长期趋势（不扫全表）。

'use strict'

const { nowSec } = require('./db')

// 白名单：只接受这些指标（避免小程序端打任意 metric 把表撑爆）。
// 新增指标在这里加一行即可，路由层不看指标名。
const METRICS = {
  'app.launch': { unit: 'count', describe: '小程序启动' },
  'user.login.ok': { unit: 'count', describe: '微信登录成功' },
  'user.login.fail': { unit: 'count', describe: '微信登录失败' },
  'ble.scan.start': { unit: 'count', describe: '开始扫描' },
  'ble.connect.ok': { unit: 'count', describe: 'BLE 连接成功' },
  'ble.connect.fail': { unit: 'count', describe: 'BLE 连接失败' },
  'ble.disconnect': { unit: 'count', describe: 'BLE 断开' },
  'ble.mtu': { unit: 'bytes', describe: '协商到的写分片上限' },
  'ble.rssi': { unit: 'dbm', describe: '扫描到的信号强度' },
  'config.write': { unit: 'count', describe: '配置下发' },
  'config.write.fail': { unit: 'count', describe: '配置下发失败' },
  'config.bytes': { unit: 'bytes', describe: '配置下发字节数' },
  'ota.check': { unit: 'count', describe: '检查固件更新' },
  'ota.check.fail': { unit: 'count', describe: '检查更新失败' },
  'ota.start': { unit: 'count', describe: '开始升级' },
  'ota.done': { unit: 'count', describe: '升级完成' },
  'ota.fail': { unit: 'count', describe: '升级失败' },
  'ota.bytes': { unit: 'bytes', describe: '升级写入字节数' },
  'ota.duration': { unit: 'ms', describe: '升级耗时' },
  'error': { unit: 'count', describe: '错误（dim=错误码）' },
  'page.view': { unit: 'count', describe: '页面浏览' },
}

// 保留窗口：事件表 30 天，日汇总永久。超期在写入时顺手裁剪（不需要 cron）。
const TELEMETRY_TTL_DAYS = 30

function isValidMetric(metric) {
  return Object.prototype.hasOwnProperty.call(METRICS, metric)
}

// ---- 写入 ------------------------------------------------------------------

// 时间归一：客户端历史上可能发秒或毫秒。用 1e11 做分界
// （1e11 毫秒 ≈ 1973 年，1e11 秒 ≈ 5138 年）——小于它按秒，否则按毫秒。
const SECONDS_THRESHOLD = 1e11

function normalizeAt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return nowSec()
  return n < SECONDS_THRESHOLD ? Math.floor(n) : Math.floor(n / 1000)
}

// events: [{ metric, dim?, value?, at? }]（批量上报，一次最多 200 条）。
// 返回 { accepted, rejected }：未知 metric / 非法 value 被丢，不报错整批失败。
function ingest(db, userId, events) {
  const stmt = db.prepare('insert into telemetry (user_id, metric, dim, value, at) values (?, ?, ?, ?, ?)')
  let accepted = 0
  let rejected = 0
  for (const e of events) {
    const metric = String((e && e.metric) || '')
    if (!isValidMetric(metric)) {
      rejected += 1
      continue
    }
    const value = Number(e.value === undefined ? 1 : e.value)
    if (!Number.isFinite(value)) {
      rejected += 1
      continue
    }
    const at = normalizeAt(e.at)
    const dim = e.dim === undefined || e.dim === null ? '' : String(e.dim).slice(0, 64)
    stmt.run(userId || null, metric, dim, value, at)
    accepted += 1
  }
  return { accepted, rejected }
}

// 裁剪超期事件（写入时低频触发，避免每请求都跑）。
// 节流状态挂在 db 实例上（模块级会让多实例/测试互相干扰，同 limiter 的教训）。
function pruneTelemetry(db, force) {
  const now = nowSec()
  if (!force && db.__lastTelemetryPrune && now - db.__lastTelemetryPrune < 3600) return 0
  db.__lastTelemetryPrune = now
  const before = now - TELEMETRY_TTL_DAYS * 86400
  const r = db.prepare('delete from telemetry where at < ?').run(before)
  return r.changes || 0
}

// ---- 日汇总 ----------------------------------------------------------------

// 把某天（默认昨天）的 telemetry 聚合成 daily_stats 行（幂等：先删后插）。
function rollupDay(db, dayKey) {
  const day = dayKey || yesterdayKey()
  const start = dayStartSec(day)
  const end = start + 86400
  const rows = db
    .prepare(
      `select metric, count(*) c, sum(value) total, count(distinct user_id) users
         from telemetry where at >= ? and at < ? group by metric`,
    )
    .all(start, end)
  db.prepare('delete from daily_stats where day = ?').run(day)
  const stmt = db.prepare(
    'insert into daily_stats (day, metric, events, total, users, updated_at) values (?, ?, ?, ?, ?, ?)',
  )
  const now = nowSec()
  for (const r of rows) stmt.run(day, r.metric, r.c, r.total || 0, r.users || 0, now)
  return rows.length
}

function yesterdayKey() {
  const d = new Date(Date.now() - 86400000)
  return d.toISOString().slice(0, 10)
}

// 'YYYY-MM-DD' → 该 UTC 日 00:00 的秒。事件按 UTC 日落库，
// 后台展示也按 UTC（图表刻度写 UTC，避免"同一天不同时区"的歧义）。
function dayStartSec(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''))
  if (!m) return null
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000)
}

// ---- 查询（后台图表用） -----------------------------------------------------

// 最近 N 天的事件量趋势，按 metric 分组：{ days: [...], series: { metric: [n...] } }
function dailySeries(db, metrics, days) {
  const n = Math.max(1, Math.min(365, Number(days) || 14))
  const today = new Date()
  const out = { days: [], series: {} }
  const dayKeys = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000)
    dayKeys.push(d.toISOString().slice(0, 10))
  }
  out.days = dayKeys
  for (const m of metrics) out.series[m] = dayKeys.map(() => 0)

  const start = dayStartSec(dayKeys[0])
  const rows = db
    .prepare(
      `select metric, substr(datetime(at, 'unixepoch'), 1, 10) day, count(*) c
         from telemetry where at >= ? and metric in (${metrics.map(() => '?').join(',')})
        group by metric, day`,
    )
    .all(start, ...metrics)
  const idx = new Map(dayKeys.map((d, i) => [d, i]))
  for (const r of rows) {
    const i = idx.get(r.day)
    if (i !== undefined && out.series[r.metric]) out.series[r.metric][i] = r.c
  }
  return out
}

// 某指标按维度的 Top N（如各错误码占比、各固件版本分布）。
function topDims(db, metric, { days = 7, limit = 10 } = {}) {
  const start = nowSec() - Math.max(1, Number(days) || 7) * 86400
  return db
    .prepare(
      `select dim, count(*) c, sum(value) total from telemetry
        where metric = ? and at >= ? and dim != '' group by dim order by c desc limit ?`,
    )
    .all(String(metric), start, Math.max(1, Math.min(100, Number(limit) || 10)))
}

// 直方图分桶（如 BLE MTU / RSSI 分布）：value 落在 [min,max]，桶宽 = (max-min)/buckets。
function histogram(db, metric, { days = 7, min = 0, max = 1, buckets = 8 } = {}) {
  const start = nowSec() - Math.max(1, Number(days) || 7) * 86400
  const lo = Number(min)
  const hi = Number(max)
  const n = Math.max(1, Math.min(40, Number(buckets) || 8))
  const width = (hi - lo) / n || 1
  const rows = db
    .prepare('select value from telemetry where metric = ? and at >= ?')
    .all(String(metric), start)
  const out = []
  for (let i = 0; i < n; i++) {
    const from = lo + i * width
    out.push({ from, to: from + width, count: 0 })
  }
  for (const r of rows) {
    // 超出范围的落首/末桶（不丢数据，也不产生额外空桶）。
    let i = Math.floor((r.value - lo) / width)
    if (!Number.isFinite(i)) continue
    i = Math.max(0, Math.min(n - 1, i))
    out[i].count += 1
  }
  return { buckets: out, total: rows.length }
}

// 后台总览：一次拿全（避免前端并发打 6 个接口）。
function summary(db) {
  const now = nowSec()
  const day = now - 86400
  // node:sqlite 的 .get() 返回 null-prototype 对象；统一转成普通对象再取值。
  const one = (sql, ...a) => {
    const row = db.prepare(sql).get(...a)
    return row ? row.c : 0
  }

  const todayKey = new Date().toISOString().slice(0, 10)
  const todayStart = dayStartSec(todayKey) || now
  return {
    // 存量
    totalUsers: one("select count(*) c from users where role='user'"),
    disabledUsers: one("select count(*) c from users where role='user' and status='disabled'"),
    totalDevices: one('select count(*) c from devices'),
    // 24h
    activeUsers24h: one("select count(*) c from users where role='user' and last_login_at >= ?", day),
    newUsers24h: one("select count(*) c from users where role='user' and created_at >= ?", day),
    devices24h: one('select count(*) c from devices where last_seen_at >= ?', day),
    // 今日（UTC）
    eventsToday: one('select count(*) c from telemetry where at >= ?', todayStart),
    errorsToday: one("select count(*) c from telemetry where metric='error' and at >= ?", todayStart),
    loginsToday: one("select count(*) c from telemetry where metric='user.login.ok' and at >= ?", todayStart),
    // 固件版本分布（运营最关心：有多少老固件在跑）
    firmwareVersions: db
      .prepare(
        "select coalesce(firmware_version,'') v, count(*) c from devices group by v order by c desc limit 10",
      )
      .all()
      .map((r) => ({ v: r.v, c: r.c })),
  }
}

// ---- 迁移 ------------------------------------------------------------------
//
// 表定义在 db.js 的 TELEMETRY_SCHEMA（schema 的唯一入口）；这里只做指标白名单
// 与查询，不重复声明 DDL。

module.exports = {
  METRICS,
  TELEMETRY_TTL_DAYS,
  isValidMetric,
  ingest,
  pruneTelemetry,
  rollupDay,
  yesterdayKey,
  dayStartSec,
  dailySeries,
  topDims,
  histogram,
  summary,
}
