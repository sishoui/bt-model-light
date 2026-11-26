# bt-model-light

微信小程序 + ESP32-C3-FH4 固件，用于控制 WS2812B 灯光硬件。支持 8 引脚顺序刷新、每引脚 ≤100 颗灯珠、设备→引脚→灯组→步骤→图层 的配置层级、8 种灯效与双图层合成。

## 目录结构

```
bt-model-light/
├── firmware/          # ESP32-C3 固件（PlatformIO + Arduino-ESP32）
├── miniprogram/       # 微信小程序（原生）
├── protocol/          # 协议定义（单一真相源）+ 代码生成
├── docs/
│   ├── adr/           # ADR 0001-0032（另有 0013a）
│   └── smoke-test.md  # 发版前真机清单
├── arena-feasibility/ # 测试策略可行性分析（ADR-0003/0006/0008/0012 的依据）
├── .github/           # CI
├── GLOSSARY.md        # 领域术语
├── design.md          # 小程序 UI 设计基准
├── SPEC.md            # 设计阶段 spec 快照（正文同 issue #20）
└── README.md
```

## 配置层级

设备 → 引脚（8 个） → 灯组（每引脚 ≤5 个） → 灯珠区间 → 步骤（每灯组 ≤5 个） → 灯效图层（每步骤 1~2 个）。

## 灯效（8 种）

常亮 / 呼吸 / 闪烁 / 跑马灯 / 彩虹渐变 / 流星拖尾 / 双色渐变 / 律动跳变。

双图层合成：动效层 RGB 非黑取动效层，否则取背景层。

## 通信协议

二进制 TLV 帧：`[0xAA][len:2][cmd:1][seq:1][payload:len][crc16:2]`。

命令集见 `protocol/commands.csv`（决策记录：`docs/adr/0007-command-set.md`）。

## 设计决策

所有决策落成 ADR（`docs/adr/0001-*.md` … `0032-*.md`，另有 `0013a`），术语见 `GLOSSARY.md`。

## 测试

- Jest + 自建 wx mock（JS 逻辑层，每 commit）
- PlatformIO + Unity（固件无硬件模块，每 commit）
- 代码生成一致性检查（每 commit）
- 真机 smoke test（发布前；当前只有 Android 设备可跑，清单见 [`docs/smoke-test.md`](docs/smoke-test.md)）

CI 三层（`.github/workflows/ci.yml`）：代码生成一致性 + 小程序 Jest + 固件 Unity，每次 push/PR 运行。

## 状态

已实现并可运行：固件（协议 1.2 / 固件 0.3）、小程序（App 0.3）、`protocol/` 定义与代码生成、测试三层 + CI。
设计阶段的 spec 快照见 `SPEC.md`（= issue #20 正文）；进度与待办见 GitHub issues。