# ADR-0010: 固件分区表

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件

## 背景

ESP32-C3 4MB Flash 需规划分区。OTA 延后（ADR-0008）但分区需一开始就规划好，配置与固件需分离（OTA 升级不丢配置）。

## 决策

采用**自定义分区表**：

| 分区 | 类型 | 大小 | 用途 |
|---|---|---|---|
| nvs | data/nvs | 0x5000 | BLE 配对信息、参数 |
| otadata | data/ota | 0x2000 | OTA 数据 |
| ota_0 | app/ota_0 | 0x1E0000 | 应用分区 A |
| ota_1 | app/ota_1 | 0x1E0000 | 应用分区 B（OTA 备份） |
| spiffs | data/spiffs | 0x3F000 | 灯组配置（~1.5KB）、日志 |

## 理由

- 双 OTA 分区是 ESP32 OTA 机制的前提（ADR-0008）
- 配置（spiffs）与固件（ota_0/1）分离，OTA 升级不丢配置
- nvs 存 BLE 配对信息与轻量参数
- spiffs 存较大配置（灯组配置 ~1.5KB）

## 影响

- `firmware/partitions.csv` 定义分区
- 配置读写走 spiffs，见 ADR-0014
- 固件启动检测 spiffs 配置存在性（见 ADR-0015）

## 备选

- 默认分区表：无 OTA 双备份，未来迁移痛
- 单 OTA 分区 + 串口烧录：无法 OTA 回滚