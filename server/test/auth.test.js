// 认证与工具函数单测：scrypt、会话过期、微信错误码映射、限流。

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const auth = require('../src/auth')
const { createRateLimiter, pageQuery, strField, intField } = require('../src/http')
const { open, nowSec } = require('../src/db')
const { tmpDbPath, cleanup } = require('./helpers')

test('scrypt：正确密码通过，错误密码/损坏串拒绝', () => {
  const stored = auth.hashPassword('hunter2')
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
  assert.equal(auth.verifyPassword('hunter2', stored), true)
  assert.equal(auth.verifyPassword('hunter3', stored), false)
  assert.equal(auth.verifyPassword('hunter2', 'garbage'), false)
  assert.equal(auth.verifyPassword('hunter2', 'scrypt$00$00'), false)
})

test('同一密码两次哈希不同（salt 随机）', () => {
  assert.notEqual(auth.hashPassword('x'), auth.hashPassword('x'))
})

test('会话：签发/解析/吊销', () => {
  const dbPath = tmpDbPath('auth')
  const db = open(dbPath)
  try {
    db.prepare("insert into users (openid, nickname, role, status, created_at) values ('o1','n','user','active',?)").run(
      nowSec(),
    )
    const userId = db.prepare("select id from users where openid='o1'").get().id
    const s = auth.createSession(db, userId, 1)
    const resolved = auth.resolveSession(db, s.token)
    assert.equal(resolved.user.id, userId)

    auth.deleteSession(db, s.token)
    assert.equal(auth.resolveSession(db, s.token), null)
  } finally {
    db.close()
    cleanup(dbPath)
  }
})

test('会话：禁用用户后 token 立即失效', () => {
  const dbPath = tmpDbPath('auth2')
  const db = open(dbPath)
  try {
    db.prepare("insert into users (openid, nickname, role, status, created_at) values ('o2','n','user','active',?)").run(
      nowSec(),
    )
    const userId = db.prepare("select id from users where openid='o2'").get().id
    const s = auth.createSession(db, userId, 1)
    db.prepare("update users set status='disabled' where id=?").run(userId)
    assert.equal(auth.resolveSession(db, s.token), null)
  } finally {
    db.close()
    cleanup(dbPath)
  }
})

test('会话：过期 token 被清掉', () => {
  const dbPath = tmpDbPath('auth3')
  const db = open(dbPath)
  try {
    db.prepare("insert into users (openid, nickname, role, status, created_at) values ('o3','n','user','active',?)").run(
      nowSec(),
    )
    const userId = db.prepare("select id from users where openid='o3'").get().id
    db.prepare('insert into sessions (token, user_id, created_at, expires_at) values (?,?,?,?)').run(
      'expired-token',
      userId,
      nowSec() - 100,
      nowSec() - 1,
    )
    assert.equal(auth.resolveSession(db, 'expired-token'), null)
    const left = db.prepare("select count(*) c from sessions where token='expired-token'").get().c
    assert.equal(left, 0)
  } finally {
    db.close()
    cleanup(dbPath)
  }
})

test('code2Session：缺凭据 → 500 可读文案（不静默放行）', async () => {
  await assert.rejects(
    () => auth.code2Session('', '', 'code'),
    (err) => {
      assert.equal(err.status, 500)
      assert.match(err.message, /未配置微信凭据/)
      return true
    },
  )
})

test('code2Session：缺 code → 400', async () => {
  await assert.rejects(
    () => auth.code2Session('appid', 'secret', '   '),
    (err) => {
      assert.equal(err.status, 400)
      return true
    },
  )
})

test('code2Session：微信 errcode → 中文可读（不透出裸码）', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errcode: 40163, errmsg: 'code been used' }),
  })
  await assert.rejects(
    () => auth.code2Session('appid', 'secret', 'bad-code', { fetch: fakeFetch }),
    (err) => {
      assert.equal(err.status, 400)
      assert.equal(err.message, '登录凭证已被使用，请重试')
      return true
    },
  )
})

test('code2Session：未知 errcode 也有可读文案', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ errcode: 99999 }) })
  await assert.rejects(
    () => auth.code2Session('appid', 'secret', 'x', { fetch: fakeFetch }),
    (err) => {
      assert.match(err.message, /微信登录失败（99999）/)
      return true
    },
  )
})

test('code2Session：成功返回 openid/unionid', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ openid: 'OPENID', session_key: 'sk', unionid: 'UNION' }),
  })
  const r = await auth.code2Session('appid', 'secret', 'good', { fetch: fakeFetch })
  assert.deepEqual(r, { openid: 'OPENID', unionid: 'UNION' })
})

test('code2Session：网络失败 → 502 可读文案', async () => {
  const fakeFetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  await assert.rejects(
    () => auth.code2Session('appid', 'secret', 'c', { fetch: fakeFetch }),
    (err) => {
      assert.equal(err.status, 502)
      assert.match(err.message, /无法连接微信服务器/)
      return true
    },
  )
})

test('限流：窗口内超限后拒绝，窗口外恢复', () => {
  const hit = createRateLimiter({ limit: 2, windowMs: 30 })
  assert.equal(hit('ip'), true)
  assert.equal(hit('ip'), true)
  assert.equal(hit('ip'), false)
  assert.equal(hit('other-ip'), true)
  // 窗口过期（用一个明显过期的对象替身不方便，这里直接等一小会）。
  const start = Date.now()
  while (Date.now() - start < 40) {
    /* spin */
  }
  assert.equal(hit('ip'), true)
})

test('入参：strField 截断/空值，intField 越界回落', () => {
  assert.equal(strField('  hi  ', { max: 10 }), 'hi')
  assert.equal(strField('   '), null)
  assert.equal(strField('', { allowEmpty: true }), '')
  assert.equal(strField('abcdef', { max: 3 }), 'abc')
  assert.equal(strField(123), null)

  assert.equal(intField('12', { min: 1 }), 12)
  assert.equal(intField('0', { min: 1, fallback: null }), null)
  assert.equal(intField('abc', { fallback: 7 }), 7)
  assert.equal(intField(2.5, { fallback: null }), null)
})

test('分页：非法入参回落到首页/默认条数，超上限被钳制', () => {
  assert.deepEqual(pageQuery({}), { page: 1, size: 20, offset: 0 })
  assert.deepEqual(pageQuery({ page: '3', size: '10' }), { page: 3, size: 10, offset: 20 })
  assert.deepEqual(pageQuery({ page: '-8', size: '999' }), { page: 1, size: 100, offset: 0 })
  assert.deepEqual(pageQuery({ page: 'x' }, { defaultSize: 7 }), { page: 1, size: 7, offset: 0 })
})
