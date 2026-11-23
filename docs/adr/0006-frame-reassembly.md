# ADR-0006: 帧重组（帧头 + 长度 + CRC）

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件, 小程序, 测试

## 背景

arena-feasibility 分析报告要求把"分包时序"拆成两层：JS 层拆帧重组逻辑可 Mock，空口 MTU/notify 时序只能真机。帧格式（ADR-0005）已含 `len` + `crc16`，本 ADR 明确重组策略。

## 决策

接收端按 `[0xAA][len][...][crc16]` 重组：

- 持续接收字节流，找 `0xAA` 帧头
- 读 `len`，缓冲到 `len + 6` 字节（帧头1 + len2 + cmd1 + seq1 + payload + crc16 2）
- 校验 CRC-16，通过则交付一帧，否则丢弃并继续找下一帧头
- 不依赖 BLE 单包整帧；不引入应用层 ACK

## 理由

- 与 ADR-0005 帧格式直接对应
- 无论 BLE 怎么分包都能还原
- JS 层重组逻辑可用构造分帧序列在 Jest Mock 覆盖
- 空口 MTU 协商交真机 smoke test
- 不引入 ACK 开销（轻量）

## 影响

- 小程序 `miniprogram/utils/frameParser.js` 实现重组，单测覆盖
- 固件 `protocol_parser.c` 实现重组，Unity 单测覆盖
- 不依赖 BLE MTU 协商（不调用 `wx.setBLEMTU` 做正确性前提）

## 备选

- 假定单包整帧：简单但脆弱，iOS/Android 行为不同
- 应用层分块 ACK：最稳但最重，对灯控过度