# ADR-0001: 单片机平台为 ESP32-C3-FH4

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件

## 背景

灯控固件需要 BLE 直连 + WS2812B 多路驱动 + 可能的 OTA 升级。候选：ESP32、8051+透传、STM32+BLE 模块、nRF52。

## 决策

采用 **ESP32-C3-FH4**（RISC-V 单核、BLE 5.0、4MB Flash、无 PSRAM）。

## 理由

- BLE 原生，无需外挂透传模块，省一层 AT 指令开销与资料甄别成本
- WS2812B 可由 RMT 外设硬件驱动，时序稳定
- ESP32-C3 的 OTA 分区机制成熟，便于 v2 引入 OTA
- Arduino-ESP32 生态成熟，灯控社区案例多
- 4MB Flash 对 8 引脚 + 双 OTA 分区 + spiffs 配置充足

## 影响

- 8 引脚顺序刷新 WS2812B，每引脚 ≤100 颗（受 ESP32-C3 无 PSRAM 限制）
- 固件框架固定为 PlatformIO + Arduino-ESP32（见 ADR-0002）
- 协议解析层需与硬件解耦以便 PC 单测（见 ADR-0003）

## 备选

- 8051/STC + HC-08/JDY-31：便宜但 PWM/时序资源紧张，做 8 路 WS2812B 时序困难
- STM32 + BLE 模块：成本翻倍，外挂模块资料杂
- nRF52：BLE 更强但 PWM/外设配置更底层，灯控场景过度