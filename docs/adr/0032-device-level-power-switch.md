# ADR-0032: 整机开关改为设备级总开关（SET_POWER 0x0B）

- 状态: 已接受
- 日期: 2026-11-26
- 标签: 固件, 小程序, 协议
- 相关: ADR-0031（整体开关原定为"扇出到引脚"，本 ADR 取代其决策 1）、ADR-0028（引脚灯带开关 `pin.power`，与本 ADR 是两个独立旋钮）、ADR-0030（配置落盘延后）

## 背景

ADR-0031 把"整体开关"实现为**扇出**：点关机就把 8 个引脚的 `pin.power` 全部写关（复用 ADR-0028 的编码路径）。真机试用确认语义不对：

- 关机后**各引脚自己的开关状态被覆盖**，与"设备关机、引脚状态不变"的预期不符；
- 再点开机会把用户故意关掉的引脚一并打开；
- 期望的行为是：设备关机 = 设备层面关灯，且**引脚区置灰、不可点击、不可切换**；引脚状态原样保留，设备开机后各引脚按原状态恢复。

## 决策

**1. 新增 `SET_POWER`（0x0B）：设备级总开关**

- payload 1 字节：`0` = 关 / `1` = 开（见 `protocol/frame-spec.md`）；
- 固件在**输出级**门控（与 SET_BRIGHTNESS 同一个出口）：关 = 写出的每个灯珠置黑，
  **不改配置、不改各引脚的 `pin.power`**；开 = 下一帧即按原配置恢复渲染；
- 任意状态可发（含 IDLE/CONNECTED）；`len != 1` 或取值不是 0/1 → `0x04 参数非法`；
- RAM 态、不落 spiffs；出厂复位（`RESET_DEFAULT` / BOOT 5s 长按）回到开机 + 满亮度。

**2. 小程序：整机开关是设备级状态，不再碰引脚**

- 存设备记录（`bt_devices[].power`，缺省开），经 autoSync 的 `schedulePower` 下发（1 字节，不重发配置）；
- 关机时引脚区整体置灰（`.pin-card--off`）+ **卡片不可点**（不进配置页）+ 开关 `disabled`；
- Storage 里的 `pin.power` 全程不动，开机后各引脚原样恢复可操作；
- 引脚配置详情页顶部的灯带开关同样置灰不可切换（否则从该页可绕过限制）。

**3. 协议 minor 1.1 → 1.2**（firmware 0.3 / app 0.3），沿用 ADR-0031 的版本策略。

**4. 引脚灯带开关（ADR-0028）语义不变**：仍是"这条灯带这次要不要亮"（编码为
`group_count=0`）。两者现在是**设备级 / 引脚级两个独立旋钮**：设备关机不看引脚状态，
设备开机不覆盖引脚状态。

## 理由

- 与用户心智模型一致：设备开关是"整台设备的电闸"，不是"批量改引脚配置"。
- 输出级门控零副作用：不动配置、不触发配置落盘 —— 对比扇出方案，每次开关都要重写整份配置并下发。
- 复用 ADR-0031 已建好的输出级 choke point 与 autoSync 通道：本次只新增一条命令 + 一处门控 + 一处界面约束。
- 置灰 + 不可点是必要的界面约束：否则用户会在关机状态下拨引脚开关，得到"点了没反应"的错觉。

## 影响

- `protocol/`：`commands.csv` +SET_POWER 0x0B、`versions.csv` 升版、`frame-spec.md` 新增负载小节；codegen 重新生成。
- 固件：`master_brightness.{h,cpp}` 扩为 **`master_output.{h,cpp}`**（整机开关门控 + 整机亮度缩放 + `masterResetDefaults`）；`led_driver.cpp` / `led_driver_stub.cpp` 改调 `masterApplyOutput`；`ble_service.cpp` 加 `handle_set_power`、复位改 `masterResetDefaults`；`main.cpp` 长按复位同上；native 测试目录改为 `test_master_output`。
- 小程序：`deviceStore` +`getDevicePower` / `saveDevicePower`（+`POWER_DEFAULT`）；`autoSync` +`schedulePower`（job 优先级：整机开关 > 整机亮度 > 配置）；`home.js` 去掉扇出、整机开关读写设备记录、关机时 `onTapPin` / `onPinPowerChange` 兜底拒绝；`home.wxml` / `home.wxss` 置灰与 `disabled`；`pin-detail` 顶部开关跟随整机开关。
- **ADR-0031 决策 1（扇出）被本 ADR 取代**；其决策 2–4（`SET_BRIGHTNESS`、单一下发出口、版本策略）不变。

## 已知边界

- 整机开关是设备 RAM 态：设备断电/重启后回到开机，由 App 重连补发（与整机亮度同一取舍）。
- 关机期间设备仍在渲染，只是输出被门控成黑：不省电、不停机——"关机"是显示语义，不是电源管理。
- 关机时引脚区不可点，因此**无法在关机状态下编辑引脚配置**，需先开机。

## 备选

- **保持 ADR-0031 的扇出**：零协议改动，但覆盖引脚状态、与预期不符，被否（本次真机试用的结论）。
- **整机开关写进配置 blob**：每次开关都要重发整份配置 + 触发配置落盘，且把"设备级"与"配置级"混在一起，被否。
- **关机时只置灰开关、仍允许进配置页**：用户明确要求"不可点击"；且关机状态下编辑看不到效果，容易误导，被否。
