// 遥测单测：白名单、批量上报、聚合查询、日汇总、裁剪。

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const telemetry = require('../src/telemetry')
const { open, nowSec } = require('../src/db')
const { tmpDbPath, cleanup } = require('./helpers')

function withDb(fn) {
  const p = tmpDbPath('telemetry')
  const db = open(p)
  try {
    return fn(db)
  } finally {
    db.close()
    cleanup(p)
  }
}

// 直接写入指定时间的点（绕过 ingest 的"现在"），用于测历史聚合。
function seed(db, metric, atSec, value = 1, dim = '') {
  db.prepare('insert into telemetry (user_id, metric, dim, value, at) values (?,?,?,?,?)').run(
    null,
    metric,
    dim,
    value,
    atSec,
  )
}

test('指标白名单：已知/未知', () => {
  assert.equal(telemetry.isValidMetric('ble.connect.ok'), true)
  assert.equal(telemetry.isValidMetric('anything.else'), false)
  assert.equal(telemetry.isValidMetric(''), false)
  assert.ok(Object.keys(telemetry.METRICS).length >= 15)
})

test('ingest：未知指标与非法 value 被拒，合法入库（含 dim/at 归一）', () => {
  withDb((db) => {
    const r = telemetry.ingest(db, null, [
      { metric: 'ble.connect.ok' },
      { metric: 'not.a.metric' },
      { metric: 'config.bytes', value: 1500 },
      { metric: 'ble.mtu', value: 'abc' },
      { metric: 'error', dim: 'x'.repeat(200), value: 1 },
      { metric: 'ble.rssi', value: -62, at: Date.now() },
    ])
    assert.equal(r.accepted, 4)
    assert.equal(r.rejected, 2)
    const rows = db.prepare('select metric, dim, value from telemetry order by id').all()
    assert.deepEqual(rows.map((x) => x.metric), ['ble.connect.ok', 'config.bytes', 'error', 'ble.rssi'])
    // 计数型默认 value=1
    assert.equal(rows[0].value, 1)
    assert.equal(rows[1].value, 1500)
    // dim 超长被截断到 64
    assert.equal(rows[2].dim.length, 64)
  })
})

test('ingest：绑定 user_id（未登录为 null）', () => {
  withDb((db) => {
    db.prepare("insert into users (openid, nickname, role, status, created_at) values ('o','n','user','active',?)").run(
      nowSec(),
    )
    const uid = db.prepare("select id from users where openid='o'").get().id
    telemetry.ingest(db, uid, [{ metric: 'app.launch' }])
    telemetry.ingest(db, null, [{ metric: 'app.launch' }])
    const rows = db.prepare('select user_id from telemetry order by id').all()
    assert.equal(rows[0].user_id, uid)
    assert.equal(rows[1].user_id, null)
  })
})

test('dailySeries：按天分桶，缺天补 0，只含请求的指标', () => {
  withDb((db) => {
    const now = nowSec()
    const today = now - 60
    const twoDaysAgo = now - 2 * 86400
    seed(db, 'ble.connect.ok', today)
    seed(db, 'ble.connect.ok', today + 1)
    seed(db, 'ble.connect.ok', twoDaysAgo)
    seed(db, 'error', today)
    seed(db, 'unrelated', today)

    const s = telemetry.dailySeries(db, ['ble.connect.ok', 'error'], 3)
    assert.equal(s.days.length, 3)
    assert.equal(s.series['ble.connect.ok'].length, 3)
    // 最早那天（两天前）1 条，今天 2 条
    assert.equal(s.series['ble.connect.ok'][0], 1)
    assert.equal(s.series['ble.connect.ok'].at(-1), 2)
    assert.equal(s.series.error.at(-1), 1)
    assert.equal(s.series.error[1], 0)
  })
})

test('topDims：按维度过数字排序，忽略空维度', () => {
  withDb((db) => {
    const now = nowSec()
    for (let i = 0; i < 3; i++) seed(db, 'error', now - i, 1, '10001')
    for (let i = 0; i < 5; i++) seed(db, 'error', now - i, 1, '10009')
    seed(db, 'error', now, 1, '')
    const top = telemetry.topDims(db, 'error', { days: 7, limit: 5 })
    assert.equal(top.length, 2)
    assert.equal(top[0].dim, '10009')
    assert.equal(top[0].c, 5)
    assert.equal(top[1].dim, '10001')
  })
})

test('histogram：分桶覆盖范围，越界落首末桶', () => {
  withDb((db) => {
    const now = nowSec()
    for (const v of [20, 100, 180, 300, 509, 999]) seed(db, 'ble.mtu', now, v)
    const h = telemetry.histogram(db, 'ble.mtu', { days: 7, min: 20, max: 520, buckets: 5 })
    assert.equal(h.total, 6)
    assert.equal(h.buckets.length, 5)
    assert.equal(h.buckets.reduce((s, b) => s + b.count, 0), 6)
    assert.ok(h.buckets[0].count >= 1) // 20 落在第一桶
    assert.ok(h.buckets.at(-1).count >= 1) // 999 越界落末桶
  })
})

test('rollupDay：聚合当天数据，重复执行幂等', () => {
  withDb((db) => {
    const day = '2026-01-15'
    const start = telemetry.dayStartSec(day)
    seed(db, 'app.launch', start + 10)
    seed(db, 'app.launch', start + 20)
    seed(db, 'ble.connect.ok', start + 30, 1)
    seed(db, 'app.launch', start + 2 * 86400) // 另一天，不应计入

    const n = telemetry.rollupDay(db, day)
    assert.equal(n, 2)
    // node:sqlite 返回 null-prototype 对象：逐字段断言，不用 deepEqual。
    let rows = db.prepare('select metric, events from daily_stats where day=? order by metric').all(day)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].metric, 'app.launch')
    assert.equal(rows[0].events, 2)
    assert.equal(rows[1].metric, 'ble.connect.ok')
    assert.equal(rows[1].events, 1)

    // 再跑一次：不翻倍
    telemetry.rollupDay(db, day)
    rows = db.prepare('select metric, events from daily_stats where day=? order by metric').all(day)
    assert.equal(rows[0].events, 2)
  })
})

test('rollupDay：非法 day 返回 null 起点（路由层拒）', () => {
  assert.equal(telemetry.dayStartSec('nonsense'), null)
  assert.equal(telemetry.dayStartSec(''), null)
  assert.equal(typeof telemetry.dayStartSec('2026-01-15'), 'number')
})

test('pruneTelemetry：只删超期事件，force 生效', () => {
  withDb((db) => {
    const now = nowSec()
    seed(db, 'app.launch', now - 40 * 86400)
    seed(db, 'app.launch', now - 1 * 86400)
    const removed = telemetry.pruneTelemetry(db, true)
    assert.equal(removed, 1)
    assert.equal(db.prepare('select count(*) c from telemetry').get().c, 1)
  })
})

test('pruneTelemetry：非 force 时 1 小时内不重复跑', () => {
  withDb((db) => {
    seed(db, 'app.launch', nowSec() - 40 * 86400)
    assert.equal(telemetry.pruneTelemetry(db, false), 1) // 首次跑
    assert.equal(telemetry.pruneTelemetry(db, false), 0) // 节流
  })
})

test('summary：今日事件/错误/登录数只看今天', () => {
  withDb((db) => {
    const now = nowSec()
    seed(db, 'error', now - 10)
    seed(db, 'error', now - 3 * 86400) // 不是今天
    seed(db, 'user.login.ok', now - 20)
    seed(db, 'app.launch', now - 30)
    const s = telemetry.summary(db)
    assert.equal(s.errorsToday, 1)
    assert.equal(s.loginsToday, 1)
    assert.equal(s.eventsToday, 3)
    assert.equal(s.totalUsers, 0)
  })
})
