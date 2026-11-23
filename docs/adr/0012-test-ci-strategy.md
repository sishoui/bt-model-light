# ADR-0012: 测试与 CI 三层

- 状态: 已接受
- 日期: 2026-11-23
- 标签: 测试, 小程序, 固件

## 背景

arena-feasibility 报告给出了 Mock/真机边界的最小可行集。本项目为轻量灯控，需决定测试与 CI 策略。

## 决策

采用**三层测试 + GitHub Actions CI**：

| 层 | 内容 | 工具 | 频率 |
|---|---|---|---|
| 1. 逻辑单测 | 帧编解码、校验和、状态机、JS 拆帧重组与背压 | Jest + 自建 `global.wx` mock；PlatformIO + Unity | 每次 commit |
| 2. 真机 smoke | 端到端：扫码→连接→发指令→硬件响应→回传；含权限路径 | 真机 + 真实硬件 | 每次发布前 |
| 3. 代码生成一致性 | 生成结果与手写一致 | codegen 脚本 | 每次 commit |

- **不上 automator**（维护成本不值，本项目轻量）
- 真机 smoke：iOS + Android 各一台

## 理由

- 与 arena 报告"最小可行集"对齐，并裁剪掉 automator
- Mock 覆盖逻辑正确性，真机覆盖物理正确性，两者不可互相替代
- 代码生成一致性检查防止两端漂移

## 影响

- `miniprogram/package.json` 含 Jest 配置 + `tests/wx-mock.js`
- `firmware/test/` 含 Unity 单测
- `.github/workflows/ci.yml` 定义 CI（Windows runner 跑 PlatformIO）
- 发布前手动跑真机 smoke

## 备选

- 加 automator / HIL / 多品牌矩阵：对轻量项目过重
- 仅本地手动：无 CI 保障