# ADR-0035: 用户体系与后端 API

- 状态: 已接受
- 日期: 2026-11-27
- 标签: 小程序 / 后端 / 数据库 / 协议 / 运维

## 背景

到 ADR-0034 为止，整个系统是**纯离线**的：设备靠 BLE，小程序把配置写在自己的 Storage
（`bt_devices` / `device_config_<id>`），服务器只当固件下载源。

这带来两个问题：

1. **换手机 / 重装小程序就丢设备清单**——用户得重新扫描、重新命名每一台设备；
2. **没有"用户"这个概念**——无法知道哪台设备归谁，出问题也无法远程排障。

需要引入最小可用的账号与后端，且**不能破坏离线可用性**：BLE 是本地链路，断网也必须能改配置。

## 决策

### 1. 身份：微信登录（`wx.login` → 后端 `code2Session`）

- 小程序 `wx.login` 拿 `code` → `POST /api/auth/wx-login` → 后端用 AppID+AppSecret 换
  `openid` → 建号（首次）→ 发会话 token。
- `openid` 是小程序内的稳定唯一身份（同一微信用户在不同手机上相同），不依赖手机号/邮箱。
- **登录可选**：不登录照常 BLE 使用，只是没有云端设备归属。理由：微信接口故障或用户
  拒绝授权时，不能让灯控变砖（这是硬件遥控器，可用性优先）。

### 2. 会话：服务端随机 token + 数据库，不用 JWT

- token = 32 字节随机 hex，存 `sessions` 表（`token / user_id / expires_at`）。
- 每请求一次主键查询（这个量级无感），换来**即时吊销**能力：后台禁用用户 → 其
  token 立刻失效。JWT 的"签发后不可撤销"在这里是缺点。
- 有效期 30 天（`TOKEN_TTL_DAYS`），过期要求重新 `wx.login`（对用户无感）。

### 3. 数据：SQLite（`node:sqlite` 内置模块）

- 表：`users` / `sessions` / `devices` / `audit_log`（DDL 见 `server/src/db.js`）。
- 为什么是 SQLite 而不是 MySQL：当前量级（单机、几千行）一个文件就够，**备份 = 拷文件**，
  且不需要在服务器上跑第二个数据库守护进程。
- 为什么是 `node:sqlite` 而不是 `better-sqlite3`：服务器上 `npm ci --omit=dev` 不用编译
  任何原生模块（服务器无完整 build 工具链，装原生模块是长期痛点）。代价：启动带
  `ExperimentalWarning`，用 `--no-warnings` 屏蔽。
- 迁移幂等：`create table if not exists` 每次启动跑一遍。

### 4. 设备归属：本地 Storage 仍是真相源，服务端是镜像

这是本 ADR 最关键的取舍。**不做**"以云端为准"的双向同步，因为：

- 设备是 BLE 离线设备，配置必须在断网时也能改；
- 冲突合并（谁新谁旧）需要 per-field 时间戳，复杂度远高于收益。

实际规则（`miniprogram/utils/cloudSync.js`）：

- 本地增/改/删设备后 → best-effort 推服务端（失败只记本地日志，下次 `syncAll` 补齐）；
- 登录后拉云端清单 → 按 **BLE `deviceId`** 合并：云端独有 → 补进本地；本地独有 → 推上去；
- 云端名字更新 → 合并回本地（跨手机改名可见）。

云端不存 `device_config_<id>`（灯组/步骤配置）：那是最频繁变更的数据，且与 BLE 强相关，
同步收益小于复杂度。留作后续（需要时按 `deviceId + version` 追加一张表）。

### 5. API 形状

前缀 `/api`（nginx `location /api/` 反代 `127.0.0.1:3000`），统一错误体：

```json
{ "error": { "code": "INVALID_PARAMETER", "message": "缺少登录凭证 code" } }
```

`message` 面向用户、中文、可直接展示；`code` 供测试与后台定位。
错误文案口径与小程序 `errorHandler.js` 一致（绝不把裸错误码抛给用户）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/wx-login` | `{code}` → `{token, expiresAt, user}` |
| POST | `/auth/logout` | 吊销当前会话 |
| GET | `/me` | 当前用户（不含 openid） |
| PATCH | `/me` | `{nickname?, avatar?}`；头像为 data URL |
| GET | `/devices` | 当前用户的设备清单 |
| POST | `/devices` | `{deviceId, name?, firmwareVersion?}`，**按 deviceId 幂等** |
| PATCH | `/devices/:id` | 改名 / 固件版本 |
| DELETE | `/devices/:id` | 删云端记录（不影响设备本身） |
| GET | `/health` | 探活（部署脚本 verify 用） |

权限：他人设备统一回 `404`（不泄漏 id 是否存在）。

### 6. 安全

- 后端只监听 `127.0.0.1:3000`，对外一律经 nginx；`trust proxy = loopback`。
- 管理员密码 `scrypt`（Node 内置，不引 bcrypt 原生模块），存 `scrypt$salt$hash`。
- 登录接口按 IP 限流 20 次/分钟，全局 300 次/分钟（内存计数，挡住最低级刷接口）。
- 管理员登录失败与状态变更落 `audit_log`（谁、对谁、什么 IP）。
- 不能停用最后一个管理员（否则后台永久进不去）。
- AppSecret 只在 `deploy/server.env`（不入库）→ 部署时写入 `/etc/bt-light/api.env`（600）。

## 影响

- 新增 `server/`（Express + `node:sqlite`，依赖只有 express）与 `scripts/backend_deploy.py`。
- 小程序新增 `utils/apiClient.js` / `utils/userStore.js` / `utils/cloudSync.js`；
  `pages/mine` → `pages/profile`（用户配置页）。
- **BLE/协议/固件完全不受影响**：没有新增命令、没有改帧格式、没有升 `protocol_version`。
  只把 `app_version` 升到 0.5。
- 设备的三处写点各加一行 `cloudSync.push*`（device-list 新增/删除、home 改名）。

## 备选

- **服务端做配置（灯组/步骤）云备份**：收益是换机不丢灯效，成本是冲突解决 + 配置体积
  （每设备 ~2KB × 用户数）。本轮不做，留接口位置。
- **JWT**：省一次查询，但撤销要靠黑名单（又回到一次查询）。否决。
- **MySQL/Postgres**：运维面更大；SQLite 在这个量级更合适。真需要时 `db.js` 是唯一改动点。
- **游客 UUID**：最省事，但后台看到的是匿名 id，无法按人排障。

## 已知限制

微信"体验版/正式版"要求 `wx.request` 域名是 **HTTPS + 已备案域名**。当前 `API_BASE_URL`
是 `http://117.72.163.247/api`，只在开发者工具与"真机调试"下可用（与 ADR-0034 §9 同一限制）。
换域名时只改 `deploy/server.env` 的 `API_BASE_URL` 与 `miniprogram/utils/apiClient.js` 的
`DEFAULT_BASE_URL`（或运行时写 Storage `bt_api_base_url`），不动后端代码。
