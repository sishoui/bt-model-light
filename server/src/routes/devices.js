// 路由：设备归属同步（ADR-0035）。
//
// 定位：小程序本地 Storage 仍是 BLE 的真相源；这里是 best-effort 镜像，
// 用于换手机/重装后恢复设备清单与名称。因此接口按 BLE deviceId 幂等：
// 同一用户重复 POST 同一 deviceId = 更新（last_seen_at 前进），不报冲突。

'use strict'

const { ok, fail, handleError, strField, DEVICE_NAME_MAX, DEVICE_ID_MAX } = require('../http')
const models = require('../models')

function installDeviceRoutes(app, ctx) {
  const { db, log } = ctx

  function requireUser(req, res) {
    const session = ctx.sessionOf(req)
    if (!session) {
      fail(res, 401, 'UNAUTHORIZED', '请先登录')
      return null
    }
    return session
  }

  // GET /devices → { devices: [...] }（当前用户）
  app.get('/devices', (req, res) => {
    const session = requireUser(req, res)
    if (!session) return
    try {
      const rows = models.listDevicesForUser(db, session.user.id)
      return ok(res, { devices: rows.map(models.publicDevice) })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // POST /devices { deviceId, name?, firmwareVersion? } → { device }
  app.post('/devices', (req, res) => {
    const session = requireUser(req, res)
    if (!session) return
    try {
      const body = req.body || {}
      const deviceId = strField(body.deviceId, { max: DEVICE_ID_MAX })
      if (!deviceId) return fail(res, 400, 'INVALID_PARAMETER', '缺少设备标识')
      const name = body.name === undefined ? undefined : strField(body.name, { max: DEVICE_NAME_MAX, allowEmpty: true })
      if (name === null) return fail(res, 400, 'INVALID_PARAMETER', '设备名格式不正确')
      const firmwareVersion =
        body.firmwareVersion === undefined ? undefined : String(body.firmwareVersion || '').slice(0, 16)
      const row = models.upsertDevice(db, session.user.id, deviceId, { name, firmwareVersion })
      return ok(res, { device: models.publicDevice(row) })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // PATCH /devices/:id { name?, firmwareVersion? } → { device }
  app.patch('/devices/:id', (req, res) => {
    const session = requireUser(req, res)
    if (!session) return
    try {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'INVALID_PARAMETER', '设备 id 非法')
      const row = models.findDeviceById(db, id)
      // 只允许改自己的设备；不存在与不属于自己统一回 404，不泄漏他人 id 是否存在。
      if (!row || row.user_id !== session.user.id) return fail(res, 404, 'NOT_FOUND', '设备不存在')
      const body = req.body || {}
      if (body.name !== undefined) {
        const name = strField(body.name, { max: DEVICE_NAME_MAX, allowEmpty: true })
        if (name === null) return fail(res, 400, 'INVALID_PARAMETER', '设备名格式不正确')
        models.renameDevice(db, id, name)
      }
      if (body.firmwareVersion !== undefined) {
        models.setDeviceFirmwareVersion(db, id, String(body.firmwareVersion || '').slice(0, 16))
      }
      return ok(res, { device: models.publicDevice(models.findDeviceById(db, id)) })
    } catch (err) {
      handleError(res, err, log)
    }
  })

  // DELETE /devices/:id → { ok: true }
  app.delete('/devices/:id', (req, res) => {
    const session = requireUser(req, res)
    if (!session) return
    try {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'INVALID_PARAMETER', '设备 id 非法')
      const row = models.findDeviceById(db, id)
      if (!row || row.user_id !== session.user.id) return fail(res, 404, 'NOT_FOUND', '设备不存在')
      models.deleteDevice(db, id)
      return ok(res)
    } catch (err) {
      handleError(res, err, log)
    }
  })
}

module.exports = { installDeviceRoutes }
