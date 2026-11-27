# bt-model-light

微信小程序 + ESP32-C3-FH4 固件，用于控制 WS2812B 灯光硬件。支持 8 引脚顺序刷新、每引脚 ≤100 颗灯珠、设备→引脚→灯组→步骤→图层 的配置层级、8 种灯效与双图层合成。另含 Node.js 后端与管理后台（用户/设备归属）。

## 目录结构

```
bt-model-light/
├── firmware/          # ESP32-C3 固件（PlatformIO + Arduino-ESP32）
├── miniprogram/       # 微信小程序（原生）
├── server/            # 后端 API（Express + node:sqlite，ADR-0035）
├── admin/             # 管理后台（Vue 3 + Vite + 手写 SVG 图表，ADR-0036/0037；产物不入库）
├── protocol/          # 协议定义（单一真相源）+ 代码生成
├── docs/
│   ├── adr/           # ADR 0001-0037（另有 0013a）
│   └── smoke-test.md  # 发版前真机清单（含 OTA、用户配置页）
├── deploy/            # 服务器凭据与部署配置（server.env 不入库，模板在此）
├── scripts/           # firmware_release.py（固件）/ backend_deploy.py（后端+后台）
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

## 用户与后端

登录**可选**：不登录照常连 BLE 改配置（本地 Storage 是真相源），登录后设备清单同步到云端，换手机不丢。

1. 小程序 `wx.login` → `POST /api/auth/wx-login` → 后端 `code2Session` 换 `openid` → 发会话 token（ADR-0035）。
2. 设备增/改/删后 best-effort 推服务端；登录后按 BLE `deviceId` 与云端清单双向补齐（`utils/cloudSync.js`）。
3. 后端只存"谁用过哪台设备"与昵称/头像，**不存灯组配置**（灯组仍在本地 + 固件）。
4. 管理后台 `/admin/`：概览、用户启停（即时踢下线）、设备删除、审计日志。
5. 遥测（ADR-0037）：小程序在 BLE/配置/OTA/错误等汇聚点打点，后台画趋势、分布与失败 Top。

后端（Express + `node:sqlite`，零原生依赖；需要 Node ≥ 22.5）：

```sh
cd server && npm ci && npm test
cd server && npm start        # 仅监听 127.0.0.1:3000，对外经 nginx /api/
```

部署（凭据见 `AGENTS.md`「后端与后台发布」）：

```sh
python scripts/backend_deploy.py probe        # 只读探测
python scripts/backend_deploy.py pipeline     # build → publish → setup-nginx → restart → verify
python scripts/backend_deploy.py status       # 服务 / DB / 表行数
python scripts/backend_deploy.py logs         # journalctl 最近 80 行
python scripts/backend_deploy.py backup       # 备份远端 SQLite
```

## 固件升级（BLE OTA）

设备只有 BLE、不联网，所以升级由小程序中继（ADR-0034）：

1. 服务器存 `manifest.json` + `firmware.bin`（nginx 挂 `/firmware/`）。
2. 小程序下载并校验（size + CRC-32）→ 按 `0xF0` 子命令分块写入 → 设备切 OTA 分区重启。
3. 新镜像起不来自动回滚上一版（`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`）。
4. 连接设备时固件主动上报版本号，首页/用户配置页直接显示。

发布（服务器凭据见 `AGENTS.md`「服务器与固件发布」）：

```sh
python scripts/firmware_release.py build
python scripts/firmware_release.py publish
python scripts/firmware_release.py verify
```

## 设计决策

所有决策落成 ADR（`docs/adr/0001-*.md` … `0037-*.md`，另有 `0013a`），术语见 `GLOSSARY.md`。

## 测试

- Jest + 自建 wx mock（小程序逻辑层，每 commit）
- `node --test` + 真 HTTP listener（后端 API，每 commit）
- PlatformIO + Unity（固件无硬件模块，每 commit）
- 代码生成一致性检查（每 commit）
- Vite 构建（管理后台，每 commit）
- 真机 smoke test（发布前；当前只有 Android 设备可跑，清单见 [`docs/smoke-test.md`](docs/smoke-test.md)）

CI 五个 job（`.github/workflows/ci.yml`）：代码生成一致性 + 小程序 Jest + 固件 Unity + 后端 API 测试 + 后台构建。

## 状态

已实现并可运行：固件（协议 1.2 / 固件 0.4，含 BLE OTA）、小程序（App 0.5，含用户配置页）、
后端 API + 管理后台（已上线 `http://117.72.163.247/api` 与 `/admin/`）、`protocol/` 定义与代码生成、测试 + CI。

设计阶段的 spec 快照见 `SPEC.md`（= issue #20 正文）；进度与待办见 GitHub issues。

> 已知限制：服务器目前只有 IP、没有 HTTPS 备案域名，因此云同步与登录只在开发者工具/真机调
> 试可用；体验版/正式版会被域名校验拦截（ADR-0034 §9 / ADR-0035「已知限制」）。
