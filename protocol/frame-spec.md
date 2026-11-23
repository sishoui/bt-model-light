# 帧格式规范

> 单一真相源见 `docs/adr/0005-binary-tlv-frame.md`。本文是帧的字节级规范，供固件 `protocol_parser.c`、小程序 `frameParser.js` 与代码生成器共用。

## 总览

```
+---------+--------+--------+--------+-----------------+---------+
| 0xAA    | len    | cmd    | seq    | payload         | crc16   |
| 1 byte  | 2 byte | 1 byte | 1 byte | len byte        | 2 byte  |
| header  | LE     |        |        |                 | LE      |
+---------+--------+--------+--------+-----------------+---------+
```

整帧长度 = `7 + len` 字节（帧头1 + len2 + cmd1 + seq1 + payload + crc16 2）。

## 字段

| 偏移 | 字段 | 类型 | 长度 | 说明 |
|---|---|---|---|---|
| 0 | `header` | uint8 | 1 | 固定 `0xAA` |
| 1 | `len` | uint16le | 2 | payload 长度，0 ~ 1500 |
| 3 | `cmd` | uint8 | 1 | 命令码，见 `commands.csv` |
| 4 | `seq` | uint8 | 1 | 序列号，命令/响应配对 |
| 5 | `payload` | bytes | `len` | 命令负载，内容随 cmd 而定 |
| 5+len | `crc16` | uint16le | 2 | CRC-16/CCITT 校验，覆盖 header 到 payload 末字节 |

## 约束

- `len` 上限 **1500**（单帧 payload 上限，满足 ADR-0005 单帧 ~1.5KB / 800 颗灯配置的预算）。
- 整帧（含 header + len + crc16）上限 **1507** 字节。
- CRC 覆盖 `[header .. payload_last_byte]`，不含 crc16 自身。
- 多字节整数除特别说明外均按 **小端 (LE)**。
- RGB 色值按 **R, G, B** 顺序 3 字节。
- 预留字节（如 direction 0 保留）写入 0。

## CRC-16/CCITT

- 多项式：`0x1021`（x^16 + x^12 + x^5 + 1）
- 初始值：`0xFFFF`
- 输入：header + len + cmd + seq + payload
- 反射：无（MSB 优先）
- 最终异或：`0x0000`
- 字节序：低字节先（LE）

参考实现（C）：

```c
uint16_t crc16_ccitt(const uint8_t *data, size_t len) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : (crc << 1);
        }
    }
    return crc;
}
```

## 重组（ADR-0006）

接收端维护字节流缓冲，按以下规则从流中提取一帧：

1. 找帧头 `0xAA`；非帧头字节丢弃。
2. 已收集 ≥3 字节时读 `len`（LE）。
3. 校验 `len ≤ 1024`；否则丢弃已收集字节并回到步骤 1。
4. 等待缓冲凑齐 `6 + len` 字节（header + len + cmd + seq + payload + crc16）。
5. 用 `crc16_ccitt` 校验；通过则交付一帧（cmd + seq + payload），否则丢弃该帧并回到步骤 1。
6. 不依赖 BLE 单包整帧；不引入应用层 ACK。

## seq 语义

- 命令用 seq 标记序号，响应回显同一 seq。
- seq 从 0 起单调递增（uint8 回绕）。
- notify（cmd=0x81）的 seq 用于与触发的命令配对；无触发时 seq 可任意。
- 小程序丢弃 seq 不匹配的 notify 时记录日志。

## 单帧长度与 MTU

- 单帧 payload 上限 1500 字节（`len` 上限），整帧 1507 字节。
- BLE 默认 MTU 23，实际有效负载 ~20 字节，因此 **整帧几乎总是分多次 BLE 传输送达**。
- 重组逻辑必须容忍任意分包方式（按字节流处理，不假定传输边界）。
- 空口 MTU 协商与 notify 时序由真机 smoke test 验证，不作为正确性前提（ADR-0006 / ADR-0012）。