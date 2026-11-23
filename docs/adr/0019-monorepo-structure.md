# ADR-0019: Monorepo 结构

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 文档

## 背景

小程序与固件代码如何组织？分仓、单仓库无共享、monorepo 三选一。

## 决策

采用 **Monorepo**：

```
bt-model-light/
├── firmware/          # ESP32-C3 PlatformIO 工程
├── miniprogram/       # 微信小程序（原生）
├── protocol/          # 协议定义 + 代码生成
├── docs/              # ADRs + agents 配置
│   └── adr/
├── .github/           # CI
├── GLOSSARY.md
└── README.md
```

## 理由

- 协议是两端唯一契约，单独目录放协议定义 + 生成脚本
- 共享 issue、CI、文档
- 避免两端协议漂移

## 影响

- `protocol/` 结构见 ADR-0011
- CI 一次构建两端（见 ADR-0012）
- 单一仓库便于 issue 跟踪

## 备选

- 分仓：协议同步痛
- 单仓库无共享：协议漂移风险