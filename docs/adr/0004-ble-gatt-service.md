# ADR-0004: BLE 直连自定义 GATT 服务

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件, 小程序

## 背景

小程序 ↔ 固件通信可走 BLE 直连、串口透传模块（HC-08/JDY-31）、Wi-Fi（HTTP/MQTT）。

## 决策

采用 **BLE 直连 + 自定义 GATT Service/Characteristic**：

- 一个 Write Characteristic（小程序 → 固件，写命令）
- 一个 Notify Characteristic（固件 → 小程序，回传状态/错误）

## 理由

- 灯控是本地近距离场景，BLE 延迟最低
- 无需配网、无需外部模块
- 小程序原生支持 `wx.openBluetoothAdapter` + `wx.createBLEConnection`
- 透传模块多一层 AT 指令开销且资料杂；Wi-Fi 配网对灯控过重

## 影响

- 固件定义自定义 Service UUID + 两个 Char UUID（写入 `protocol/` 定义）
- 小程序用 `wx.writeBLECharacteristicValue` / `wx.notifyBLECharacteristicValueChange`
- 空口 MTU 协商与 notify 时序靠真机 smoke test 验证（见 ADR-0012）
- 帧分包重组逻辑在 JS 层用 Mock 覆盖（见 ADR-0012）

## 备选

- 透传模块：AT 指令开销，固件侧 UART 调试多
- Wi-Fi：配网对灯控过重，留作 v2