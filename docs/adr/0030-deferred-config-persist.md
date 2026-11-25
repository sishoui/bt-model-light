# ADR-0030: 配置落盘延后到 frame task + CONFIGURED 保持上一帧

- 状态: 已接受
- 日期: 2026-11-26
- 标签: 固件, 数据库
- 相关: ADR-0014（配置持久化，本 ADR 放宽其"下发即持久化"）、ADR-0015（损坏/缺失回落出厂默认）、ADR-0016（看门狗）、ADR-0029（下发提速）

## 背景

ADR-0029 把传输压到 2 包后，拨开关灭灯仍有一段可见延迟，来源是 `WRITE_CONFIG` 回调里的同步 `configPersistSave()`（spiffs：open → write → close → remove → rename，约 0.1–0.3s）：

1. 这个回调跑在 BTC 任务上，紧随其后的 `APPLY` 必须排队等它写完 → 灭灯被整体推迟；
2. 落盘期间状态已切到 `CONFIGURED`，frame task 按 ADR-0015 的"开箱即亮"渲染**出厂彩虹** → 灭灯前先闪一下彩虹，视觉上像"反应慢/出错"。

另外 `sCfg` 的整份赋值（5.4KB 结构体拷贝）与落盘读取之间没有同步：ESP32-C3 单核可抢占，frame task 若在拷贝中途被 BTC 抢占，会读到半新半旧的配置，写出一份"CRC 自洽但内容错乱"的 blob（重启时按校验结果回落出厂默认，用户表现为"配置莫名其妙没了"）。

## 决策

**1. 落盘延后 + 尾部防抖（`bleServicePollPersist`）**

`WRITE_CONFIG` 只在命令路径里更新 RAM 配置 + 标记 dirty，`OK` 立即回；真正的 spiffs 写由 frame task 每轮调用 `bleServicePollPersist(now_ms)` 执行，规则：

- 尾部防抖 **600ms**：最后一次 `WRITE_CONFIG` 起算，期间又有改动就顺延（小程序侧 autoSync 已做 500ms 合并，这里再合并拖拽/连点产生的突发，避免每次改动都写 flash）；
- 写失败重试最多 **3 次**后放弃：RAM 配置始终一致，spiffs 保留上一份 blob（与旧行为同为 best-effort）。

**2. `sCfgLock` 串行化配置读写**

FreeRTOS mutex 保护「BTC 的整份赋值 + `composition_init`」与「落盘读取 sCfg」。锁只在两个位置短暂持有；唯一代价是 BTC 在"落盘正好在写 flash"这 0.1–0.3s 内收到新的 `WRITE_CONFIG` 时要等一下（罕见，且与改动前的同步落盘同量级）。

**3. `RESET_DEFAULT` 清 dirty**

复位清 spiffs 后必须放弃待落盘的旧改动，否则 frame task 会把复位前的配置又写回 spiffs（复位不干净）。

**4. `CONFIGURED` 状态保持上一帧**

配置已收到、等 `APPLY` 的窗口不再重渲出厂彩虹，改为像 `PAUSED` 一样保持灯带上的上一帧。`IDLE` / `CONNECTED` 仍播出厂默认（ADR-0015 的"开箱即亮"不变）；首次配置时"上一帧"本就是出厂默认，所以观感一致，只是不再闪。

## 理由

- 命令路径（含紧随的 `APPLY`）不再被 flash 写阻塞 → 拨开关的端到端延迟只剩空口时间（ADR-0029 的 2 包）。
- 消除半新半旧配置被落盘的数据竞争，比"更快"更重要：坏 blob 会让用户配置在重启后消失。
- 复用既有 frame task（每 ~10ms 一轮）做轮询，不新增任务/队列：`TICK_MS` 远小于防抖窗口，粒度足够。
- 看门狗超时 5s，落盘 0.1–0.3s 的阻塞不会误触发（`WATCHDOG_TIMEOUT_MS`，ADR-0016）。

## 影响

- `firmware/src/ble_service.cpp`：dirty 标记 + `bleServicePollPersist` + `sCfgLock`；`handle_write_config` 不再同步落盘；`handle_reset_default` 清 dirty。
- `firmware/include/ble_service.h`：新增 `bleServicePollPersist(uint32_t now_ms)`。
- `firmware/src/main.cpp`：frame task 每轮调用轮询；`CONFIGURED` 分支改为保持上一帧。
- `docs/smoke-test.md`：新增真机项（不闪彩虹、落盘不阻塞、断电窗口、复位干净）。
- **持久化保证变化**：ADR-0014 的"下发即持久化"放宽为"下发后 ~0.6–0.9s 内持久化"；这段窗口内断电会丢这一次改动，重启回落 spiffs 上一份或出厂默认（ADR-0015）。

## 备选

- **专用低优先级落盘任务 + 队列**：解耦更彻底（落盘不再占用 frame task），但多一个任务 + 队列 + 栈预算，收益不抵复杂度，被否。
- **只改 `CONFIGURED` 渲染、落盘仍同步**：只治视觉，`APPLY` 仍要等 flash 写，被否。
- **落盘留在回调里但挪到 `OK` notify 之后**：同一任务同一线程，`APPLY` 照样要排队，被否。
- **拖拽期间不落盘、松手才落**：小程序 500ms 防抖 + 固件 600ms 尾部防抖已经覆盖这个意图，不需要额外的编辑态信号，被否。
- **保持同步落盘、只把 `sCfg` 换成双缓冲**：解决竞争但不解决阻塞，被否。
