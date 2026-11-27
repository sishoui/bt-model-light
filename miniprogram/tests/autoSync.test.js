// Jest 单测：miniprogram/utils/autoSync.js 的暂停语义（ADR-0034）。
//
// OTA 升级期间必须彻底挡住配置下发：数据块与 WRITE_CONFIG 抢占口会让固件
// 的流式解析器读到半截帧。暂停只挡"写空口"这一步，改动仍落 Storage 并在
// 恢复后补发——所以升级前后用户的操作不会丢。

'use strict'

const { createWxMock } = require('./wx-mock')
const { resetDeviceStore } = require('../utils/deviceStore')
const { setCurrentBleClient } = require('../utils/bleClient')
const { CMD } = require('../utils/protocol_gen')
const autoSync = require('../utils/autoSync')

function fakeClient(connected) {
  return {
    connected,
    sendCmd: jest.fn(() => Promise.resolve()),
    onConnectionStateChange: jest.fn(() => () => {}),
  }
}

function sampleConfig() {
  return {
    version: 1,
    pins: [
      {
        pin: 0,
        configured: true,
        groups: [
          {
            ledStart: 0,
            ledEnd: 9,
            steps: [
              {
                duration: 5,
                transition: 0,
                loopMode: 1,
                layers: [{ effect: 1, params: { color: [1, 2, 3], brightness: 200 } }],
              },
            ],
          },
        ],
      },
    ],
  }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('autoSync 暂停（ADR-0034）', () => {
  let wx
  let client

  beforeEach(() => {
    wx = createWxMock()
    global.wx = wx
    resetDeviceStore()
    autoSync.reset()
    client = fakeClient(true)
    setCurrentBleClient(client)
  })

  test('暂停期间 schedule 不下发；恢复后补发最新快照', async () => {
    autoSync.setPaused(true)
    autoSync.schedule('d1', sampleConfig(), { immediate: true })
    await flush()
    expect(client.sendCmd).not.toHaveBeenCalled()

    autoSync.setPaused(false)
    await flush()
    expect(client.sendCmd.mock.calls.map((c) => c[0])).toEqual([CMD.WRITE_CONFIG, CMD.APPLY])
  })

  test('暂停期间整机开关/亮度同样不占用空口', async () => {
    autoSync.setPaused(true)
    autoSync.schedulePower('d1', false)
    autoSync.scheduleBrightness('d1', 10)
    await flush()
    expect(client.sendCmd).not.toHaveBeenCalled()

    autoSync.setPaused(false)
    await flush()
    // 整机命令优先于配置（_nextJob 的既有排序）。
    expect(client.sendCmd.mock.calls.map((c) => c[0])).toEqual([CMD.SET_POWER, CMD.SET_BRIGHTNESS])
  })

  test('重复 setPaused 幂等；reset 清掉暂停态', async () => {
    autoSync.setPaused(true)
    autoSync.setPaused(true)
    autoSync.schedule('d1', sampleConfig(), { immediate: true })
    await flush()
    expect(client.sendCmd).not.toHaveBeenCalled()

    autoSync.reset()
    client.sendCmd.mockClear()
    autoSync.schedule('d1', sampleConfig(), { immediate: true })
    await flush()
    expect(client.sendCmd).toHaveBeenCalled()
  })
})
