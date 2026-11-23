# ADR-0011: protocol/ 代码生成

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 文档, 小程序, 固件, 测试

## 背景

monorepo 选定（ADR-0019）后，协议是两端唯一契约。需避免两端手写漂移。

## 决策

`protocol/` 放**单一真相源**定义（CSV/JSON），由代码生成脚本生成：

- 固件 C 头文件（`firmware/include/protocol_gen.h`）
- 小程序 JS 常量（`miniprogram/utils/protocol_gen.js`）

生成脚本在 CI 检查（见 ADR-0012）：生成结果与手写不一致则 CI 失败。

## 理由

- 单一真相源 + 代码生成，避免两端漂移
- 生成脚本同时是 CI 一致性检查
- 与 arena 报告"协议一致性"前提对齐

## 影响

- `protocol/` 目录结构：
  - `frame-spec.md` 帧格式规范
  - `commands.csv` 命令码表
  - `effects.csv` 效果 ID 表
  - `errors.csv` 错误码表
  - `versions.csv` 协议版本
  - `codegen/` 生成脚本（Node 或 Python）
- 两端构建前需跑代码生成

## 备选

- 协议规范只放 Markdown，两端手写：漂移风险
- 运行时读 JSON schema：固件侧不便