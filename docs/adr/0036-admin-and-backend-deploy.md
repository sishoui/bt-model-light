# ADR-0036: 管理后台与服务端部署

- 状态: 已接受
- 日期: 2026-11-27
- 标签: 后端 / 运维 / 文档
- 依赖: ADR-0035（用户体系与后端 API）

## 背景

ADR-0035 落地了后端 API 与用户概念，但运维侧还缺两件事：

1. 出问题时（用户说"我的设备丢了"）需要一个**能看能改的界面**，而不是 SSH 手敲 SQL；
2. 后端要能在现有服务器上**可持续地部署与回滚**，且不能和已挂的 `/firmware/`
   静态目录、`/pandanote/` 反代互相干扰。

## 决策

### 1. 后台形态：Vue 3 + Vite SPA，挂在 nginx 的 `/admin/`

- 独立 SPA（不是服务端渲染模板）：后台只读/轻写，交互点少但需要表格筛选与分页，
  SPA 的即时反馈更顺；且与小程序端同为"前端独立构建"的心智。
- **不引 UI 库**：4 个页面（概览/用户/设备/审计），原生 CSS + 设计 token 足够，
  省掉整条组件库依赖链（构建产物 84KB JS / 4.9KB CSS）。
- 不用 vue-router：页面少、无深链需求，`active` 状态切换即可。
- `base: '/admin/'`：产物资源路径必须与 nginx alias 一致，否则 404。
- 构建产物**不入库**（`admin/dist` 在 `.gitignore`）：部署脚本本地构建后上传，
  避免仓库里堆积 hash 文件名的产物。

### 2. 部署：`scripts/backend_deploy.py`，复用固件发布脚本的范式

与 `firmware_release.py` 同一份 `deploy/server.env`、同一套 paramiko 连接方式、
同一套"备份 → 校验 → 失败即还原"策略。子命令：

```sh
python scripts/backend_deploy.py probe        # 只读探测
python scripts/backend_deploy.py setup        # 目录 + systemd unit（幂等）
python scripts/backend_deploy.py build        # 本地 vite build
python scripts/backend_deploy.py publish      # 上传 + 远端 npm ci
python scripts/backend_deploy.py setup-nginx  # /api/ 反代 + /admin/ 静态（幂等）
python scripts/backend_deploy.py restart      # 重启服务
python scripts/backend_deploy.py verify       # 直连 + 反代 + 权限链路校验
python scripts/backend_deploy.py pipeline     # 以上顺序跑完
```

关键实现细节：

- **原子切换**：先上传到 `<dir>.new`，成功后再 `mv` 替换旧目录（旧目录留 `.old`）。
  中途失败不会留下半个可运行目录。
- **DB 先备份**：`publish` 开头若 DB 存在则 `cp -a` 成 `.bak.<时间戳>`。
- **env 文件**：渲染成 `/etc/bt-light/api.env`（`install -m 600 -o root`），由 systemd
  `EnvironmentFile=` 注入。AppSecret 不进 unit 文件、不进命令行、不进日志。
- **nginx 幂等插入**：读 `sites-available/pandanote`，缺什么补什么，插入点在
  `location / {` 之前（同 ADR-0034 的 `/firmware/` 策略）；先 `nginx -t`，失败即
  `rm` 临时文件、原文件不动。
- **Nginx 模板用 `%(x)s` 而非 `str.format`**：nginx 配置里的 `{` `}`（`try_files`、
  `types {}`）会被 `str.format` 当占位符——这个坑在首次执行时真踩到了。
- **远端不编译**：`npm ci --omit=dev` 只装 express（`node:sqlite` 与 `scrypt` 都是内置）。

### 3. 进程管理：systemd unit（不用 pm2）

服务器上已有 `pandanote.service` 作为范式，且 `pm2-root` 处于 inactive。
直接沿用 systemd：

```ini
[Service]
User=www-data
WorkingDirectory=/var/www/bt-model-light/api
EnvironmentFile=/etc/bt-light/api.env
ExecStart=/usr/bin/node --no-warnings /var/www/bt-model-light/api/src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/bt-light
```

`--no-warnings` 只屏蔽 `node:sqlite` 的 experimental 告警；错误仍进 journald。

### 4. 目录布局（服务器）

```
/var/www/bt-model-light/
  firmware/    # 固件（ADR-0034，已有）
  api/         # 后端源码 + node_modules（本次新增）
  admin/       # 管理后台构建产物（本次新增）
/var/lib/bt-light/
  bt-light.db  # SQLite（含 -wal / -shm）+ 时间戳备份
/etc/bt-light/
  api.env      # 600，后端环境变量
```

### 5. 校验（`verify` 子命令，全自动）

| 检查 | 期望 |
|---|---|
| `curl 127.0.0.1:3000/api/health` | 200（进程活着） |
| `curl -H 'Host: …' 127.0.0.1/api/health` | 200（反代链路通） |
| `curl -H 'Host: …' 127.0.0.1/admin/` | 200（SPA 产物就位） |
| `curl 127.0.0.1/api/me`（无 token） | 401（鉴权真的生效） |
| `POST /api/admin/login`（错凭据） | 401（管理员已落库、scrypt 生效） |

五项全绿才算部署完成。首轮实测五项全过，公网 `http://117.72.163.247/api/health` 与
`/admin/` 均为 200。

## 影响

- 新增 `admin/`、`scripts/backend_deploy.py`、`deploy/server.env` 的后端字段。
- `.gitignore` 增加 `server/node_modules`、`server/data`、`admin/node_modules`、`admin/dist`。
- CI 增加 `server-tests`（`node --test`）与 `admin-build`（`vite build`）两个 job。
- 与固件发布互不影响：`/firmware/` 的 location 与 `/api/` `/admin/` 并列，
  各自 alias/proxy，无顺序依赖。

## 备选

- **服务端渲染后台（Jinja2/模板）**：服务器上零构建、改动即生效；但表格筛选/分页要
  写不少原生 JS，最终复杂度接近 SPA 却没模块化。否决。
- **pm2 托管**：与既有 systemd 范式不一致，且 pm2 当前是 inactive。
- **后台跑在独立端口/子域名**：需要额外证书与备案域名；当前只有 IP，路径挂载更简单。
- **把后台产物入库**：仓库里会堆积 `index-<hash>.js`，每次构建产生 diff 噪音。

## 已知限制

- 后台是 HTTP + IP，仅在受信网络/内网使用：**上线后请立刻改掉初始管理员密码**
  （或改 `deploy/server.env` 的 `ADMIN_INIT_PASSWORD` 后重新 `publish`——注意初始密码
  只在库中没有 admin 时生效，已建号的不会被覆盖）。
- SQLite 单文件：多进程横向扩展前必须先换 Postgres。当前单实例够用。
- `publish` 会覆盖远端 `api/` 源码目录；手工在服务器上改的代码会在下次部署丢失。
