# ADR-0005: 二进制 TLV 帧格式

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件, 小程序, 文档

## 背景

BLE 上需定义小程序 ↔ 固件的数据帧格式。候选：二进制 TLV、JSON 文本、Modbus RTU over BLE。

## 决策

采用**二进制 TLV 帧**：

```
[0xAA] 帧头 (1B)
[len]   payload 长度 (2B, LE)
[cmd]   命令 (1B)
[seq]   序列号 (1B)
[payload] 命令负载 (len 字节)
[crc16] CRC-16/CCITT 校验 (2B, LE)
```

## 理由

- 灯控参数是结构化小数据，二进制最紧凑、固件解析零依赖
- 帧头 `0xAA` 便于重组时找边界
- `len:2` 支持单帧 ~1.5KB（800 颗灯配置）
- CRC-16 强度足够、开销小
- `seq` 用于"命令-响应"配对与去重

## 影响

- `protocol/frame-spec.md` 定义字段级规范
- `protocol/codegen/` 生成固件 C 头文件 + 小程序 JS 常量（见 ADR-0011）
- 帧解析抽成纯函数（见 ADR-0003）

## 备选

- JSON 文本：可读性好但解析开销大、单片机侧需 JSON 库
- Modbus RTU over BLE：标准化但灯效参数表达力弱