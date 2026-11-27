// BLE OTA 客户端（ADR-0034）：HTTP 拉镜像 → 校验 → 分块写空口。
//
// 为什么独立于 autoSync：autoSync 是"小命令 + 500ms 防抖 + hash 幂等"的
// 协调器，OTA 需要的是"不可合并、不可丢弃中间帧"的顺序大数据流，两者的
// 重发语义相反（防抖会吞掉数据块）。因此 OTA 直接走 bleClient.sendCmd，
// 由 bleClient 的 promise 串行队列保证不与配置下发交错。
//
// 流控：停等（发一块 → 等固件的 OK notify → 发下一块）。固件对每条 OTA
// 命令都回 STATUS_NOTIFY，所以不需要额外 ACK；丢帧靠小程序超时重发。

'use strict'

const { getCurrentBleClient } = require('./bleClient')
const { CMD, OTA_SUB } = require('./protocol_gen')
const { logError } = require('./errorHandler')

// 与固件 partitions.csv 的 ota_0/ota_1 大小一致（0x1E0000）。
const OTA_IMAGE_MAX = 0x1e0000
// 固件分发基地址（服务器目录见 AGENTS.md「服务器与固件发布」）。
// 开发期用 HTTP + IP：微信"体验版/正式版"要求 HTTPS + 备案域名，IP 直连
// 只在开发者工具与"真机调试"下可用（ADR-0034）。可通过 Storage
// bt_firmware_base_url 覆盖，便于换域名/测试环境而不改代码。
const DEFAULT_BASE_URL = 'http://117.72.163.247/firmware'
const BASE_URL_KEY = 'bt_firmware_base_url'
// 每块最多携带的镜像字节数：整帧 1500 payload 上限减去 [sub:1][offset:4]。
const BLOCK_MAX = 1495
// 单块应答超时：一块 ≈ 509 字节，真机单帧往返通常 <100ms；给足余量。
const BLOCK_TIMEOUT_MS = 6000
// 写分片下限：20 字节/包意味着 1.875MB 要 ~9 万帧，实际不可完成。
const MIN_MTU_CHUNK = 64
// 浮点进度去抖：只在百分比整数变化时回调页面，避免 setData 风暴。
const PROGRESS_EPSILON = 0.5

// CRC-32（IEEE 802.3）。与固件 ota_protocol.c / 服务器 zlib.crc32 同款。
function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

// "0.4" -> [0, 4]；非法返回 null（manifest 校验用）。
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)$/.exec(String(v || '').trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}

// a 是否比 b 新：主版本优先，其次次版本。
function isNewerVersion(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  if (pa[0] !== pb[0]) return pa[0] > pb[0]
  return pa[1] > pb[1]
}

// ---------- 纯函数（Jest 直接覆盖） ----------

// manifest.json 校验 + 归一化。抛错即视为不可用。
function parseManifest(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!obj || typeof obj !== 'object') throw new Error('manifest 不是对象')
  const version = String(obj.version || '')
  if (!parseVersion(version)) throw new Error(`manifest.version 非法：${obj.version}`)
  if (typeof obj.file !== 'string' || !/^[\w.-]+\.bin$/.test(obj.file)) {
    throw new Error(`manifest.file 非法：${obj.file}`)
  }
  const size = Number(obj.size)
  if (!Number.isInteger(size) || size <= 0 || size > OTA_IMAGE_MAX) {
    throw new Error(`manifest.size 非法：${obj.size}`)
  }
  const crc = String(obj.crc32 || '').toLowerCase()
  if (!/^[0-9a-f]{8}$/.test(crc)) throw new Error(`manifest.crc32 非法：${obj.crc32}`)
  return {
    version,
    file: obj.file,
    size,
    crc32: crc,
    protocolVersion: obj.protocol_version ? String(obj.protocol_version) : '',
    released: obj.released ? String(obj.released) : '',
    notes: obj.notes ? String(obj.notes) : '',
  }
}

// 镜像完整性校验：长度 + CRC32。返回 null 表示 OK，否则错误文案。
function verifyImage(bytes, manifest) {
  if (!bytes || typeof bytes.length !== 'number') return '镜像为空'
  if (bytes.length !== manifest.size) {
    return `镜像大小不符（${bytes.length} != ${manifest.size}）`
  }
  const got = crc32(bytes)
  if (`${got.toString(16).padStart(8, '0')}` !== manifest.crc32) {
    return `镜像校验失败（crc32 ${got.toString(16)} != ${manifest.crc32}）`
  }
  return null
}

// ---------- 运行态 ----------

function _wx() {
  if (typeof wx === 'undefined') throw new Error('otaClient 需要 wx 运行时')
  return wx
}

// 下载到本地临时路径并读成 Uint8Array。
function _download(url) {
  const wx = _wx()
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode !== 200 || !res.tempFilePath) {
          reject(new Error(`下载失败 HTTP ${res.statusCode}`))
          return
        }
        wx.getFileSystemManager().readFile({
          filePath: res.tempFilePath,
          success: (r) => resolve(new Uint8Array(r.data)),
          fail: (e) => reject(new Error(`读取下载文件失败：${e.errMsg}`)),
        })
      },
      fail: (e) => reject(new Error(`下载失败：${e.errMsg || e}`)),
    })
  })
}

// 当前分发基地址：Storage 覆盖 → 默认常量（换环境不用改代码/重发版）。
function getBaseUrl() {
  const wx = (() => {
    try {
      return _wx()
    } catch (e) {
      return null
    }
  })()
  const override = wx ? wx.getStorageSync(BASE_URL_KEY) : ''
  return (typeof override === 'string' && override.trim()) || DEFAULT_BASE_URL
}

// 拉 manifest（纯文本）。
function fetchManifest(baseUrl) {
  const wx = _wx()
  const url = `${String(baseUrl || '').replace(/\/$/, '')}/manifest.json`
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode !== 200 || !res.tempFilePath) {
          reject(new Error(`manifest 下载失败 HTTP ${res.statusCode}`))
          return
        }
        wx.getFileSystemManager().readFile({
          filePath: res.tempFilePath,
          encoding: 'utf8',
          success: (r) => {
            try {
              resolve(parseManifest(r.data))
            } catch (e) {
              reject(e)
            }
          },
          fail: (e) => reject(new Error(`读取 manifest 失败：${e.errMsg}`)),
        })
      },
      fail: (e) => reject(new Error(`manifest 下载失败：${e.errMsg || e}`)),
    })
  })
}

// 等一条 OTA OK（code 回显 CMD.OTA）。超时即视为丢帧。
function _waitOk(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false
    let timer = null
    const finish = (fn, value) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      off()
      fn(value)
    }
    const off = client.onStatus((evt) => {
      if (evt.type === 'ok' && evt.code === CMD.OTA) {
        finish(resolve)
      } else if (evt.type === 'error') {
        finish(reject, new Error(`固件回错误码 0x${Number(evt.code).toString(16)}`))
      }
    })
    timer = setTimeout(() => finish(reject, new Error('等待固件应答超时')), timeoutMs)
  })
}

// 发一条 OTA 命令并等应答。应答监听先挂上，避免 OK 先于 sendCmd resolve 到达。
async function _sendOta(client, payload, timeoutMs) {
  const waiter = _waitOk(client, timeoutMs)
  try {
    await client.sendCmd(CMD.OTA, payload, { bypassVersionCheck: true })
  } catch (e) {
    // 写入失败时 waiter 还在等：挂一个空 catch，避免 6s 后它以
    // unhandled rejection 的形式冒到全局。
    waiter.catch(() => {})
    throw e
  }
  await waiter
}

// 升级主流程。opts: { baseUrl, onProgress(stage, written, total), force }
// 返回 { version, total } 或抛错。调用方负责暂停 autoSync / 界面提示。
async function flash(opts) {
  const client = getCurrentBleClient()
  if (!client || !client.connected) throw new Error('设备未连接')
  const chunk = client.chunk || 0
  if (chunk < MIN_MTU_CHUNK) {
    throw new Error(`空口分片 ${chunk} 字节太小，升级不可行（请靠近设备或重连）`)
  }

  const cb = (stage, written, total) => {
    if (opts && typeof opts.onProgress === 'function') opts.onProgress(stage, written, total)
  }

  cb('checking', 0, 0)
  const baseUrl = (opts && opts.baseUrl) || getBaseUrl()
  const manifest = await fetchManifest(baseUrl)
  const binUrl = `${String(baseUrl).replace(/\/$/, '')}/${manifest.file}`
  const bytes = await _download(binUrl)
  const bad = verifyImage(bytes, manifest)
  if (bad) throw new Error(bad)

  // BEGIN
  const begin = new Uint8Array(11)
  begin[0] = OTA_SUB.BEGIN
  begin[1] = manifest.size & 0xff
  begin[2] = (manifest.size >>> 8) & 0xff
  begin[3] = (manifest.size >>> 16) & 0xff
  begin[4] = (manifest.size >>> 24) & 0xff
  const crc = parseInt(manifest.crc32, 16) >>> 0
  begin[5] = crc & 0xff
  begin[6] = (crc >>> 8) & 0xff
  begin[7] = (crc >>> 16) & 0xff
  begin[8] = (crc >>> 24) & 0xff
  const ver = parseVersion(manifest.version)
  begin[9] = ver[0]
  begin[10] = ver[1]
  cb('begin', 0, manifest.size)
  await _sendOta(client, Array.from(begin), BLOCK_TIMEOUT_MS)

  // DATA：每块等一个 OK，失败重发同一块（offset 不变，固件要求顺序）。
  let offset = 0
  let lastPct = -1
  try {
    while (offset < manifest.size) {
      const take = Math.min(BLOCK_MAX, manifest.size - offset)
      const block = new Uint8Array(5 + take)
      block[0] = OTA_SUB.DATA
      block[1] = offset & 0xff
      block[2] = (offset >>> 8) & 0xff
      block[3] = (offset >>> 16) & 0xff
      block[4] = (offset >>> 24) & 0xff
      block.set(bytes.subarray(offset, offset + take), 5)

      let attempt = 0
      for (;;) {
        try {
          await _sendOta(client, Array.from(block), BLOCK_TIMEOUT_MS)
          break
        } catch (e) {
          // 固件主动回错误码（参数非法等）不重试；超时最多重试 2 次。
          if (!/超时/.test(e.message) || ++attempt > 2) throw e
        }
      }
      offset += take
      const pct = Math.floor((offset / manifest.size) * 100)
      if (pct !== lastPct && pct >= lastPct + PROGRESS_EPSILON) {
        lastPct = pct
        cb('writing', offset, manifest.size)
      }
    }

    // END：固件校验 CRC32 + 切分区，随后约 300ms 重启。
    cb('verifying', manifest.size, manifest.size)
    await _sendOta(client, [OTA_SUB.END], BLOCK_TIMEOUT_MS)
    cb('done', manifest.size, manifest.size)
    return { version: manifest.version, total: manifest.size }
  } catch (err) {
    // best-effort 中止：断连时 sendCmd 会抛错，忽略即可。
    try {
      await client.sendCmd(CMD.OTA, [OTA_SUB.ABORT], { bypassVersionCheck: true })
    } catch (e) {
      /* 设备可能已断连 */
    }
    logError(err, '固件升级')
    throw err
  }
}

module.exports = {
  OTA_IMAGE_MAX,
  BLOCK_MAX,
  MIN_MTU_CHUNK,
  DEFAULT_BASE_URL,
  BASE_URL_KEY,
  crc32,
  parseVersion,
  isNewerVersion,
  parseManifest,
  verifyImage,
  getBaseUrl,
  fetchManifest,
  flash,
}
