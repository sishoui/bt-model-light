// otaClient 测试（ADR-0034）：纯函数校验 + 端到端升级流程（wx mock）。
//
// 端到端部分不依赖真机：wx.downloadFile / getFileSystemManager 由 wx-mock
// 注入，空口字节用 decodeFrame 从 writeBLECharacteristicValue 调用里解码。

'use strict'

const { installWxMock } = require('./wx-mock')
const { setupBle, notify, statusFrame, flush } = require('./bleTestUtils')
const { decodeFrame } = require('../utils/frameParser')
const { CMD, NOTIFY, OTA_SUB } = require('../utils/protocol_gen')

const ota = require('../utils/otaClient')

// 独立 CRC32（不复用被测实现）。
function refCrc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function manifestFor(bytes, version) {
  return {
    version: version || '0.4',
    protocol_version: '1.2',
    file: 'bt-model-light-esp32c3-0.4.bin',
    size: bytes.length,
    crc32: refCrc32(bytes).toString(16).padStart(8, '0'),
    released: '2026-11-27T00:00:00Z',
    notes: 'test',
  }
}

// 让 downloadFile 按 URL 返回 manifest 文本 / bin 字节。
function stubDownloads(wx, manifest, bytes) {
  const base = 'http://example.test/firmware'
  wx.downloadFile.mockImplementation((opts = {}) => {
    const url = opts.url
    const isManifest = url.endsWith('/manifest.json')
    const tempFilePath = isManifest ? 'wxfile://manifest.json' : 'wxfile://image.bin'
    wx.__files[tempFilePath] = isManifest
      ? Buffer.from(JSON.stringify(manifest), 'utf8')
      : Buffer.from(bytes)
    const res = { statusCode: 200, tempFilePath }
    if (typeof opts.success === 'function') opts.success(res)
    return Promise.resolve(res)
  })
  return base
}

// 模拟固件：按字节流重组（真机也是流式解析），每解出一条 CMD.OTA 就回 OK。
// 必须累计而不是逐次 write 解码——大 DATA 帧会被拆成多个 509 字节写，
// 单片解码只能得到半帧。
function autoAckOta(wx, opts) {
  const { FrameParser, PARSE_OK } = require('../utils/frameParser')
  const parser = new FrameParser()
  const seen = []
  const onPayload = opts && opts.onPayload
  wx.writeBLECharacteristicValue.mockImplementation((o = {}) => {
    const feed = parser.feed(new Uint8Array(o.value))
    if (feed !== PARSE_OK) return Promise.resolve({})
    const out = {}
    while (parser.next(out) === PARSE_OK) {
      if (out.cmd !== CMD.OTA) continue
      const payload = Array.from(out.payload)
      seen.push(payload)
      const evt = onPayload ? onPayload(payload, out.seq) : statusFrame(NOTIFY.OK, CMD.OTA, out.seq)
      if (evt) Promise.resolve().then(() => notify(wx, evt))
    }
    return Promise.resolve({})
  })
  return seen
}

// 建立连接（走 bleClient 正常 connect 流程）。
async function connectClient() {
  const { createBleClient, setCurrentBleClient } = require('../utils/bleClient')
  const client = createBleClient()
  setCurrentBleClient(client)
  await client.connect('dev-1')
  return client
}

describe('otaClient 纯函数', () => {
  test('crc32 与已知向量一致（IEEE 802.3）', () => {
    const data = Buffer.from('123456789', 'utf8')
    expect(ota.crc32(new Uint8Array(data))).toBe(0xcbf43926)
  })

  test('crc32 空输入为 0', () => {
    expect(ota.crc32(new Uint8Array([]))).toBe(0)
  })

  test('parseVersion 接受 X.Y、拒绝其它', () => {
    expect(ota.parseVersion('0.4')).toEqual([0, 4])
    expect(ota.parseVersion('12.30')).toEqual([12, 30])
    expect(ota.parseVersion('0.4.1')).toBeNull()
    expect(ota.parseVersion('')).toBeNull()
    expect(ota.parseVersion(null)).toBeNull()
  })

  test('isNewerVersion 主版本优先、再比次版本', () => {
    expect(ota.isNewerVersion('0.4', '0.3')).toBe(true)
    expect(ota.isNewerVersion('0.3', '0.4')).toBe(false)
    expect(ota.isNewerVersion('0.4', '0.4')).toBe(false)
    expect(ota.isNewerVersion('1.0', '0.9')).toBe(true)
    expect(ota.isNewerVersion('bad', '0.1')).toBe(false)
  })

  test('parseManifest 接受合法并归一化字段', () => {
    const m = ota.parseManifest({
      version: '0.4',
      file: 'fw.bin',
      size: 1024,
      crc32: 'ABCDEF01',
      protocol_version: '1.2',
    })
    expect(m.version).toBe('0.4')
    expect(m.crc32).toBe('abcdef01')
    expect(m.protocolVersion).toBe('1.2')
  })

  test('parseManifest 拒绝非法字段', () => {
    expect(() => ota.parseManifest({ version: '0.4', file: 'fw.bin', size: 0, crc32: 'aa' })).toThrow()
    expect(() => ota.parseManifest({ version: 'x', file: 'fw.bin', size: 1, crc32: 'aabbccdd' })).toThrow()
    expect(() => ota.parseManifest({ version: '0.4', file: 'fw.exe', size: 1, crc32: 'aabbccdd' })).toThrow()
    expect(() =>
      ota.parseManifest({ version: '0.4', file: 'fw.bin', size: 1, crc32: 'zzzzzzzz' })
    ).toThrow()
    // 超过 ota 分区大小
    expect(() =>
      ota.parseManifest({ version: '0.4', file: 'fw.bin', size: ota.OTA_IMAGE_MAX + 1, crc32: 'aabbccdd' })
    ).toThrow()
  })

  test('verifyImage 校验长度与 CRC32', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const m = ota.parseManifest(manifestFor(bytes))
    expect(ota.verifyImage(bytes, m)).toBeNull()
    expect(ota.verifyImage(new Uint8Array([1, 2, 3]), m)).toMatch(/大小不符/)
    const tampered = new Uint8Array([1, 2, 3, 5])
    expect(ota.verifyImage(tampered, m)).toMatch(/校验失败/)
  })
})

describe('otaClient.flash 端到端', () => {
  let wx
  beforeEach(() => {
    wx = installWxMock()
    setupBle(wx)
    const { reset } = require('../utils/bleClient')
    if (typeof reset === 'function') reset()
    require('../utils/deviceStore').resetDeviceStore()
  })

  test('小块镜像：BEGIN/DATA…/END 顺序正确且 offset 连续', async () => {
    const bytes = new Uint8Array(1200).map((_, i) => i & 0xff)
    const manifest = manifestFor(bytes)
    const base = stubDownloads(wx, manifest, bytes)
    const seen = autoAckOta(wx)
    const progress = []
    const client = await connectClient()
    expect(client.connected).toBe(true)

    const res = await ota.flash({
      baseUrl: base,
      onProgress: (stage, written, total) => progress.push({ stage, written, total }),
    })

    expect(res.version).toBe('0.4')
    expect(res.total).toBe(bytes.length)

    // 第一条 BEGIN，最后一条 END。
    expect(seen[0][0]).toBe(OTA_SUB.BEGIN)
    expect(seen[seen.length - 1][0]).toBe(OTA_SUB.END)
    // BEGIN 携带 total + crc32 + 版本。
    const begin = seen[0]
    const total = begin[1] | (begin[2] << 8) | (begin[3] << 16) | (begin[4] << 24)
    const crc = (begin[5] | (begin[6] << 8) | (begin[7] << 16) | (begin[8] << 24)) >>> 0
    expect(total).toBe(bytes.length)
    expect(crc).toBe(refCrc32(bytes))
    expect(begin[9]).toBe(0)
    expect(begin[10]).toBe(4)

    // DATA 的 offset 严格连续，累计字节数与镜像一致。
    let expectOffset = 0
    let imageBytes = 0
    for (const p of seen) {
      if (p[0] !== OTA_SUB.DATA) continue
      const off = (p[1] | (p[2] << 8) | (p[3] << 16) | (p[4] << 24)) >>> 0
      expect(off).toBe(expectOffset)
      expectOffset += p.length - 5
      imageBytes += p.length - 5
    }
    expect(imageBytes).toBe(bytes.length)

    // 进度回调覆盖 checking → begin → writing → verifying → done。
    const stages = progress.map((p) => p.stage)
    expect(stages[0]).toBe('checking')
    expect(stages).toContain('begin')
    expect(stages).toContain('writing')
    expect(stages).toContain('verifying')
    expect(stages[stages.length - 1]).toBe('done')
  })

  test('镜像超过单帧上限时分成多块 DATA', async () => {
    const bytes = new Uint8Array(ota.BLOCK_MAX * 2 + 10).map((_, i) => (i * 7) & 0xff)
    const manifest = manifestFor(bytes)
    const base = stubDownloads(wx, manifest, bytes)
    const seen = autoAckOta(wx)
    await connectClient()

    await ota.flash({ baseUrl: base })
    const dataFrames = seen.filter((p) => p[0] === OTA_SUB.DATA)
    expect(dataFrames.length).toBe(3)
    // 每帧整体不超过单帧上限（payload ≤ 1500）。
    for (const p of dataFrames) expect(p.length).toBeLessThanOrEqual(1500)
  })

  test('CRC 不符时不发 BEGIN（本地校验先失败）', async () => {
    const bytes = new Uint8Array(64).map((_, i) => i)
    const manifest = manifestFor(bytes)
    manifest.crc32 = '00000000' // 故意错
    const base = stubDownloads(wx, manifest, bytes)
    const seen = autoAckOta(wx)
    await connectClient()

    await expect(ota.flash({ baseUrl: base })).rejects.toThrow(/校验失败/)
    expect(seen.length).toBe(0)
  })

  test('固件回错误码时停止并 ABORT', async () => {
    const bytes = new Uint8Array(32).map((_, i) => i)
    const manifest = manifestFor(bytes)
    const base = stubDownloads(wx, manifest, bytes)
    // BEGIN 成功，DATA 回 ERROR 0x05（模拟固件拒绝）。
    const seen = autoAckOta(wx, {
      onPayload: (payload, seq) =>
        payload[0] === OTA_SUB.DATA
          ? statusFrame(NOTIFY.ERROR, 0x05, seq)
          : statusFrame(NOTIFY.OK, CMD.OTA, seq),
    })
    await connectClient()

    await expect(ota.flash({ baseUrl: base })).rejects.toThrow(/错误码 0x5/)
    // 最后一条是 ABORT（best-effort）。
    expect(seen[seen.length - 1][0]).toBe(OTA_SUB.ABORT)
  })

  test('分片上限过小时拒绝升级', async () => {
    const bytes = new Uint8Array(16)
    const manifest = manifestFor(bytes)
    const base = stubDownloads(wx, manifest, bytes)
    // 模拟"平台只支持 20 字节/包"的降级：首片写被拒，_chunk 退回 20。
    wx.writeBLECharacteristicValue.mockImplementation(() =>
      Promise.reject(new Error('exceed max length'))
    )
    await connectClient()
    const client = require('../utils/bleClient').getCurrentBleClient()
    expect(client.chunk).toBe(20)

    await expect(ota.flash({ baseUrl: base })).rejects.toThrow(/分片 20 字节太小/)
  })

  test('未连接时直接报错', async () => {
    const { createBleClient, setCurrentBleClient } = require('../utils/bleClient')
    setCurrentBleClient(createBleClient())
    await expect(ota.flash({ baseUrl: 'http://x/firmware' })).rejects.toThrow(/设备未连接/)
  })
})

describe('otaClient.getBaseUrl', () => {
  beforeEach(() => {
    installWxMock()
  })

  test('默认走常量，Storage 可覆盖', () => {
    expect(ota.getBaseUrl()).toBe(ota.DEFAULT_BASE_URL)
    wx.setStorageSync(ota.BASE_URL_KEY, 'https://example.com/fw')
    expect(ota.getBaseUrl()).toBe('https://example.com/fw')
    wx.setStorageSync(ota.BASE_URL_KEY, '   ')
    expect(ota.getBaseUrl()).toBe(ota.DEFAULT_BASE_URL)
  })
})
