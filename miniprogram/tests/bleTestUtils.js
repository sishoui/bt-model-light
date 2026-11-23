// 页面/BLE 测试公共辅助：帧构造、wx BLE 桩、flush。
//
// 帧构造与 frameParser.test.js 同构（独立 CRC 实现，不复用被测代码），
// 但收敛到一处供 home/device-list/bleClient 测试共享，消除三处复制。

'use strict'

const { OVERHEAD } = require('../utils/frameParser')
const { CMD, BLE } = require('../utils/protocol_gen')

// 独立构造一个合法帧字节（不依赖 encodeFrame，避免循环验证）。
function buildFrameBytes(cmd, seq, payload) {
  const bytes = payload || []
  const frame = new Uint8Array(OVERHEAD + bytes.length)
  frame[0] = 0xaa
  frame[1] = bytes.length & 0xff
  frame[2] = (bytes.length >> 8) & 0xff
  frame[3] = cmd
  frame[4] = seq
  for (let i = 0; i < bytes.length; i++) frame[5 + i] = bytes[i]
  let crc = 0xffff
  for (let i = 0; i < 5 + bytes.length; i++) {
    crc ^= frame[i] << 8
    crc &= 0xffff
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  frame[5 + bytes.length] = crc & 0xff
  frame[6 + bytes.length] = (crc >> 8) & 0xff
  return frame
}

// STATUS_NOTIFY 帧：status(1) code(1) seq(1) [data]（frame-spec.md 布局）。
function statusFrame(status, code, seq, data) {
  return buildFrameBytes(CMD.STATUS_NOTIFY, seq || 0, [status, code, seq].concat(data || []))
}

// 触发一次 notify 事件（value 为 ArrayBuffer，与真机一致）。
function notify(wx, value, deviceId) {
  const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  wx.__trigger('onBLECharacteristicValueChange', {
    deviceId: deviceId || 'dev-1',
    serviceId: BLE.serviceUuid,
    characteristicId: BLE.notifyCharUuid,
    value: buf,
  })
}

// 默认 BLE 桩：自定义服务 + write/notify 特征齐备。
function setupBle(wx) {
  wx.getBLEDeviceServices.mockImplementation(() =>
    Promise.resolve({ services: [{ uuid: BLE.serviceUuid, isPrimary: true }] })
  )
  wx.getBLEDeviceCharacteristics.mockImplementation(() =>
    Promise.resolve({
      characteristics: [
        { uuid: BLE.writeCharUuid, properties: { write: true } },
        { uuid: BLE.notifyCharUuid, properties: { notify: true } },
      ],
    })
  )
  return wx
}

// 等所有已排队 Promise 微任务完成。
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

module.exports = { buildFrameBytes, statusFrame, notify, setupBle, flush }