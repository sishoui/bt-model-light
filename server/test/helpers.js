// 测试公共：临时 DB + 假微信 code2Session + 建用户/管理员。
//
// 每个测试文件用独立 DB 文件（os.tmpdir 下随机名），跑完删掉。
// 不 mock express：真的走一遍路由，断言 JSON 响应——这是"能自动跑"的底线。

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createApp } = require('../src/app')
const auth = require('../src/auth')
const models = require('../src/models')

function tmpDbPath(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `btl-${tag}-`))
  return path.join(dir, 'test.db')
}

function makeApp(overrides) {
  const dbPath = overrides && overrides.dbPath ? overrides.dbPath : tmpDbPath('app')
  const app = createApp(
    Object.assign(
      {
        dbPath,
        logLevel: 'error',
        wxAppId: 'wxtest',
        wxAppSecret: 'secrettest',
        tokenTtlDays: 7,
        adminInitUser: 'root',
        adminInitPassword: 'rootpass',
        // 测试不测限流（另有单测覆盖 limiter 本身），关掉避免累计撞 429。
        rateLimit: false,
      },
      overrides || {},
    ),
  )
  return { app, db: app.locals.db, dbPath }
}

// 起一个真实 HTTP listener（随机端口），返回 { base, close }。
// 用 Node 自带 fetch 打请求，不引 supertest。
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

async function req(base, method, pathname, { token, body, headers } = {}) {
  const h = Object.assign({}, headers || {})
  if (body !== undefined) h['content-type'] = 'application/json'
  if (token) h.authorization = `Bearer ${token}`
  const res = await fetch(base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  const text = await res.text()
  try {
    json = text ? JSON.parse(text) : null
  } catch (_e) {
    json = { raw: text }
  }
  return { status: res.status, body: json }
}

// 直接插一个用户并签发 token（跳过微信）——大多数用例关心的是数据面。
function seedUser(app, { openid = `openid-${Math.random().toString(36).slice(2, 10)}`, nickname = '' } = {}) {
  const db = app.locals.db
  const row = models.upsertUserByOpenid(db, openid, null)
  if (nickname) models.updateUserProfile(db, row.id, { nickname })
  const session = auth.createSession(db, row.id, 7)
  return { user: models.findUserById(db, row.id), token: session.token }
}

function adminToken(app, username = 'root', password = 'rootpass') {
  const db = app.locals.db
  const row = models.findUserByUsername(db, username)
  if (!row) throw new Error('admin not seeded')
  if (!auth.verifyPassword(password, row.password_hash)) throw new Error('bad admin password')
  return auth.createSession(db, row.id, 7).token
}

function cleanup(dirOrFile) {
  try {
    fs.rmSync(dirOrFile, { recursive: true, force: true })
  } catch (_e) {
    /* Windows 上偶发占用，忽略 */
  }
}

module.exports = { tmpDbPath, makeApp, listen, req, seedUser, adminToken, cleanup }
