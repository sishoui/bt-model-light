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
3. 校验 `len ≤ 1500`；否则丢弃已收集字节并回到步骤 1。
4. 等待缓冲凑齐 `6 + len` 字节（header + len + cmd + seq + payload + crc16）。
5. 用 `crc16_ccitt` 校验；通过则交付一帧（cmd + seq + payload），否则丢弃该帧并回到步骤 1。
6. 不依赖 BLE 单包整帧；不引入应用层 ACK。

## STATUS_NOTIFY（0x81）负载

notify 通道统一回传布局（固件构建 / 小程序解析共用）：

| 偏移 | 字段 | 长度 | 说明 |
|---|---|---|---|
| 0 | status | 1 | 回传类型：`0`=OK / `1`=STATE / `2`=ERROR / `3`=VERSION |
| 1 | code | 1 | OK：回显触发的命令码；STATE：状态机状态值；ERROR：错误码（见 `errors.csv`）；VERSION：固定 0 |
| 2 | seq | 1 | 触发命令的 `seq` 回显；无触发（主动 notify）填 0 |
| 3 | data | 4 | 仅 VERSION：`[协议主版本, 协议次版本, 固件主版本, 固件次版本]` 各 1 字节；其余类型无 data |

- STATE 状态值：`0`=IDLE / `1`=CONNECTED / `2`=CONFIGURED / `3`=PLAYING / `4`=PREVIEW / `5`=PAUSED（状态机见 `docs/adr/0016-state-machine-watchdog.md`）。
- VERSION 由小程序收到后校验协议版本主次均匹配（`docs/adr/0009-protocol-version-negotiation.md`）；ERROR 按错误码给出用户提示（`docs/adr/0026-error-handling.md`）。

## seq 语义

- 命令用 seq 标记序号，响应回显同一 seq。
- seq 从 0 起单调递增（uint8 回绕）。
- notify（cmd=0x81）的 seq 用于与触发的命令配对；无触发时 seq 可任意。
- 小程序丢弃 seq 不匹配的 notify 时记录日志。

## 单帧长度与 MTU

- 单帧 payload 上限 1500 字节（`len` 上限），整帧 1507 字节。
- BLE 默认 MTU 23，实际有效负载 ~20 字节，因此 **整帧几乎总是分多次 BLE 传输送达**。
- 重组逻辑必须容忍任意分包方式（按字节流处理，不假定传输边界）。
- 分片上限按协商 MTU 自适应（ADR-0029）：固件 local MTU 517；安卓 `wx.setBLEMTU(512)` → 509 字节/包，iOS 自动协商 185 → 182 字节/包，协商不到时退回 20 字节安全下界（首片被平台拒即整帧退回重发）。
- 空口 MTU 协商与 notify 时序由真机 smoke test 验证，不作为正确性前提（ADR-0006 / ADR-0012 / ADR-0029）。

## 配置负载（WRITE_CONFIG / READ_CONFIG）

`WRITE_CONFIG`（cmd=0x01）与 `READ_CONFIG`（cmd=0x02）的 payload 是同一份**配置 blob**（小端）。固件 `firmware/src/config.cpp` 编解码，spiffs `/config.bin` 存的就是这份 blob（含 magic + crc，便于重启自恢复与损坏检测）。层级：8 引脚 → 灯组 → 步骤 → 图层（ADR-0007/0020/0021）。

### Blob 外层（自描述 + 完整性）

| 偏移 | 字段 | 长度 | 说明 |
|---|---|---|---|
| 0 | `magic` | 4 | 固定 `42 54 4C 43`（"BTLC"，LE u32 = 0x434C5442） |
| 4 | `version` | 1 | 配置结构版本，当前 = 1 |
| 5 | `flags` | 1 | 预留，写 0 |
| 6 | `body_len` | 2 LE | 后续 body 字节数 |
| 8 | `body` | `body_len` | 引脚配置数据（见下） |
| 8+body_len | `crc16` | 2 LE | CRC-16/CCITT，覆盖 `magic .. body_last_byte` |

blob 总长 = `10 + body_len`。

### Body（8 个引脚块，每块必存在）

每个引脚块：

| 字段 | 长度 | 说明 |
|---|---|---|
| `group_count` | 1 | 该引脚灯组数，0~5（`GROUPS_PER_PIN_MAX`） |
| 灯组 × group_count | 变长 | 见下 |

灯组：

| 字段 | 长度 | 说明 |
|---|---|---|
| `led_start` | 1 | 起始灯珠索引，0~99 |
| `led_end` | 1 | 结束灯珠索引，0~99，且 ≥ led_start |
| `step_count` | 1 | 步骤数，1~5（`STEPS_PER_GROUP_MAX`） |
| 步骤 × step_count | 变长 | 见下 |

步骤（ADR-0021 步骤结构）：

| 字段 | 长度 | 说明 |
|---|---|---|
| `duration` | 2 LE | 步骤时长（秒），1~60（`STEP_DURATION_MIN/MAX`） |
| `transition` | 1 | 过渡：0=无 / 1=淡入淡出 / 2=平滑 |
| `loop_mode` | 1 | 循环：0=单次 / 1=循环 / 2=往复 |
| `layer_count` | 1 | 图层数，1~2（`LAYERS_PER_STEP_MAX`） |
| 图层 × layer_count | 变长 | 见下 |

图层：

| 字段 | 长度 | 说明 |
|---|---|---|
| `effect_id` | 1 | 效果 ID，1~8（`EFFECT_TABLE`） |
| `param_len` | 1 | 参数块字节数（按 effect_id 查表应为定值；置 0 表示用默认） |
| `params` | `param_len` | 参数块，按 `EFFECT_PARAMS` schema 顺序拼接：rgb=3B(R,G,B)、u8=1B、u16=2B LE、u32=4B LE |

### 约束

- `10 + body_len ≤ FRAME_LEN_MAX(1500)`，否则固件回 `0x03 配置超限`。
- 典型配置（8 引脚 × 2 灯组 × 2 步骤 × 2 图层）约 700~750 字节，单帧可承载。
- 最坏情况（8×5×5×2）超 1500，按超限拒绝（ADR-0013a 预算针对典型场景）。
- `effect_id` 未知 / `param_len` 与查表不符 / 索引越界 → 固件回 `0x04 参数非法`，不崩溃。
- `group_count = 0` 表示该引脚无灯组：固件渲染时清空整条灯带。小程序把"引脚灯带开关关闭"编码为这一形态（灯组配置仍保留在 Storage，ADR-0028）。
- spiffs 加载：magic/version/crc 任一不符 → 视为损坏，fallback 出厂默认（ADR-0015）。

## SET_BRIGHTNESS（0x0A）负载

| 偏移 | 字段 | 长度 | 说明 |
|---|---|---|---|
| 0 | `brightness` | 1 | 整机亮度 0~255：255 = 不缩放（原样）/ 0 = 全黑 / 其余按 `value/255` 整数缩放 |

- 缩放发生在**输出级**：固件在写灯珠像素前把颜色乘以 `brightness/255`（整数除法），
  因此对配置播放、预览与 IDLE 出厂默认彩虹一律生效，且不改动任何灯组/图层参数
  （与图层参数里的 `brightness` 是相乘关系）。
- `len != 1` → 固件回 `0x04 参数非法`，亮度保持不变。
- 任意状态可发（含 IDLE/CONNECTED）：亮度不是状态迁移，不改变状态机状态。
- 亮度是设备 RAM 态，不落 spiffs（ADR-0031）；断连/重启后由小程序补发。

## SET_POWER（0x0B）负载

| 偏移 | 字段 | 长度 | 说明 |
|---|---|---|---|
| 0 | `on` | 1 | 整机开关：`0` = 关机（输出全黑）/ `1` = 开机（正常渲染） |

- 门控发生在**输出级**：关机时固件在写灯珠像素前把颜色置黑——**不改动配置、不改动
  各引脚自己的灯带开关状态**（`pin.power`），开机后各引脚按原状态继续渲染（ADR-0032）。
  与 SET_BRIGHTNESS 同一个出口，因此对配置播放、预览与 IDLE 出厂默认彩虹一律生效。
- `len != 1` 或取值不为 0/1 → 固件回 `0x04 参数非法`，开关状态保持不变。
- 任意状态可发（含 IDLE/CONNECTED）：整机开关不是状态迁移，不改变状态机状态。
- 整机开关是设备 RAM 态，不落 spiffs（ADR-0032）；断连/重启后由小程序补发。