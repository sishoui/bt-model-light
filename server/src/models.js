// 业务模型：用户 / 设备（ADR-0035）。
//
// 只有这一层碰 SQL 语句细节，路由层只调这里。所有返回值都是对外可直接
// JSON 化的形状（不泄漏 password_hash / openid 之外的内网字段）。

'use strict'

const { nowSec } = require('./db')

// ---- 序列化 ----------------------------------------------------------------

// openid 不在用户列表里回显（后台也不需要）；只给 id/昵称/头像/状态。
function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    nickname: row.nickname || '',
    avatar: row.avatar || '',
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
  }
}

function publicDevice(row) {
  if (!row) return null
  return {
    id: row.id,
    deviceId: row.device_id,
    name: row.name || '',
    firmwareVersion: row.firmware_version || '',
    firmwareVersionAt: row.firmware_version_at || null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

// ---- 用户 ------------------------------------------------------------------

function findUserByOpenid(db, openid) {
  return db.prepare('select * from users where openid = ?').get(openid)
}

function findUserById(db, id) {
  return db.prepare('select * from users where id = ?').get(id)
}

// 首次登录即注册；openid 是唯一身份键（微信侧稳定）。
function upsertUserByOpenid(db, openid, unionid) {
  const now = nowSec()
  const existing = findUserByOpenid(db, openid)
  if (existing) {
    db.prepare('update users set last_login_at = ?, unionid = coalesce(?, unionid) where id = ?').run(
      now,
      unionid || null,
      existing.id,
    )
    return findUserById(db, existing.id)
  }
  db.prepare(
    `insert into users (openid, unionid, nickname, avatar, role, status, created_at, last_login_at)
     values (?, ?, '', '', 'user', 'active', ?, ?)`,
  ).run(openid, unionid || null, now, now)
  return findUserByOpenid(db, openid)
}

function updateUserProfile(db, id, { nickname, avatar }) {
  const sets = []
  const args = []
  if (nickname !== undefined) {
    sets.push('nickname = ?')
    args.push(nickname)
  }
  if (avatar !== undefined) {
    sets.push('avatar = ?')
    args.push(avatar)
  }
  if (!sets.length) return findUserById(db, id)
  args.push(id)
  db.prepare(`update users set ${sets.join(', ')} where id = ?`).run(...args)
  return findUserById(db, id)
}

function touchLogin(db, id) {
  db.prepare('update users set last_login_at = ? where id = ?').run(nowSec(), id)
}

function setUserStatus(db, id, status) {
  db.prepare('update users set status = ? where id = ?').run(status, id)
  return findUserById(db, id)
}

// 管理后台初始管理员：users 表里没有 admin 角色时才建（幂等）。
function ensureInitAdmin(db, username, password, hashPassword) {
  if (!username || !password) return null
  const existing = db.prepare("select * from users where role = 'admin' limit 1").get()
  if (existing) return null
  const now = nowSec()
  // admins 也有 openid 唯一键：用 `admin:<username>` 占位，与微信 openid 不冲突。
  db.prepare(
    `insert into users (openid, nickname, avatar, role, status, username, password_hash, created_at)
     values (?, ?, '', 'admin', 'active', ?, ?, ?)`,
  ).run(`admin:${username}`, username, username, hashPassword(password), now)
  return db.prepare('select * from users where username = ?').get(username)
}

function findUserByUsername(db, username) {
  return db.prepare('select * from users where username = ?').get(username)
}

// ---- 设备 ------------------------------------------------------------------

function listDevicesForUser(db, userId) {
  return db.prepare('select * from devices where user_id = ? order by last_seen_at desc').all(userId)
}

function findDeviceForUser(db, userId, deviceId) {
  return db.prepare('select * from devices where user_id = ? and device_id = ?').get(userId, deviceId)
}

function findDeviceById(db, id) {
  return db.prepare('select * from devices where id = ?').get(id)
}

// 按 BLE deviceId 去重：同一 -- 用户同一物理设备只有一行。
function upsertDevice(db, userId, deviceId, { name, firmwareVersion } = {}) {
  const now = nowSec()
  const existing = findDeviceForUser(db, userId, deviceId)
  if (existing) {
    const sets = ['last_seen_at = ?']
    const args = [now]
    if (name !== undefined) {
      sets.push('name = ?')
      args.push(name)
    }
    if (firmwareVersion !== undefined) {
      sets.push('firmware_version = ?', 'firmware_version_at = ?')
      args.push(firmwareVersion, now)
    }
    args.push(existing.id)
    db.prepare(`update devices set ${sets.join(', ')} where id = ?`).run(...args)
    return findDeviceById(db, existing.id)
  }
  db.prepare(
    `insert into devices (user_id, device_id, name, firmware_version, firmware_version_at, created_at, last_seen_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, deviceId, name || '', firmwareVersion || null, firmwareVersion ? now : null, now, now)
  return findDeviceForUser(db, userId, deviceId)
}

function renameDevice(db, id, name) {
  db.prepare('update devices set name = ? where id = ?').run(name, id)
  return findDeviceById(db, id)
}

function touchDevice(db, id) {
  db.prepare('update devices set last_seen_at = ? where id = ?').run(nowSec(), id)
}

function setDeviceFirmwareVersion(db, id, version) {
  const now = nowSec()
  db.prepare('update devices set firmware_version = ?, firmware_version_at = ?, last_seen_at = ? where id = ?').run(
    String(version || ''),
    now,
    now,
    id,
  )
  return findDeviceById(db, id)
}

function deleteDevice(db, id) {
  db.prepare('delete from devices where id = ?').run(id)
}

// ---- 后台查询 --------------------------------------------------------------

function overviewCounts(db) {
  const dayAgo = nowSec() - 86400
  const totalUsers = db.prepare("select count(*) c from users where role = 'user'").get().c
  const disabledUsers = db
    .prepare("select count(*) c from users where role = 'user' and status = 'disabled'")
    .get().c
  const activeUsers = db
    .prepare("select count(*) c from users where role = 'user' and last_login_at >= ?")
    .get(dayAgo).c
  const totalDevices = db.prepare('select count(*) c from devices').get().c
  const devices24h = db.prepare('select count(*) c from devices where last_seen_at >= ?').get(dayAgo).c
  return { totalUsers, disabledUsers, activeUsers24h: activeUsers, totalDevices, devices24h }
}

// ---- 增长曲线（后台图表） ----------------------------------------------------

// 最近 N 天每日新增用户 + 累计用户。UTC 日界（与 telemetry 的 day 口径一致）。
function userGrowth(db, days) {
  const n = Math.max(1, Math.min(365, Number(days) || 14))
  const dayKeys = []
  for (let i = n - 1; i >= 0; i--) {
    dayKeys.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
  }
  const base = db
    .prepare("select count(*) c from users where role='user' and created_at < ?")
    .get(Math.floor(Date.UTC(...parseDay(dayKeys[0])) / 1000)).c
  const rows = db
    .prepare(
      `select substr(datetime(created_at,'unixepoch'),1,10) d, count(*) c
         from users where role='user' and created_at >= ? group by d`,
    )
    .all(Math.floor(Date.UTC(...parseDay(dayKeys[0])) / 1000))
  const byDay = new Map(rows.map((r) => [r.d, r.c]))
  let cum = base
  const newPerDay = []
  const totalPerDay = []
  for (const d of dayKeys) {
    const c = byDay.get(d) || 0
    newPerDay.push(c)
    cum += c
    totalPerDay.push(cum)
  }
  return { days: dayKeys, newUsers: newPerDay, totalUsers: totalPerDay }
}

// 每日新增设备 + 累计设备。
function deviceGrowth(db, days) {
  const n = Math.max(1, Math.min(365, Number(days) || 14))
  const dayKeys = []
  for (let i = n - 1; i >= 0; i--) {
    dayKeys.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10))
  }
  const start = Math.floor(Date.UTC(...parseDay(dayKeys[0])) / 1000)
  const base = db.prepare('select count(*) c from devices where created_at < ?').get(start).c
  const rows = db
    .prepare(
      `select substr(datetime(created_at,'unixepoch'),1,10) d, count(*) c
         from devices where created_at >= ? group by d`,
    )
    .all(start)
  const byDay = new Map(rows.map((r) => [r.d, r.c]))
  let cum = base
  const newPerDay = []
  const totalPerDay = []
  for (const d of dayKeys) {
    const c = byDay.get(d) || 0
    newPerDay.push(c)
    cum += c
    totalPerDay.push(cum)
  }
  return { days: dayKeys, newDevices: newPerDay, totalDevices: totalPerDay }
}

// 'YYYY-MM-DD' → [year, monthIndex, day]（喂给 Date.UTC）。
function parseDay(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''))
  if (!m) return [1970, 0, 1]
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
}

function searchUsers(db, { keyword, status, limit, offset }) {
  const where = []
  const args = []
  if (status === 'active' || status === 'disabled') {
    where.push('status = ?')
    args.push(status)
  }
  if (keyword) {
    where.push('(nickname like ? or openid like ? or username like ?)')
    const like = `%${keyword}%`
    args.push(like, like, like)
  }
  const clause = where.length ? `where ${where.join(' and ')}` : ''
  const total = db.prepare(`select count(*) c from users ${clause}`).get(...args).c
  const rows = db
    .prepare(
      `select * from users ${clause} order by
         case role when 'admin' then 0 else 1 end, id desc limit ? offset ?`,
    )
    .all(...args, limit, offset)
  // 每行带设备数，后台列表一眼能看出"这个用户有没有设备"。
  const counts = new Map()
  for (const r of db.prepare('select user_id, count(*) c from devices group by user_id').all()) {
    counts.set(r.user_id, r.c)
  }
  return {
    total,
    items: rows.map((r) => Object.assign(publicUser(r), { deviceCount: counts.get(r.id) || 0 })),
  }
}

function searchDevices(db, { keyword, userId, limit, offset }) {
  const where = []
  const args = []
  if (userId) {
    where.push('d.user_id = ?')
    args.push(userId)
  }
  if (keyword) {
    where.push('(d.name like ? or d.device_id like ?)')
    const like = `%${keyword}%`
    args.push(like, like)
  }
  const clause = where.length ? `where ${where.join(' and ')}` : ''
  const total = db.prepare(`select count(*) c from devices d ${clause}`).get(...args).c
  const rows = db
    .prepare(
      `select d.*, u.nickname as owner_nickname, u.openid as owner_openid
         from devices d join users u on u.id = d.user_id
         ${clause} order by d.last_seen_at desc limit ? offset ?`,
    )
    .all(...args, limit, offset)
  return {
    total,
    items: rows.map((r) =>
      Object.assign(publicDevice(r), {
        userId: r.user_id,
        ownerNickname: r.owner_nickname || '',
        ownerOpenid: r.owner_openid || '',
      }),
    ),
  }
}

function listAudit(db, { limit, offset }) {
  const total = db.prepare('select count(*) c from audit_log').get().c
  const items = db
    .prepare('select * from audit_log order by at desc, id desc limit ? offset ?')
    .all(limit, offset)
  return { total, items }
}

module.exports = {
  publicUser,
  publicDevice,
  findUserByOpenid,
  findUserById,
  findUserByUsername,
  upsertUserByOpenid,
  updateUserProfile,
  touchLogin,
  setUserStatus,
  ensureInitAdmin,
  listDevicesForUser,
  findDeviceForUser,
  findDeviceById,
  upsertDevice,
  renameDevice,
  touchDevice,
  setDeviceFirmwareVersion,
  deleteDevice,
  overviewCounts,
  userGrowth,
  deviceGrowth,
  searchUsers,
  searchDevices,
  listAudit,
}
