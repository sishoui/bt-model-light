// API 端到端：真起 HTTP listener，用 fetch 打一遍（登录/资料/设备/权限/后台）。

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { makeApp, listen, req, seedUser, adminToken, cleanup, tmpDbPath } = require('./helpers')
const auth = require('../src/auth')
const models = require('../src/models')

// 每个用例一套独立 app + listener，避免状态互相污染。
async function withApp(fn) {
  const { app, dbPath } = makeApp()
  const srv = await listen(app)
  try {
    await fn({ app, srv })
  } finally {
    await srv.close()
    app.locals.db.close()
    cleanup(dbPath)
  }
}

test('GET /api/health 返回 ok（部署 verify 依赖它）', async () => {
  await withApp(async ({ srv }) => {
    const r = await req(srv.base, 'GET', '/api/health')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    // 根路径同样可达（本机调试）
    const r2 = await req(srv.base, 'GET', '/health')
    assert.equal(r2.status, 200)
  })
})

test('未登录访问受保护接口 → 401 且文案可读', async () => {
  await withApp(async ({ srv }) => {
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/devices'],
      ['POST', '/api/devices'],
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/users'],
    ]) {
      const r = await req(srv.base, method, path, { body: method === 'POST' ? {} : undefined })
      assert.equal(r.status, 401)
      assert.equal(r.body.error.message, '请先登录')
    }
  })
})

test('wx-login：微信凭据无效时返回可读错误，不签发 token', async () => {
  await withApp(async ({ app, srv }) => {
    // 用真实配置但假 code：微信会返回 40029/40163，服务端换成中文文案。
    // 若无外网则走 502 分支——两者都不是 200，且都不含 openid。
    const r = await req(srv.base, 'POST', '/api/auth/wx-login', { body: { code: 'definitely-not-a-code' } })
    assert.ok([400, 502].includes(r.status), `expected 400/502, got ${r.status}`)
    assert.ok(r.body.error && r.body.error.message)
    assert.ok(!JSON.stringify(r.body).includes('openid'))
    const sessions = app.locals.db.prepare('select count(*) c from sessions').get().c
    assert.equal(sessions, 0)
  })
})

test('wx-login：缺 code → 400', async () => {
  await withApp(async ({ srv }) => {
    const r = await req(srv.base, 'POST', '/api/auth/wx-login', { body: {} })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.message, '缺少登录凭证 code')
  })
})

test('GET /me 返回不含 openid 的用户资料', async () => {
  await withApp(async ({ app, srv }) => {
    const { token, user } = seedUser(app, { nickname: '阿灯' })
    const r = await req(srv.base, 'GET', '/api/me', { token })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.id, user.id)
    assert.equal(r.body.user.nickname, '阿灯')
    assert.equal(r.body.user.role, 'user')
    assert.equal(r.body.user.openid, undefined)
  })
})

test('PATCH /me：改昵称与头像；非法头像被拒', async () => {
  await withApp(async ({ app, srv }) => {
    const { token } = seedUser(app)
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

    let r = await req(srv.base, 'PATCH', '/api/me', { token, body: { nickname: '新名字', avatar: png } })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.nickname, '新名字')
    assert.equal(r.body.user.avatar, png)

    r = await req(srv.base, 'PATCH', '/api/me', { token, body: { avatar: 'http://evil/x.png' } })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.message, '头像需为图片 data URL')

    r = await req(srv.base, 'PATCH', '/api/me', { token, body: {} })
    assert.equal(r.status, 400)

    // 昵称超长被截断而不是报错（用户输入不该因长度失败）
    r = await req(srv.base, 'PATCH', '/api/me', { token, body: { nickname: 'x'.repeat(100) } })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.nickname.length, 32)
  })
})

test('退出登录后 token 立即失效', async () => {
  await withApp(async ({ app, srv }) => {
    const { token } = seedUser(app)
    assert.equal((await req(srv.base, 'GET', '/api/me', { token })).status, 200)
    assert.equal((await req(srv.base, 'POST', '/api/auth/logout', { token })).status, 200)
    const after = await req(srv.base, 'GET', '/api/me', { token })
    assert.equal(after.status, 401)
  })
})

test('设备：新增幂等（同 deviceId 不重复建行）、改名、删除', async () => {
  await withApp(async ({ app, srv }) => {
    const { token } = seedUser(app)

    let r = await req(srv.base, 'POST', '/api/devices', { token, body: { deviceId: 'AA:BB:CC', name: '客厅' } })
    assert.equal(r.status, 200)
    const firstId = r.body.device.id
    assert.equal(r.body.device.name, '客厅')

    // 同 deviceId 再来一次 = 更新，不是新行
    r = await req(srv.base, 'POST', '/api/devices', { token, body: { deviceId: 'AA:BB:CC', name: '客厅2' } })
    assert.equal(r.body.device.id, firstId)
    assert.equal(r.body.device.name, '客厅2')

    r = await req(srv.base, 'GET', '/api/devices', { token })
    assert.equal(r.body.devices.length, 1)

    r = await req(srv.base, 'PATCH', `/api/devices/${firstId}`, { token, body: { name: '书房' } })
    assert.equal(r.body.device.name, '书房')

    r = await req(srv.base, 'PATCH', `/api/devices/${firstId}`, { token, body: { firmwareVersion: '0.5' } })
    assert.equal(r.body.device.firmwareVersion, '0.5')

    r = await req(srv.base, 'DELETE', `/api/devices/${firstId}`, { token })
    assert.equal(r.status, 200)
    r = await req(srv.base, 'GET', '/api/devices', { token })
    assert.equal(r.body.devices.length, 0)
  })
})

test('设备：缺 deviceId → 400；他人设备不可改（404 不泄漏存在性）', async () => {
  await withApp(async ({ app, srv }) => {
    const a = seedUser(app)
    const b = seedUser(app)
    let r = await req(srv.base, 'POST', '/api/devices', { token: a.token, body: { deviceId: 'DEV-A' } })
    const devId = r.body.device.id

    r = await req(srv.base, 'POST', '/api/devices', { token: a.token, body: {} })
    assert.equal(r.status, 400)

    // B 改 A 的设备：404
    r = await req(srv.base, 'PATCH', `/api/devices/${devId}`, { token: b.token, body: { name: 'hack' } })
    assert.equal(r.status, 404)
    r = await req(srv.base, 'DELETE', `/api/devices/${devId}`, { token: b.token })
    assert.equal(r.status, 404)

    // 两个用户可以有同一台物理设备（各自一行）
    r = await req(srv.base, 'POST', '/api/devices', { token: b.token, body: { deviceId: 'DEV-A', name: 'B 的' } })
    assert.equal(r.status, 200)
    assert.notEqual(r.body.device.id, devId)
  })
})

test('后台登录：密码错/非管理员被拒，正确凭据发 token', async () => {
  await withApp(async ({ app, srv }) => {
    let r = await req(srv.base, 'POST', '/api/admin/login', { body: { username: 'root', password: 'nope' } })
    assert.equal(r.status, 401)
    assert.equal(r.body.error.message, '用户名或密码不正确')

    // 普通用户即使知道用户名也不能进后台
    const u = seedUser(app)
    app.locals.db
      .prepare("update users set username='normal', password_hash=? where id=?")
      .run(auth.hashPassword('pw'), u.user.id)
    r = await req(srv.base, 'POST', '/api/admin/login', { body: { username: 'normal', password: 'pw' } })
    assert.equal(r.status, 401)

    r = await req(srv.base, 'POST', '/api/admin/login', { body: { username: 'root', password: 'rootpass' } })
    assert.equal(r.status, 200)
    assert.ok(r.body.token)
    assert.equal(r.body.user.role, 'admin')
  })
})

test('后台：普通用户 token 访问 admin 接口 → 403', async () => {
  await withApp(async ({ app, srv }) => {
    const { token } = seedUser(app)
    for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/devices', '/api/admin/audit']) {
      const r = await req(srv.base, 'GET', path, { token })
      assert.equal(r.status, 403)
      assert.equal(r.body.error.message, '需要管理员权限')
    }
  })
})

test('后台概览：计数 + 图表数据（趋势/增长/分布）一次返回', async () => {
  await withApp(async ({ app, srv }) => {
    const token = adminToken(app)
    const a = seedUser(app, { nickname: '甲' })
    const b = seedUser(app, { nickname: '乙' })
    await req(srv.base, 'POST', '/api/devices', { token: a.token, body: { deviceId: 'D1', name: '客厅' } })
    // 打一些遥测点，验证图表有数据
    await req(srv.base, 'POST', '/api/telemetry', {
      token: a.token,
      body: {
        events: [
          { metric: 'app.launch' },
          { metric: 'ble.connect.ok' },
          { metric: 'ble.mtu', value: 509 },
          { metric: 'error', dim: '10001' },
        ],
      },
    })

    let r = await req(srv.base, 'GET', '/api/admin/overview?days=7', { token })
    assert.equal(r.status, 200)
    const d = r.body
    assert.equal(d.totalUsers, 2) // 不含 admin
    assert.equal(d.totalDevices, 1)
    assert.equal(d.disabledUsers, 0)
    assert.equal(d.errorsToday, 1)
    // 图表结构
    assert.equal(d.trend.days.length, 7)
    assert.ok(Array.isArray(d.trend.series['ble.connect.ok']))
    assert.equal(d.trend.series['ble.connect.ok'].at(-1), 1) // 今天
    assert.equal(d.userGrowth.days.length, 7)
    assert.equal(d.userGrowth.totalUsers.at(-1), 2)
    assert.equal(d.deviceGrowth.totalDevices.at(-1), 1)
    assert.ok(Array.isArray(d.firmwareVersions))
    assert.equal(d.mtuHistogram.total, 1)
    assert.ok(d.mtuHistogram.buckets.length === 8)
    assert.equal(d.dims.error[0].dim, '10001')

    // 无图表的精简版（脚本/curl 用）
    r = await req(srv.base, 'GET', '/api/admin/counts', { token })
    assert.equal(r.body.totalUsers, 2)

    r = await req(srv.base, 'GET', '/api/admin/users', { token })
    assert.equal(r.body.total, 3) // 含 admin 行
    const byName = r.body.items.find((u) => u.nickname === '甲')
    assert.equal(byName.deviceCount, 1)
    assert.equal(byName.openid, undefined)

    r = await req(srv.base, 'GET', '/api/admin/users?keyword=甲', { token })
    assert.equal(r.body.total, 1)

    r = await req(srv.base, 'PATCH', `/api/admin/users/${b.user.id}`, { token, body: { status: 'disabled' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.user.status, 'disabled')

    // 禁用后原用户 token 立即失效
    r = await req(srv.base, 'GET', '/api/me', { token: b.token })
    assert.equal(r.status, 401)

    r = await req(srv.base, 'GET', '/api/admin/users?status=disabled', { token })
    assert.equal(r.body.total, 1)
    assert.equal(r.body.items[0].id, b.user.id)
  })
})

test('后台：不能停用最后一个管理员', async () => {
  await withApp(async ({ app, srv }) => {
    const token = adminToken(app)
    const root = models.findUserByUsername(app.locals.db, 'root')
    const r = await req(srv.base, 'PATCH', `/api/admin/users/${root.id}`, { token, body: { status: 'disabled' } })
    assert.equal(r.status, 400)
    assert.match(r.body.error.message, /唯一的管理员/)
  })
})

test('后台：设备列表与删除，写操作落审计日志', async () => {
  await withApp(async ({ app, srv }) => {
    const admin = adminToken(app)
    // 真走一次后台登录，审计里应留下 admin.login
    const login = await req(srv.base, 'POST', '/api/admin/login', { body: { username: 'root', password: 'rootpass' } })
    assert.equal(login.status, 200)
    // 错密码也留痕（便于排查暴力尝试）
    await req(srv.base, 'POST', '/api/admin/login', { body: { username: 'root', password: 'wrong' } })

    const u = seedUser(app, { nickname: '丙' })
    const created = await req(srv.base, 'POST', '/api/devices', { token: u.token, body: { deviceId: 'D9', name: '阳台' } })
    const devId = created.body.device.id

    let r = await req(srv.base, 'GET', '/api/admin/devices', { token: admin })
    assert.equal(r.body.total, 1)
    assert.equal(r.body.items[0].ownerNickname, '丙')

    r = await req(srv.base, 'GET', `/api/admin/devices?userId=${u.user.id}`, { token: admin })
    assert.equal(r.body.total, 1)
    r = await req(srv.base, 'GET', '/api/admin/devices?keyword=阳台', { token: admin })
    assert.equal(r.body.total, 1)

    r = await req(srv.base, 'DELETE', `/api/admin/devices/${devId}`, { token: admin })
    assert.equal(r.status, 200)

    r = await req(srv.base, 'GET', '/api/admin/audit', { token: admin })
    const actions = r.body.items.map((i) => i.action)
    assert.ok(actions.includes('admin.login'), `actions=${actions.join(',')}`)
    assert.ok(actions.includes('admin.login_failed'), `actions=${actions.join(',')}`)
    assert.ok(actions.includes('device.delete'), `actions=${actions.join(',')}`)
    assert.equal(r.body.total, actions.length)
  })
})

test('遥测：白名单字典、批量上报、非法指标被拒', async () => {
  await withApp(async ({ srv }) => {
    // 字典：前端据此渲染指标选择器（不硬编码）
    let r = await req(srv.base, 'GET', '/api/telemetry/metrics')
    assert.equal(r.status, 200)
    assert.ok(r.body.items.length >= 15)
    const first = r.body.items[0]
    assert.ok(first.metric && first.unit && first.describe)

    // 未登录也能上报（登录前的启动/扫描数据同样有价值）
    r = await req(srv.base, 'POST', '/api/telemetry', {
      body: {
        events: [
          { metric: 'app.launch' },
          { metric: 'nope.nope' },
          { metric: 'ble.mtu', value: 509 },
          { metric: 'config.bytes', value: 'bad' },
        ],
      },
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { accepted: 2, rejected: 2 })

    // events 非数组 → 400
    r = await req(srv.base, 'POST', '/api/telemetry', { body: { events: 'x' } })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.message, 'events 需为数组')
  })
})

test('遥测聚合：/admin/telemetry 与 /admin/errors 的形状（防结构错位回归）', async () => {
  await withApp(async ({ app, srv }) => {
    const admin = adminToken(app)
    const u = seedUser(app)
    await req(srv.base, 'POST', '/api/telemetry', {
      token: u.token,
      body: {
        events: [
          { metric: 'app.launch', dim: 'real' },
          { metric: 'app.launch', dim: 'sim' },
          { metric: 'ble.connect.ok' },
          { metric: 'error', dim: '10001' },
          { metric: 'ble.mtu', value: 509 },
          { metric: 'ble.rssi', value: -62 },
          { metric: 'ota.bytes', value: 1000000 },
        ],
      },
    })

    // /admin/telemetry：series 只装指标数组，日期轴在 seriesDays
    let r = await req(srv.base, 'GET', '/api/admin/telemetry?days=3&metrics=app.launch,error', { token: admin })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.metrics, ['app.launch', 'error'])
    assert.equal(r.body.seriesDays.length, 3)
    // 关键：series 的键就是指标名（不是 { days, series } 嵌套）
    assert.deepEqual(Object.keys(r.body.series).sort(), ['app.launch', 'error'])
    assert.equal(r.body.series['app.launch'].at(-1), 2)
    assert.equal(r.body.series.error.at(-1), 1)
    assert.equal(r.body.dims['app.launch'][0].dim, r.body.dims['app.launch'][0].dim) // 有维度行
    assert.ok(r.body.dims['app.launch'].length === 2)

    // 指标名全非法 → 400（不静默回落：前端传错名字应该暴露出来）
    r = await req(srv.base, 'GET', '/api/admin/telemetry?metrics=bogus', { token: admin })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.message, '没有合法指标')

    // 不传 metrics → 用默认指标集
    r = await req(srv.base, 'GET', '/api/admin/telemetry?days=3', { token: admin })
    assert.equal(r.status, 200)
    assert.ok(r.body.metrics.length > 0)

    // /admin/errors：同样的扁平结构
    r = await req(srv.base, 'GET', '/api/admin/errors?days=3', { token: admin })
    assert.equal(r.status, 200)
    assert.equal(r.body.seriesDays.length, 3)
    assert.ok(Object.prototype.hasOwnProperty.call(r.body.series, 'error'))
    assert.equal(r.body.series.error.at(-1), 1)
    assert.equal(r.body.codes[0].dim, '10001')
    assert.equal(r.body.mtu.total, 1)
    assert.equal(r.body.rssi.total, 1)
    assert.equal(r.body.otaBytes.length, 1)
    assert.equal(r.body.otaBytes[0].v, 1000000)
  })
})

test('后台：手动触发日汇总（幂等，落审计）', async () => {
  await withApp(async ({ app, srv }) => {
    const admin = adminToken(app)
    // rollup 默认是"昨天"：灌一条昨天的事件才是有效断言；今天的事件不计入。
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const ySec = Math.floor(Date.parse(`${yesterday}T12:00:00Z`) / 1000)
    await req(srv.base, 'POST', '/api/telemetry', {
      body: { events: [{ metric: 'app.launch', at: ySec }, { metric: 'app.launch', at: ySec }] },
    })

    let r = await req(srv.base, 'POST', '/api/admin/rollup', { token: admin, body: {} })
    assert.equal(r.status, 200)
    assert.equal(r.body.day, yesterday)
    assert.ok(r.body.metrics >= 1, `metrics=${r.body.metrics}`)

    // 指定日 + 非法日
    r = await req(srv.base, 'POST', '/api/admin/rollup', { token: admin, body: { day: yesterday } })
    assert.equal(r.status, 200)
    r = await req(srv.base, 'POST', '/api/admin/rollup', { token: admin, body: { day: 'bad-day' } })
    assert.equal(r.status, 400)
    assert.match(r.body.error.message, /YYYY-MM-DD/)

    r = await req(srv.base, 'GET', '/api/admin/audit', { token: admin })
    assert.ok(r.body.items.some((i) => i.action === 'telemetry.rollup'))
  })
})

test('未知路径 → 404 统一错误体', async () => {
  await withApp(async ({ srv }) => {
    const r = await req(srv.base, 'GET', '/api/nope')
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'NOT_FOUND')
  })
})

test('两个用户互相看不见对方设备', async () => {
  await withApp(async ({ app, srv }) => {
    const a = seedUser(app)
    const b = seedUser(app)
    await req(srv.base, 'POST', '/api/devices', { token: a.token, body: { deviceId: 'X1' } })
    await req(srv.base, 'POST', '/api/devices', { token: b.token, body: { deviceId: 'X2' } })
    const ra = await req(srv.base, 'GET', '/api/devices', { token: a.token })
    const rb = await req(srv.base, 'GET', '/api/devices', { token: b.token })
    assert.deepEqual(ra.body.devices.map((d) => d.deviceId), ['X1'])
    assert.deepEqual(rb.body.devices.map((d) => d.deviceId), ['X2'])
  })
})

test('健康检查用的 dbPath 是临时文件（不污染仓库）', async () => {
  const { app, dbPath } = makeApp()
  assert.ok(dbPath.includes('btl-'))
  app.locals.db.close()
  cleanup(tmpDbPath('throwaway'))
})
