# ADR-0037: 遥测采集与后台图表可视化

- 状态: 已接受
- 日期: 2026-11-27
- 标签: 后端 / 小程序 / 后台 / 数据库
- 依赖: ADR-0035（用户体系与后端 API）、ADR-0036（管理后台与部署）

## 背景

ADR-0036 落地了管理后台，但实际用起来信息量不足：

1. **只有 4 张表、0 个图表**——概览页 5 个数字、用户/设备/审计三张平表。运维只能
   看到"现在有多少行"，看不到"昨天发生了什么、哪一类失败最多、有多少设备还卡在慢分片"。
2. **数据面太窄**——只有用户注册/设备归属/后台操作。真正决定体验的事情（BLE 连不上、
   配置下发失败、OTA 升级失败、空口分片太小）完全没有被记录。
3. 小程序侧的错误只落在**本机 Storage**（`error_log`，ADR-0026），用户不主动截图就永远
   看不到。真机 smoke test 的价值也因此打折。

## 决策

### 1. 一张事件表，不做 per-metric schema

```sql
telemetry(id, user_id?, metric, dim, value, at)
```

- `metric`：指标名，**服务端白名单**（`server/src/telemetry.js` 的 `METRICS`）
- `dim`：维度（错误码、固件版本、`sim`/`real`…），空串合法
- `value`：数值（计数=1、耗时=ms、字节=bytes）

**为什么不是每指标一列/一表**：新增一个指标就要迁移 + 改前端，而这类需求是发散的
（今天想看 MTU 分布，明天想看 OTA 耗时）。统一事件表的代价是"查询时 group by"，
在当前量级（每天几百到几万行）完全可接受。

**白名单是硬约束**：小程序是可被逆向的客户端，不能让它往库里打任意 metric。
未知指标计入 `rejected` 返回给客户端（不报错整批失败——遥测不该拖累业务）。
新增指标只需在 `METRICS` 加一行，路由与前端都不用改。

### 2. 时间戳容忍秒与毫秒

客户端历史版本可能发秒或毫秒。用 `1e11` 做分界（`1e11` 毫秒 ≈ 1973 年，
`1e11` 秒 ≈ 5138 年）：

```js
const at = n < 1e11 ? Math.floor(n) : Math.floor(n / 1000)
```

**这条是踩坑后加的**：验收时用 Python 灌数据发了秒级时间戳，`ingest` 当成毫秒除以
1000，全部事件落到 1970 年，后台所有图表都是 0，但接口一路 200。教训是——"写入成功"
不等于"数据可用"，必须**查回来断言**（现在有单测钉住）。

### 3. 客户端：入队即返回，合批上报

`miniprogram/utils/telemetry.js`：

- `track()` 只入内存队列，**立即返回**；3s 定时器或满 20 条时发 `POST /telemetry`。
- 队列上限 100，超出丢最旧（宁可少数据，不可涨内存）。
- 发送失败把整批放回队首（保留最新），下次 flush 再试；不无限重试。
- `app.onHide` 调 `flushNow()` 兜底。
- **绝不 await**：BLE 是主流程，遥测是旁路。

### 4. 埋点放在"汇聚点"而不是每个页面

| 埋点 | 位置 | 理由 |
|---|---|---|
| `error` | `errorHandler.logError()` | 全应用错误汇聚点，一处覆盖所有页面 |
| `ble.connect.ok` / `ble.mtu` / `ble.disconnect` | `bleClient.connect/disconnect` | 只有这里真正知道协商结果 |
| `ble.scan.start` / `ble.rssi` | `bleClient.scanDevices` | RSSI 只在首次发现时打（回调每秒几十次会淹库） |
| `config.write` / `config.bytes` / `.fail` | `autoSync._flush` | 配置下发的唯一出口 |
| `ota.*` | `pages/profile` | 升级流程在页面层 |
| `user.login.ok/fail` | `userStore.login` | 登录唯一出口 |
| `app.launch` | `app.onLaunch` | dim 区分 `real`/`sim`，演示数据不混进真实 DAU |

### 5. 后台：零依赖 SVG 图表

`admin/src/components/` 四个组件，**不引 chart.js/echarts**：

- `LineChart`（多序列折线，可选面积）——趋势
- `BarList`（横向柱）——Top N 维度
- `DonutChart`（环形）——占比
- `Histogram`（分桶直方图）——MTU/RSSI 分布

理由：后台只有 6 个页面、图表类型就这 4 类；引入图表库会把产物从 102KB 推到 300KB+
且带来自己的 CSS/主题体系。手写 SVG 的代价是**必须注意刻度与标签**，事实上有三个
真 bug 只能靠截图发现：

1. Y 轴刻度 0/13/25/38/50（应按 1/2/5×10ⁿ 取整）→ 改为 step/max 计算；
2. 最后一个 X 标签被右边界裁切 → 首尾标签锚点改为 `start`/`end`；
3. 直方图 8 个桶的区间标签重叠 → 桶数 > 6 时隔一个显示。

这三个都是**单测抓不到**的，所以验收必须真开浏览器看图（见下）。

### 6. 页面结构（后台 6 页）

| 页 | 内容 |
|---|---|
| 概览 | 4 张指标卡 + 核心指标趋势（可选 5 条线）+ 累计增长 + 每日新增 + 固件版本分布 + 失败构成 + 错误码 Top + MTU 分布 |
| 遥测 | 指标字典（后端白名单驱动的选择器）+ 任选 ≤6 指标的趋势 + 每指标 Top 8 维度 |
| 诊断 | 失败趋势（5 条线）+ 错误码 Top 12 + MTU 直方图（<64 字节标红）+ RSSI 直方图 + OTA 写入流量 |
| 用户 / 设备 / 审计 | 沿用 ADR-0036 |

接口：`GET /admin/overview?days=`、`GET /admin/telemetry?metrics=&days=`、
`GET /admin/errors?days=`、`GET /telemetry/metrics`（字典）、`POST /admin/rollup`。

**响应结构约定**：时序类接口一律 `{ days, seriesDays: [...], series: {metric: [...]} }`
——`series` 只装指标数组，日期轴单独一个字段。第一版把 `series` 写成
`{ days, series }` 嵌套，前端少取一层导致趋势图空白（维度分布却有数据），
现在有单测钉住这个形状。

### 7. 保留与汇总

- 事件表 30 天（写入时低频裁剪，按 db 实例节流 1 小时一次）。
- `daily_stats(day, metric, events, total, users)` 日汇总：`POST /admin/rollup` 手动
  触发或多日补算，给长期趋势用（不扫全表）。当前图表直接扫事件表（30 天窗口够用）。
- 隐私：只收指标名/数值/维度，**不收**配置内容、昵称、头像、页面输入；`user_id`
  由 token 推出，未登录时为空（登录前的启动数据同样有价值）。

## 影响

- 新增 `server/src/telemetry.js`、`server/src/routes/telemetry.js`、
  `miniprogram/utils/telemetry.js`、`admin/src/components/*.vue`、
  `admin/src/views/{TelemetryView,DiagnosticsView}.vue`、`scripts/seed_telemetry.py`。
- `db.js` 增加 `telemetry` / `daily_stats` 两张表（DDL 在 db.js，查询在 telemetry.js）。
- 小程序 5 个文件加埋点（`app.js`/`errorHandler`/`bleClient`/`autoSync`/`userStore`/
  `profile`），**不改协议、不动固件**。
- 测试：后端 45 条（新增遥测/聚合/汇总）、小程序 376 条（新增 telemetry 12 条）。

## 验收方式

1. `scripts/seed_telemetry.py --days 14 --url <本机>` 灌演示数据（带 `seed-` 特征，
   后台可直接辨认，不影响线上真实数据）。
2. 浏览器打开 `/admin/`，逐页截图确认图表**有形状**（不是空白/全 0/标签重叠）。
3. `cd server && npm test`、`cd miniprogram && npm test`、`cd admin && npm run build`。

> 只跑接口断言是不够的：这三类图表 bug（刻度不可读、标签裁切、桶标签重叠）都是
> 接口 200 + 数据正确但**视觉不可用**。因此验收清单里明确要求截图确认。

## 备选

- **引入 chart.js / echarts**：功能强，但产物 +200KB、主题体系与后台 CSS 冲突，
  且这 4 类图手写不到 300 行。否决。
- **每个指标建表/建列**：改指标要迁移，运维成本高于收益。否决。
- **客户端聚合成"会话报告"再上报**（一次会话一条汇总）：省流量，但丢失时间粒度，
  且断连/崩溃时整段丢失。逐事件 + 服务端聚合更稳。
- **日汇总表当唯一数据源**：省查询，但"今天"的数据要等明天才有，后台看不到实时。
  事件表查最近窗口 + 日汇总留长期。
