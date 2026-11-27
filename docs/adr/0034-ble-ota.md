# ADR-0034: BLE OTA 固件升级

- 状态: 已接受
- 日期: 2026-11-27
- 标签: 固件 / 小程序 / 协议 / 运维
- 取代: ADR-0008（OTA 延后到 v2，本轮落地）

## 背景

ADR-0008 把 OTA 延后到 v2，但当时已经预留了双 OTA 分区（ADR-0010）和命令码
`0xF0`（ADR-0007）。现在要在不增加硬件成本的前提下让用户自己升级固件：

- 设备只有 BLE，没有 WiFi 配网（SPEC Out of Scope），**无法自行 HTTP 下载镜像**。
- 小程序能上网，也能连 BLE，于是承担"下载 + 校验 + 中继"的角色。
- 镜像约 1MB，BLE 单包 20~509 字节，必须分块 + 完整性校验。
- 现场已有的 0.3 固件不认识 OTA，所以第一台 0.4 只能数据线烧录，之后才能 OTA。

## 决策

### 1. 传输路径：小程序下载 → BLE 分块写入

小程序从 HTTP 拉 `manifest.json` + `.bin`，本地校验后按 `0xF0` 子命令逐块写进
设备。设备不回 HTTP，不存 URL，不引入 WiFi 依赖。

### 2. 协议：`0xF0` + 子命令（`protocol/ota.csv`）

| 子命令 | 方向 | 负载 |
|---|---|---|
| `BEGIN 0x01` | app→fw | `[total:u32le][crc32:u32le][ver_major][ver_minor]` |
| `DATA 0x02` | app→fw | `[offset:u32le][bytes...]` |
| `END 0x03` | app→fw | — |
| `ABORT 0x04` | app→fw | — |
| `PROGRESS 0x05` | fw→app | `[written:u32le][total:u32le]`（走 0x81 通道） |

**协议版本保持 1.2**：`0xF0` 早在 1.2 的命令表里（ADR-0007 预留），子命令是加法；
若升 minor，现网 0.3 固件会被小程序判为"协议不兼容"而拒绝下发任何命令——包括
OTA 本身，等于把老设备锁死。版本能力判定改为**看固件版本（≥0.4）**。

### 3. 流控：停等（一帧一应答），不做滑动窗口

BLE 写本身有 ATT 层确认，但固件还要 flash 写（几 ms~几十 ms/块）。停等的代价是
吞吐低（1MB ≈ 2100 帧），收益是不需要窗口/重排/乱序处理：

- `DATA.offset` 必须等于已接收字节数，乱序/重复直接 `0x04 参数非法`；
- 丢帧由小程序超时重发**同一块**（offset 不变），固件无需支持随机写；
- 固件的每条 OTA 命令都回 `STATUS_NOTIFY OK`（code 回显 `0xF0`），小程序的
  超时等待就是它的 ACK，不新增包类型。

### 4. 完整性：镜像级 CRC-32 + 帧级 CRC-16

- 帧级 CRC-16（既有）只保护单帧；
- `BEGIN.crc32` 是整份镜像的 CRC-32（IEEE 802.3，与 `zlib.crc32` 同款），`END`
  时固件比对累计值，不符回 `0x01` 且**不切分区**；
- 另外 `esp_ota_end()` 自己会校验镜像头/长度，双保险。

固件的 `ota_crc32()` 支持增量（`crc32(prev, chunk, n)`），小程序/服务器用同款
多项式，三端一致（native 测试用 `"123456789" → 0xCBF43926` 钉死）。

### 5. 升级后的启动与回滚

- `END` 成功 → `esp_ota_set_boot_partition()` → 延迟 300ms（让 OK notify 先发出）
  → `esp_restart()`。
- `sdkconfig.defaults` 开 `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`，`setup()` 末尾
  调 `esp_ota_mark_app_valid_cancel_rollback()`：新镜像跑到"任务已创建"才算有效，
  否则 bootloader 回滚到上一版。数据线首刷的镜像 otadata 已是 valid，不受影响。
- 升级中断电：`otadata` 还没切，重启进旧固件；已写入的分区内容作废但无害。
- 断连：`onDisconnect` 主动 `ABORT`，避免下一次 `BEGIN` 撞上"进行中"。

### 6. 升级期间的命令门控

`WRITE_CONFIG / READ_CONFIG / APPLY / TRIGGER_STEP / RESET_DEFAULT` 回
`0x05 状态非法`（flash 写与配置写交错既慢又易错，且重渲染会抢 CPU）；
`GET_VERSION / READ_STATUS / SET_POWER / SET_BRIGHTNESS` 保持可用（小屏状态/关灯
不影响升级）。小程序侧同时 `autoSync.setPaused(true)`，双保险。

### 7. 空口分片下限

固件 local MTU 517（ADR-0029）。Android 协商 512 → 509 字节/包；iOS 185 → 182。
两者都可行。若协商失败退回 20 字节/包，1MB 要 ~5 万帧，实际不可完成——小程序
在 `chunk < 64` 时直接拒绝并提示"靠近设备或重连"。

### 8. 版本上报与展示

- 固件 `onConnect` 在 STATE 之后主动 `notify_version(0)`，小程序**连接即拿到固件
  版本**，不再依赖它主动 `GET_VERSION`（该命令保留，用于重试）。
- 小程序把版本落到设备记录（`firmwareVersion` / `firmwareVersionAt`），首页连接
  徽标、"我的 → 设备固件"、"关于"弹窗都读它；未连接时显示上次已知值。
- 是否有新版本由小程序比较 manifest.version 与设备上报版本（语义化 X.Y，主版本
  优先）。固件不参与版本决策。

### 9. 分发：静态 HTTP + manifest

`scripts/firmware_release.py` 构建并生成：

```json
{
  "version": "0.4",
  "protocol_version": "1.2",
  "file": "bt-model-light-esp32c3-0.4.bin",
  "size": 1022094,
  "crc32": "xxxxxxxx",
  "sha256": "...",
  "released": "2026-11-27T...",
  "notes": "..."
}
```

nginx 挂 `/firmware/` 静态目录（`deploy/server.env` 里的 `SERVER_FIRMWARE_DIR`）。
先传 bin 再传 manifest，保证读到新 manifest 时镜像已存在。

**已知限制**：微信"体验版/正式版"要求 `downloadFile` 域名是 **HTTPS + 已备案域名**，
IP 直连只在开发者工具与"真机调试"下可用。本轮用 `http://117.72.163.247/firmware`，
换域名时只改 `utils/otaClient.js` 的 `DEFAULT_BASE_URL` 或 Storage 覆盖键
`bt_firmware_base_url`，不动协议。

## 备选

- **设备 WiFi 直连下载**：需要配网 UI、凭证存储、失败重试，且当前硬件没有配网
  入口——否决。
- **用一个 0xF0 包带全部镜像**：单帧上限 1500 字节，1MB 需要 700 帧，等价于分块，
  还失去偏移校验——否决。
- **滑动窗口 + 乱序重排**：吞吐能高 2~3 倍，但要在固件里引入窗口状态与乱序缓存，
  与"停等 + 偏移顺序"相比复杂度不划算——否决。
- **升级走 HTTP 直传**：BLE 没有这个能力，WiFi 不在范围内——否决。

## 影响

- `protocol/ota.csv`（新）、`commands.csv`、`versions.csv`、`frame-spec.md`、codegen。
- 固件：`ota_protocol.c`（纯逻辑，native 可测）、`ota_service.cpp`（esp_ota_ops）、
  `ble_service.cpp` 分发 + 连接上报版本 + notify 按 MTU 分片、`main.cpp` 回滚门禁、
  `sdkconfig.defaults` 开回滚。
- 小程序：`utils/otaClient.js`（新）、`bleClient` 写队列串行化、`deviceStore` 固件
  版本、`autoSync.setPaused`、首页/我的页展示与升级入口。
- 运维：`deploy/server.env`、`scripts/firmware_release.py`、nginx `/firmware/`。
- 现网 0.3 固件必须数据线烧一次 0.4 才能进入 OTA 通道。
