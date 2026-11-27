# AGENTS.md

## 沟通语言

所有结论（回答、总结、计划、评审报告、issue 评论等面向用户的文本）统一用**中文**回答。

## 测试分工：能自动跑的直接跑，只有人工项才交给用户

交付/验证阶段，按"能否自动执行"分流，不要把自动项丢回给用户：

- **能自动跑的，直接跑完再汇报结果**，不要让用户手动执行。本项目含：
  - 小程序逻辑层：`cd miniprogram && npm test`（Jest）
  - 固件协议解析层：`cd firmware && pio test -e native`（PlatformIO + Unity，无需硬件）
  - 代码生成一致性：`python protocol/codegen/generate.py --check` 与 `python protocol/codegen/test_repeatable.py`
  - CI 三层：push 后到 GitHub Actions 看 workflow 是否全绿（可 `gh run` 查询）
- **只有真机 / 物理硬件才能验证的才展示清单交给用户**，按 `docs/smoke-test.md`（清单当前为 **Android 单机**，无 iOS 设备；权限路径、空口 MTU/分包、灯珠实动、OTA 升级等）。对这类项，明确说清"需人工真机测试"及其原因，不要用自动测试的结论替代。

### 小程序变更：自动触发真机预览（免扫码）

只要本次改动落在 `miniprogram/`（`pages/**`、`utils/**`、`app.js`/`app.json`/`app.wxss`、`project.config.json` 等），在跑完 `cd miniprogram && npm test` 后**自动**追加一步真机预览，不要等用户开口。用户明确要求**不要生成二维码让用户扫**，用自动预览：

- 首选 CLI：`cli auto-preview --project <miniprogram 绝对路径>`（手机同账号微信自动打开，无需扫码）。
- GUI 等价路径：开发者工具顶部「预览」→「自动预览」Tab → 勾选「启动手机端自动预览」→「编译并预览」（Shift+Ctrl+P）。
- CLI 路径：`C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`（已在 PATH 之外，需全路径调用；Git Bash 下用反斜杠路径）。
- 前置条件：手机微信在前台运行且登录与开发者工具同一账号（当前为"死守i"）。不满足时手机端不会自动打开，需提示用户检查账号/前台状态。
- 成功标准：输出 `✔ auto-preview`（或面板正常关闭）且无 error；编译失败时**不要**继续，直接把错误贴出来让用户先修。
- 手机端查看与物理层验证（空口 MTU/分包、灯珠实动等）仍属人工项，不替代 `docs/smoke-test.md`。

## 服务器与固件发布

固件升级走 **BLE OTA**（ADR-0034）：小程序从服务器下载镜像再分块写进设备，
设备本身不联网。服务器同时是固件分发源。

### 凭据：`deploy/server.env`（不入库）

真实凭据只存在于 `deploy/server.env`，已列入 `.gitignore`。**禁止**把密码写进
issue / commit message / 日志 / 代码注释 / 截图。模板见 `deploy/server.env.example`。

字段：

| 键 | 含义 |
|---|---|
| `SERVER_HOST` / `SERVER_PORT` / `SERVER_USER` / `SERVER_PASSWORD` | SSH 连接 |
| `SERVER_FIRMWARE_DIR` | 服务器上的固件目录（nginx 静态根） |
| `FIRMWARE_BASE_URL` | 小程序下载 bin/manifest 的基地址 |
| `SERVER_API_DIR` / `SERVER_ADMIN_DIR` | 后端代码目录 / 后台产物目录（nginx `/admin/` alias） |
| `DB_PATH` | 服务器上 SQLite 路径（`publish` 前自动时间戳备份） |
| `API_BASE_URL` | 小程序 `wx.request` 基地址 |
| `WX_APP_ID` / `WX_APP_SECRET` | `code2Session` 登录凭据 |
| `ADMIN_INIT_USER` / `ADMIN_INIT_PASSWORD` | 管理后台初始账号（仅库中无 admin 时创建一次） |

**如何读取**（任选一种，不要把值回显到聊天里）：

```sh
# 1) 首选：让脚本自己读（凭据不出进程）
python scripts/firmware_release.py status

# 2) 需要 shell 变量时（Git Bash）
set -a; . deploy/server.env; set +a
# 之后 $SERVER_HOST 等可用；不要在命令里 echo $SERVER_PASSWORD

# 3) 只确认键是否存在（不打印值）
python - <<'PY'
from pathlib import Path
for line in Path("deploy/server.env").read_text(encoding="utf-8").splitlines():
    if line.strip() and not line.startswith("#"):
        print(line.split("=", 1)[0])
PY
```

### 发布链路（仓库根目录）

```sh
python scripts/firmware_release.py probe         # SSH 探测服务器现状（只读）
python scripts/firmware_release.py setup-nginx   # 幂等挂载 /firmware/（备份 + nginx -t 失败即还原）
python scripts/firmware_release.py build         # pio run + 生成 dist/firmware/{bin,manifest.json}
python scripts/firmware_release.py publish       # 上传 bin 与 manifest（先 bin 后 manifest）
python scripts/firmware_release.py verify        # HTTP 拉回并校验 size/crc32
python scripts/firmware_release.py status        # 本地 dist + 远端目录
```

- 依赖：`paramiko`（`python -m pip install paramiko`）；`build` 需要 `pio`。
- 版本号来自 `protocol/versions.csv`，**发版必须改它**，否则 manifest 版本不动。
- 镜像超过 `ota_0/ota_1` 分区（0x1E0000 = 1.875MB）时 `build` 直接失败。
- 分布地址是 HTTP + IP：微信**体验版/正式版**要求 HTTPS + 备案域名，IP 直连只在
  开发者工具与"真机调试"下可用（ADR-0034 §9）。换域名只改
  `miniprogram/utils/otaClient.js` 的 `DEFAULT_BASE_URL`，或运行时写 Storage
  `bt_firmware_base_url`。

### 发版顺序（不可颠倒）

1. `python protocol/codegen/generate.py` → `generate.py --check` 两个产物一致。
2. `cd firmware && pio test -e native` + `cd miniprogram && npm test`。
3. `pio run` 通过后 `firmware_release.py build` / `publish` / `verify`。
4. 现网 0.3 固件无 OTA 能力 → **第一台 0.4 必须数据线烧录**，之后才能 OTA。
5. 真机验证（`docs/smoke-test.md` 第五节 OTA 清单）通过后才算发布完成。

## 后端与后台发布

后端 = `server/`（Express + `node:sqlite`，ADR-0035）；后台 = `admin/`（Vue 3 + Vite + 手写 SVG 图表，ADR-0036/0037）；
遥测 = 小程序打点 → `telemetry` 表 → 后台图表（ADR-0037）。
同一份 `deploy/server.env`，同一套"备份 → 校验 → 失败即还原"策略。

### 自动化测试（能跑的直接跑，别丢给用户）

```sh
cd server && npm test        # node --test，临时 DB，含真 HTTP listener 端到端
cd admin && npm run build    # vite build（产物不入库）
```

### 发布链路（仓库根目录）

```sh
python scripts/backend_deploy.py probe        # SSH 探测（只读：Node/systemd/nginx/目录/DB）
python scripts/backend_deploy.py setup        # 建目录 + systemd unit（幂等，需 Node ≥ 22.5）
python scripts/backend_deploy.py pipeline     # build → publish → setup-nginx → restart → verify
python scripts/backend_deploy.py status       # 服务状态 / DB 大小 / 表行数
python scripts/backend_deploy.py logs         # journalctl -u bt-light-api -n 80
python scripts/backend_deploy.py backup       # 备份远端 SQLite（带时间戳）
```

- 依赖：`paramiko`；`build` 需要本机 `npm`。远端 `npm ci --omit=dev` 只装 express
  （`node:sqlite` 与 `scrypt` 都是 Node 内置，**不编译原生模块**）。
- `publish` 会**覆盖**远端 `SERVER_API_DIR`，服务器上手改的代码会丢；
  `node_modules` 与 DB 由远端自己维护（不随上传清掉）。
- `setup-nginx` 幂等插入 `/api/` 反代与 `/admin/` alias：先 `nginx -t`，
  失败即删临时文件、原配置不动（备份 `pandanote.bak.<时间戳>`）。
- 撤销 nginx 改动：`cp -a /etc/nginx/sites-available/pandanote.bak.<时间戳> /etc/nginx/sites-available/pandanote && nginx -t && systemctl reload nginx`。
- 回滚后端：`publish` 保留 `<dir>.old`（上一版），手工 `mv` 回来再 `restart` 即可。

### 权限与凭据

- 后端只监听 `127.0.0.1:3000`；对外一律经 nginx。systemd unit 用 `User=www-data`，
  env 从 `/etc/bt-light/api.env`（600）注入。
- `WX_APP_SECRET` / `ADMIN_INIT_PASSWORD` **禁止**写进 issue / commit / 日志 / 截图。
  需要轮换：改 `deploy/server.env` → `publish`（注意初始管理员只在库空时创建，
  改密码要么进后台改、要么清掉 users 里的 admin 再 publish）。
- 换域名/HTTPS 时改两处：`deploy/server.env` 的 `API_BASE_URL`，以及
  `miniprogram/utils/apiClient.js` 的 `DEFAULT_BASE_URL`（或运行时 Storage `bt_api_base_url`）。

### 遥测与图表验收（ADR-0037）

```sh
python scripts/seed_telemetry.py --days 14 --url http://127.0.0.1:3000/api   # 本机灌演示数据
python scripts/seed_telemetry.py --days 14                                    # 直接写线上（默认取 API_BASE_URL）
```

- 演示数据的 `dim` 带 `real/sim`、`deviceId` 以 `seed-` 开头，后台可直接辨认。
- **图表必须真看**：三类 bug（刻度不可读、末位标签被裁、桶标签重叠）接口断言抓不到，
  所以验收要求打开 `/admin/` 逐页截图确认图表有形状。
- 指标白名单在 `server/src/telemetry.js` 的 `METRICS`：新增指标只加一行，
  小程序/前端都不用改；未知指标计入 `rejected` 不报错。

### 后台按期检查项（部署后）

1. `python scripts/backend_deploy.py verify` 五项全绿（直连/反代 health、`/admin/`、未授权 401、错凭据 401）。
2. 打开 `http://<SERVER_HOST>/admin/` 用初始账号能登录，四个页面无报错。
3. 「立即改掉初始管理员密码」。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `sishoui/bt-model-light` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles (`needs-triage`/`needs-info`/`ready-for-agent`/`ready-for-human`/`wontfix`) plus component labels (`小程序`/`后台`/`后端`/`固件`/`数据库`/`文档`/`测试`/`人工测试`). Component labels are added on top of the role label for every issue that touches a concrete area; `测试` marks test-file changes and `人工测试` marks issues needing manual QA. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.