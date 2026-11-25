# ADR-0031: 整体开关扇出到引脚 + SET_BRIGHTNESS 整机亮度

- 状态: **决策 1 已被 ADR-0032 取代**（整体开关改为设备级 `SET_POWER`，不再扇出改写引脚状态）；决策 2–4 仍有效
- 日期: 2026-11-26
- 标签: 固件, 小程序, 协议
- 相关: ADR-0007（命令集）、ADR-0009（版本协商）、ADR-0027（首页设备卡片含"整体开关/整体亮度"）、ADR-0028（灯带开关 pin.power，整体开关复用其机制）、ADR-0030（配置落盘延后）、ADR-0032（取代本 ADR 决策 1）

## 背景

SPEC 故事 6/7 要求"整体开关一键控制所有引脚""整体亮度统一调光"，ADR-0027 也把两者画进了首页设备卡片，但实现一直是**本地占位**：`home.js` 的两个回调只改页面 data，既不下发也不落盘（`docs/adr/0028` 第 39 行明确把整体开关排除在范围外，"待后续决策"）。实测症状：真机点"开机/关机"、拖亮度条，灯珠毫无反应。

设备侧也确实没有接收点：`protocol/commands.csv` 无对应命令，配置 blob 与固件配置结构体里没有任何设备级亮度字段。所以修它必须补上设备侧语义——下面两个子决策。

## 决策

**1. 整体开关 = 扇出到 8 个引脚（不新增协议能力）**  ← *已被 ADR-0032 取代：真机试用后确认"设备关机不该覆盖引脚状态"，改为设备级 `SET_POWER`。以下保留为当时的决策记录。*

点"关机" = 把 Storage 里每个已配置引脚的 `power` 置 false，落盘后一次 `WRITE_CONFIG` + `APPLY`（复用 ADR-0028 的编码路径：该引脚 `group_count=0` → 固件清空灯带）；点"开机" = 全体置 true，各自灯组恢复。

显示态是**推导**的，不存主开关标志：`power = 有已配置引脚 && 所有已配置引脚 power !== false`。部分引脚被单独关掉时显示"开机"（未全亮），点一下即全开。

*代价（明确接受）*：整体关机再开机会把用户手动关掉的引脚一并打开，不记忆"关机前状态"。

**2. 整体亮度 = 新增命令 SET_BRIGHTNESS（0x0A），固件在输出级统一缩放**

- payload 1 字节（0~255，255 = 不缩放），负载与越界语义见 `protocol/frame-spec.md`；
- 固件在 `ledSetPixel` 写像素前统一缩放（`firmware/src/master_brightness.cpp`）：这是配置播放、预览、IDLE 出厂默认彩虹共用的**唯一输出出口**，一处改动全覆盖；渲染函数签名不变（既有渲染测试零改动），且不改动任何灯组/图层参数（与图层参数里的 `brightness` 是相乘关系）；
- 任意状态可发（含 IDLE/CONNECTED）；`len != 1` 回 `0x04 参数非法`；不触发状态机迁移；
- **亮度是 RAM 态、不落 spiffs**：亮度条是连续拖动，落盘会带来 flash 写放大（正是 ADR-0030 刚解决的问题）。小程序把亮度存在设备记录上（`bt_devices[].brightness`，缺省 255，与固件默认一致），断连/重连后由 autoSync 补发（与配置补发同一出口、同一 500ms 防抖窗口，避免与连接时的 `GET_VERSION` 分片交错）；
- 出厂复位（`RESET_DEFAULT` 与 BOOT 5s 长按）把亮度归 255——它是出厂态的一部分。

**3. 不新增下发出口**

`SET_BRIGHTNESS` 与 `WRITE_CONFIG`/`APPLY` 都走 `autoSync`（新增 `scheduleBrightness`），共用 in-flight 串行：同一时刻只有一条命令在写空口，避免两条命令的分片交错写坏字节流。拖动中按"最新值待发"合并，不额外节流也自然限速。

**4. 协议 minor 升到 1.1**（`versions.csv`：protocol 1.1 / firmware 0.2 / app 0.2）

新增命令属于能力变更：未重烧的旧固件与新小程序按 ADR-0009 判为不兼容并提示升级，如实反映"旧固件没有这个命令"。

## 理由

- 开关复用 ADR-0028 的既有机制：零协议改动、落盘天然（每引脚 `power` 在 Storage）、与引脚卡片开关同一字段两边同步，且贴合 SPEC"一键控制所有引脚"的字面语义。
- 亮度走独立命令而不是塞进配置 blob：拖动是连续交互，整份 ~700B 配置重发 + 每次触发配置落盘（flash 写放大）不可接受；1 字节负载让"拖动 → 灯变"的延迟只剩空口时间。
- 缩放放输出级而不是渲染层：一个 choke point 覆盖所有渲染路径，渲染函数签名与既有测试都不用动。
- 亮度不落设备闪存：设备重启后回满亮度、由 App 重连补发，窗口极短；换来零 flash 写放大。App 是亮度的真相源，与"配置存 Storage"的定位一致。

## 影响

- `protocol/`：`commands.csv` +SET_BRIGHTNESS 0x0A、`versions.csv` 升版、`frame-spec.md` 新增负载小节；跑 codegen 重新生成 `firmware/include/protocol_gen.h`、`miniprogram/utils/protocol_gen.js`。
- 固件：新增 `include/master_brightness.h` + `src/master_brightness.cpp`（纯 C++，native 可测，已加入 `platformio.ini` 的 native 白名单与 `test_master_brightness`）；`led_driver.cpp` / `led_driver_stub.cpp` 在 `ledSetPixel` 调用缩放；`ble_service.cpp` 加 `handle_set_brightness` 与复位归 255；`main.cpp` 长按出厂复位归 255。*（ADR-0032 把该模块扩为 `master_output.{h,cpp}` 并改名测试目录 `test_master_output`。）*
- 小程序：`utils/autoSync.js` 新增 `scheduleBrightness`（与配置共用串行/重试/补发）；`utils/deviceStore.js` 新增 `BRIGHTNESS_DEFAULT`、`getDeviceBrightness`、`saveDeviceBrightness`；`pages/home/home.js` 整体开关扇出、亮度拖动实时下发 + 松手落盘。
- 文档：`GLOSSARY.md` 增"整体开关/整体亮度"；`docs/smoke-test.md` 增真机人工项；`docs/adr/0028` 第 39 行补指向本 ADR。

## 已知边界

- `PAUSED`（STOP 后保持当前亮灯）与 `CONFIGURED`（等 APPLY）不重渲染：这两个窗口内改亮度不即时生效，要等下一次渲染。小程序目前不发 STOP，实际不可达；将来若加"暂停"入口，需要在亮度变更时补一次重渲染。
- 设备重启/断电后亮度回 255（RAM 态），由 App 重连补发。
- 整体开关不记忆关机前的逐引脚状态（见决策 1）。

## 备选

- **整体开关做设备级总开关（新命令/字段，不覆盖引脚开关）**：语义更干净（关机→开机恢复各引脚各自状态），但要新增命令或 blob 字段 + 固件设备级状态 + 落盘 + 回读，并与 ADR-0028 的引脚开关形成两套"关灯"概念，被否。
- **亮度进配置 blob 设备级字段（blob version 1→2）**：白拿 spiffs 落盘/回读/补发/去重，但每次拖动重发整份配置并触发配置落盘，手感钝 + flash 写放大，被否。
- **亮度只在小程序侧扇出改写各图层 brightness 参数**：零固件改动，但把"整体亮度"烧进用户配置（需备份还原），不可逆且语义错位，被否。
- **亮度落 spiffs（单独 1 字节文件）**：断电记忆更好，但引入第二条持久化路径与写放大；等真出现"断电要记住亮度"的需求再加。
