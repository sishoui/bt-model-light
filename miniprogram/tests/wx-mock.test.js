// Jest 单测：miniprogram/tests/wx-mock.js（自建 global.wx mock，ADR-0012）。
//
// 覆盖：
//   - installWxMock 安装到 global.wx
//   - BLE API 回调 + Promise 双形态
//   - 事件监听可注册并触发
//   - mock 函数可断言调用顺序与参数

'use strict'

const { installWxMock, createWxMock } = require('./wx-mock')

describe('wx-mock', () => {
  let wx

  beforeEach(() => {
    wx = installWxMock()
  })

  test('installWxMock 把 mock 装到 global.wx', () => {
    expect(global.wx).toBe(wx)
    expect(typeof global.wx.openBluetoothAdapter).toBe('function')
  })

  test('BLE API 返回 Promise', () => {
    expect(wx.openBluetoothAdapter()).toBeInstanceOf(Promise)
    expect(wx.createBLEConnection({ deviceId: 'x' })).toBeInstanceOf(Promise)
    expect(wx.writeBLECharacteristicValue({ value: new Uint8Array([1]) })).toBeInstanceOf(Promise)
  })

  test('BLE API 回调 success 形态被调用', () => {
    const success = jest.fn()
    return wx.openBluetoothAdapter({ success }).then(() => {
      expect(success).toHaveBeenCalled()
    })
  })

  test('wx.writeBLECharacteristicValue 记录调用参数（调用顺序/参数断言）', async () => {
    await wx.writeBLECharacteristicValue({
      deviceId: 'dev-1',
      serviceId: 'srv',
      characteristicId: 'chr',
      value: new Uint8Array([0xaa, 0x01]),
    })
    expect(wx.writeBLECharacteristicValue).toHaveBeenCalledTimes(1)
    const arg = wx.writeBLECharacteristicValue.mock.calls[0][0]
    expect(arg.deviceId).toBe('dev-1')
    expect(Array.from(arg.value)).toEqual([0xaa, 0x01])
  })

  test('事件监听注册后可触发', () => {
    const handler = jest.fn()
    wx.onBLECharacteristicValueChange(handler)
    wx.__trigger('onBLECharacteristicValueChange', { value: new Uint8Array([0xaa]) })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].value).toBeInstanceOf(Uint8Array)
  })

  test('onBluetoothDeviceFound 可触发', () => {
    const handler = jest.fn()
    wx.onBluetoothDeviceFound(handler)
    wx.__trigger('onBluetoothDeviceFound', {
      devices: [{ name: 'BTLight_01', RSSI: -50, deviceId: 'd1' }],
    })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].devices[0].name).toBe('BTLight_01')
  })

  test('createWxMock 每次返回新实例（隔离测试）', () => {
    const a = createWxMock()
    const b = createWxMock()
    expect(a).not.toBe(b)
    expect(a.openBluetoothAdapter).not.toBe(b.openBluetoothAdapter)
  })

  test('showModal 回调 success + complete 均被调用', () => {
    const success = jest.fn()
    const complete = jest.fn()
    wx.showModal({ success, complete })
    expect(success).toHaveBeenCalledWith({ confirm: true, cancel: false })
    expect(complete).toHaveBeenCalled()
  })
})