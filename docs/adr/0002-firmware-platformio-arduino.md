# ADR-0002: 固件框架 PlatformIO + Arduino-ESP32

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件

## 背景

ESP32-C3 固件可选用 Arduino-ESP32、ESP-IDF、PlatformIO 工程组织。

## 决策

采用 **PlatformIO 工程 + Arduino-ESP32 core**，灯珠驱动用 `FastLED` / `Adafruit_NeoPixel`。

## 理由

- `platformio.ini` 声明依赖、构建 reproducible
- Unity 单测可直接挂同一工程，对齐 ADR-0003 的"固件协议解析层可独立编译单测"
- Arduino API 上手快，灯控生态库丰富
- Windows runner 可跑 PlatformIO（对齐 ADR-0012 CI 决策）

## 影响

- 工程结构 `firmware/` 下为 PlatformIO 工程（`platformio.ini` + `src/` + `include/` + `test/`）
- 固件协议解析抽成纯 C/C++ 函数，可在 `test/` 下独立编译

## 备选

- 纯 ESP-IDF：更专业但上手慢，组件化对轻量项目过度
- 纯 Arduino IDE：无 CI、无单测挂载点