# bt-model-light

微信小程序 + ESP32-C3-FH4 固件，用于控制 WS2812B 灯光硬件。支持 8 引脚顺序刷新、每引脚 ≤100 颗灯珠、设备→引脚→灯组→步骤→图层 的配置层级、8 种灯效与双图层合成。

## 目录结构

```
bt-model-light/
├── firmware/          # ESP32-C3 固件（PlatformIO + Arduino-ESP32）
├── miniprogram/       # 微信小程序（原生）
├── protocol/          # 协议定义（单一真相源）+ 代码生成
├── docs/
│   └── adr/           # ADR 0001-0027
├── .github/           # CI
├── GLOSSARY.md        # 领域术语
└── README.md
```

## 配置层级

设备 → 引脚（8 个） → 灯组（每引脚 ≤5 个） → 灯珠区间 → 步骤（每灯组 ≤5 个） → 灯效图层（每步骤 1~2 个）。

## 灯效（8 种）

常亮 / 呼吸 / 闪烁 / 跑马灯 / 彩虹渐变 / 流星拖尾 / 双色渐变 / 律动跳变。

双图层合成：动效层 RGB 非黑取动效层，否则取背景层。

## 通信协议

二进制 TLV 帧：`[0xAA][len:2][cmd:1][seq:1][payload:len][crc16:2]`。

命令集见 `docs/adr/0007-command-set.md`。

## 设计决策

所有决策落成 ADR（`docs/adr/0001-*.md` … `0027-*.md`），术语见 `GLOSSARY.md`。

## 测试

- Jest + 自建 wx mock（JS 逻辑层，每 commit）
- PlatformIO + Unity（固件协议解析层，每 commit）
- 代码生成一致性检查（每 commit）
- 真机 smoke test（发布前，iOS + Android 各一台）

## 状态

设计阶段完成，代码尚未开始。跟踪进度见 GitHub issues。