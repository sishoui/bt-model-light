# GLOSSARY.md

Single-context glossary for `bt-model-light`. Terms here are the canonical vocabulary for issues, ADRs, code, and tests. Synonyms to avoid are noted.

## Hardware / domain

| Term | Definition | Avoid |
|---|---|---|
| 设备 (Device) | One ESP32-C3-FH4 light controller with 8 pins. | "控制器","主机" |
| 引脚 (Pin) | One of the 8 GPIOs, each driving an independent WS2812B strip. | "通道","端口" |
| 灯珠 (LED) | One WS2812B pixel, addressed by RGB (3 bytes). | "灯点","像素点" |
| 灯带 (Strip) | The WS2812B chain attached to one pin. | "灯条" |
| 灯组 (LightGroup) | A configured range on one pin's strip with up to 5 steps. | "灯段","灯区" |
| 灯珠区间 (LED range) | Inclusive `[start, end]` indices into a pin's strip, 0-based. | "灯珠段" |
| 步骤 (Step) | One playback state of a light group: duration, transition, loop mode, 1–2 layers. | "帧","阶段" |
| 图层 (Layer) | An effect layer; background or effect in two-layer mode. | "层" |
| 背景层 (Background layer) | The base layer in two-layer composition. | "底图" |
| 动效层 (Effect layer) | The foreground layer in two-layer composition; lit pixels win. | "前景层" |
| 效果 (Effect) | One of the 8 built-in effect types. | "灯效","动画" |
| 合成 (Composition) | Two-layer rule: effect-layer pixel is non-black → use effect; else background. | "混合","叠加" |
| 设备配置 (DeviceConfig) | The complete configuration of one device (8 pins → groups → steps → layers). | "配置文件" |
| 引脚能力 (Pin capability) | Number of LEDs on a pin's strip (≤100). | "灯珠数" |
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
| OTA | Deferred to v2; bootloader/partition/command code reserved now. | — |
| 纯函数解析 (Pure-function parsing) | Protocol parsing isolated from hardware so it is unit-testable. | "解析器" |

## Mini program

| Term | Definition | Avoid |
|---|---|---|
| 首页 (Home) | The device detail page shown on the "设备" tab; current/last device. | "设备详情页" |
| 设备列表页 (Device list page) | Scan/connect/switch/add entry page, reached from home top-left title. | "设备管理" |
| 引脚配置详情页 (Pin detail page) | Per-pin page: pin switch + group tabs + LED range + step/layer editor. | "灯组编辑页" |
| 我的 (Mine) | Bottom-nav second tab: settings, about, help. | "设置页" |
| 灯组编辑 (Group editor) | The in-page editing area inside a group tab on the pin detail page. | — |
| 保存 (Save) | Persists to Storage AND pushes config to firmware. | "下发","同步" |

## Engineering

| Term | Definition | Avoid |
|---|---|---|
| 代码生成 (Codegen) | Protocol definition → C header + JS constants, checked in CI. | "生成代码" |
| Mock 层 (Mock layer) | Self-built `global.wx` in Jest; covers call order/args only. | "假微信" |
| Smoke test | End-to-end on 2 real devices before release. | "真机测试" (too broad) |
| ADR | Architecture decision record under `docs/adr/`. | "决策文档" |
