// SQLite 访问层（ADR-0035）：node:sqlite 内置模块，零原生依赖。
//
// 为什么用 node:sqlite 而不是 better-sqlite3：服务器上 `npm ci --omit=dev`
// 不碰编译工具链，Node 22 已内置（实测 v22.22.2 可用）。代价是启动时带
// ExperimentalWarning，用 --no-warnings 屏蔽（见 systemd unit）。
//
// 表结构与迁移都幂等：每次启动跑一遍，已存在则无操作。

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const SCHEMA = `
create table if not exists users (
  id            integer primary key autoincrement,
  openid        text    not null unique,
  unionid       text,
  nickname      text    not null default '',
  avatar        text    not null default '',
  role          text    not null default 'user' check (role in ('user','admin')),
  status        text    not null default 'active' check (status in ('active','disabled')),
  username      text    unique,
  password_hash text,
  created_at    integer not null,
  last_login_at integer
);

create table if not exists sessions (
  token      text primary key,
  user_id    integer not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
);
create index if not exists idx_sessions_user on sessions(user_id);

create table if not exists devices (
  id                   integer primary key autoincrement,
  user_id              integer not null references users(id) on delete cascade,
  device_id            text    not null,
  name                 text    not null default '',
  firmware_version     text,
  firmware_version_at  integer,
  created_at           integer not null,
  last_seen_at         integer not null,
  unique (user_id, device_id)
);
create index if not exists idx_devices_user on devices(user_id);

create table if not exists audit_log (
  id      integer primary key autoincrement,
  actor   text    not null,
  action  text    not null,
  target  text    not null default '',
  detail  text    not null default '',
  ip      text    not null default '',
  at      integer not null
);
create index if not exists idx_audit_at on audit_log(at desc);
`

// 遥测（ADR-0037）：事件表 + 日汇总。定义放在这里而不是 telemetry.js，
// 因为 db.js 是 schema 的唯一入口（telemetry.js require db.js，反向 require
// 会在模块初始化期拿到 undefined）。
const TELEMETRY_SCHEMA = `
create table if not exists telemetry (
  id      integer primary key autoincrement,
  user_id integer references users(id) on delete set null,
  metric  text    not null,
  dim     text    not null default '',
  value   real    not null default 1,
  at      integer not null
);
create index if not exists idx_telemetry_metric_at on telemetry(metric, at desc);
create index if not exists idx_telemetry_at on telemetry(at desc);
create index if not exists idx_telemetry_user on telemetry(user_id);

create table if not exists daily_stats (
  day        text    not null,
  metric     text    not null,
  events     integer not null default 0,
  total      real    not null default 0,
  users      integer not null default 0,
  updated_at integer not null,
  primary key (day, metric)
);
`

const SCHEMA_ALL = SCHEMA + TELEMETRY_SCHEMA

let _db = null

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  // WAL 让读写不互相阻塞（读多写少的后台场景收益明显）。
  if (dbPath !== ':memory:') db.exec('pragma journal_mode = wal')
  db.exec('pragma foreign_keys = on')
  db.exec('pragma busy_timeout = 5000')
  db.exec(SCHEMA_ALL)
  return db
}

// 进程级单例（server.js 用）。测试各自建自己的 DB，不用这个。
function getDb(dbPath) {
  if (!_db) _db = open(dbPath)
  return _db
}

function closeDb() {
  if (_db) {
    _db.close()
    _db = null
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

module.exports = { open, getDb, closeDb, nowSec }
