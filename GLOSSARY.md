# GLOSSARY.md

Single-context glossary for `bt-model-light`. Terms here are the canonical vocabulary for issues, ADRs, code, and tests. Synonyms to avoid are noted.

## Hardware / domain

| Term | Definition | Avoid |
|---|---|---|
| 设备 (Device) | One ESP32-C3-FH4 light controller with 8 pins. | "控制器","主机" |
| 引脚 (Pin) | One of the 8 GPIOs, each driving an independent WS2812B strip. | "通道","端口" |
| 灯珠 (LED) | One WS2812B pixel, addressed by RGB (3 bytes). | "灯点","像素点" |
| 灯带 (Strip) | The WS2812B chain attached to one pin. | "灯条" |
| 灯带开关 (Pin power) | 引脚级开关（`pin.power`）：关 = 配置下发时该引脚不带灯组（`group_count=0`）→ 固件清空该灯带；开 = 正常播放。灯组配置始终保留在 Storage（ADR-0028）。 | "电源开关","总开关" |
| 灯组 (LightGroup) | A configured range on one pin's strip with up to 5 steps. | "灯段","灯区" |
| 灯珠区间 (LED range) | Inclusive `[start, end]` indices into a pin's strip, 0-based. | "灯珠段" |
| 步骤 (Step) | One playback state of a light group: duration, transition, loop mode, 1–2 layers. | "帧"（UI 文案作"阶段"，见引脚配置详情页） |
| 图层 (Layer) | An effect layer bound to a fixed slot: 0 = background, 1 = effect. | "层" |
| 图层槽位 (Layer slot) | 每阶段固定的两格位置（0=背景 / 1=动效）。槽位是位置语义而非顺序：删掉背景后动效仍留第二格。两格都可删空，全空 = 该阶段不亮，下发时以单层全黑 SOLID 表达（ADR-0033）。 | "插槽" |
| 背景层 (Background layer) | The base layer in two-layer composition (slot 0). | "底图" |
| 动效层 (Effect layer) | The foreground layer in two-layer composition; lit pixels win (slot 1). | "前景层" |
| 效果 (Effect) | One of the 8 built-in effect types. | "灯效","动画" |
| 合成 (Composition) | Two-layer rule: effect-layer pixel is non-black → use effect; else background. | "混合","叠加" |
| 设备配置 (DeviceConfig) | The complete configuration of one device (8 pins → groups → steps → layers). | "配置文件" |
| 引脚能力 (Pin capability) | Number of LEDs on a pin's strip (≤100). | "灯珠数" |
| 整体开关 (Master power) | 设备图上的一键开关机：设备级状态（`SET_POWER`），关 = 设备输出全黑，**不改各引脚自己的灯带开关状态**；关机时引脚区置灰、不可点、开关不可切换，开机后各引脚按原状态恢复（ADR-0032）。 | "总开关","主开关"（指批量改引脚配置时，见 ADR-0031） |
| 整体亮度 (Master brightness) | 设备图左下角的亮度竖条（0-255，点方块展开后上下滑动调节）：经 `SET_BRIGHTNESS` 下发，固件在输出级对**所有引脚**统一缩放；255 = 不缩放。存小程序的设备记录、断连后补发，不落设备闪存（ADR-0031）。 | "全局亮度","总亮度" |
| 出厂默认 (Factory default) | The built-in effect played when no config or config is corrupt. | "默认灯效" |

## Communication

| Term | Definition | Avoid |
|---|---|---|
| 帧 (Frame) | A TLV frame on BLE: `[0xAA][len:2][cmd:1][seq:1][payload:len][crc16:2]`. | "数据包","包" |
| 命令 (Command) | The `cmd` byte selecting an operation. | "指令" |
| 序列号 (Seq) | Command/response pairing byte. | "编号" |
| 重组 (Reassembly) | Rebuilding a frame from BLE fragments by `len` + CRC. | "拼包" |
| GATT 服务/特征 (GATT service/characteristic) | Custom BLE service with one write char and one notify char. | "通道" |
| 协议版本 (Protocol version) | Negotiated via `GET_VERSION` right after connect. | "固件版本" (that's firmware) |

## Firmware

| Term | Definition | Avoid |
|---|---|---|
| 状态机 (State machine) | `IDLE → CONNECTED → CONFIGURED → PLAYING → (PREVIEW/PAUSED)`. | "状态" |
| 看门狗 (Watchdog) | Independent task that resets firmware on hang. | "狗" |
| 分区表 (Partition table) | `nvs + otadata + ota_0/1 + spiffs`. | "分区" |
| OTA | 固件升级：小程序下载镜像 → BLE `0xF0` 分块写入 → 切分区重启；失败/断电回滚上一版（ADR-0034）。 | "在线升级","DFU" |
| OTA 会话 (OTA session) | 从 `BEGIN` 到 `END`/`ABORT` 的一次升级过程；期间固件拒绝配置类命令。 | "升级任务" |
| 镜像 (Image) | 一份完整的 `firmware.bin`，以整份 CRC-32 标识完整性。 | "固件包","bin 文件" |
| 固件版本 (Firmware version) | 设备上报的 `X.Y`（`versions.csv`）；连接时主动上报并落设备记录，用于展示与判断"是否有新版本"。 | "设备版本"（"协议版本"是另一件事） |
| 固件清单 (manifest) | 服务器上的 `manifest.json`：`version/size/crc32/file`；小程序据它决定升级并校验下载结果。 | "版本文件" |
| 纯函数解析 (Pure-function parsing) | Protocol parsing isolated from hardware so it is unit-testable. | "解析器" |

## Mini program

| Term | Definition | Avoid |
|---|---|---|
| 首页 (Home) | The device detail page shown on the "设备" tab; current/last device. | "设备详情页" |
| 设备列表页 (Device list page) | Scan/connect/switch/add entry page, reached from home top-left title. | "设备管理" |
| 引脚配置详情页 (Pin detail page) | Per-pin page: pin switch + group dropdown + LED range + step/layer editor. | "灯组编辑页" |
| 我的 (Mine) | Bottom-nav second tab; now the 用户配置页. | "设置页" |
| 用户配置页 (Profile page) | `pages/profile`：底部第二 Tab 内容 = 账号卡（微信登录/头像/昵称）+ 数据卡（设备数/云端同步）+ 设置 + 设备固件升级 + 关于 + 帮助。取代原「我的」页（ADR-0035）。 | "我的页","个人中心" |
| 灯组编辑 (Group editor) | The in-page editing area under the selected group on the pin detail page. | — |
| 修改即推送 (Auto sync) | 编辑即写 Storage，并经 `autoSync` 500ms 防抖下发固件（`WRITE_CONFIG` + `APPLY`）；无保存按钮（取代"保存"，见 ADR-0023 现状注记）。 | "保存" |
| 同步状态 (Sync state) | 引脚配置详情页顶部状态条：同步中 / 已同步 / 仅本机（未连接）/ 同步失败。 | "保存状态" |

## Backend / account

| Term | Definition | Avoid |
|---|---|---|
| 用户 (User) | 一个微信身份（`openid` 唯一）：昵称、头像、角色（`user`/`admin`）、状态（`active`/`disabled`）。ADR-0035。 | "账号"（易与管理员混淆） |
| 微信登录 (WeChat login) | 小程序 `wx.login` 取 `code` → 后端 `code2Session` 换 `openid` → 建号并发会话 token。**可选**：不登录照常 BLE 使用。 | "授权","绑定微信" |
| 会话 token (Session token) | 服务端随机串（存 `sessions` 表，30 天），Bearer 头携带；禁用用户/退出登录即失效。不用 JWT 就是为了能即时吊销。 | "JWT","access token" |
| 设备归属 (Device ownership) | 服务端 `devices` 表按 `(user_id, device_id)` 一行：谁用过哪台 BLE 设备。**只存身份与名称**，不含灯组配置。 | "设备绑定","配对" |
| 云端同步 (Cloud sync) | 本地 Storage 仍是真相源；登录后拉/推设备清单做 best-effort 镜像，按 BLE `deviceId` 合并。失败不阻塞 BLE。 | "云备份","主从同步" |
| 管理后台 (Admin console) | `admin/`（Vue 3 + Vite）→ nginx `/admin/`：概览、用户启停、设备删除、审计日志。ADR-0036。 | "后台管理系统","CMS" |
| 审计日志 (Audit log) | `audit_log` 表：管理员登录成功/失败、用户状态变更、设备删除，含操作者、对象、IP、时间。 | "操作记录" |
| 遥测 (Telemetry) | 小程序在关键路径的只读打点（`metric`/`dim`/`value`/`at`）→ `telemetry` 表 → 后台图表。指标名由服务端白名单约束；**不含**配置内容与个人输入（ADR-0037）。 | "埋点数据","日志"（那是 error_log/audit_log） |
| 指标 (Metric) | 遥测的事件名（如 `ble.mtu`、`config.write`、`error`），白名单在 `server/src/telemetry.js` 的 `METRICS`。 | "事件类型","key" |
| 维度 (Dim) | 指标的可选细分（错误码、固件版本、`sim`/`real`…），后台据此画 Top N 分布。 | "标签"(label 指 UI) |
| 日汇总 (Daily rollup) | `daily_stats` 表：把某天事件按指标聚合（事件数/数值合计/去重用户数），供长期趋势，不扫全表。 | "统计表" |

## Engineering

| Term | Definition | Avoid |
|---|---|---|
| 代码生成 (Codegen) | Protocol definition → C header + JS constants, checked in CI. | "生成代码" |
| Mock 层 (Mock layer) | Self-built `global.wx` in Jest; covers call order/args only. | "假微信" |
| Smoke test | End-to-end on 2 real devices before release. | "真机测试" (too broad) |
| ADR | Architecture decision record under `docs/adr/`. | "决策文档" |
