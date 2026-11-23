# ADR-0014: 配置持久化（小程序 Storage + 固件 spiffs）

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 固件, 小程序, 数据库

## 背景

配置存储位置：仅小程序 Storage、仅固件 Flash、或两者。用户预期"设好的灯效掉电还在"。

## 决策

采用 **小程序 Storage 为主 + 固件 spiffs 备份**：

- 小程序 Storage 是唯一真相源（编辑、版本管理都在小程序）
- 固件 spiffs 存一份运行副本（ADR-0010）
- 协议支持：写配置 / 读配置 / 恢复默认（ADR-0007）
- 小程序"保存"按钮同时写 Storage + 下发固件
- 固件重启自恢复：从 spiffs 读配置，失败则 fallback 出厂默认（ADR-0015）

## 理由

- 小程序 Storage 是编辑入口，唯一真相源
- 固件 spiffs 提供掉电保留与重启自恢复
- 配置与固件分开（spiffs vs ota 分区），OTA 升级不丢配置

## 影响

- 小程序 Storage key：`device_config_<deviceId>`
- 固件 spiffs 文件：`/config.bin`
- 协议 `WRITE_CONFIG` / `READ_CONFIG` / `RESET_DEFAULT`（ADR-0007）

## 备选

- 仅小程序 Storage：掉电丢失，用户体验差
- 仅固件 Flash：小程序编辑不便，需每次读取