# design.md — bt-model-light 小程序设计系统（柔光通透 / Soft-Light Airy）

> 本文件是小程序 UI 的**唯一设计基准**：既是主题重构的施工蓝图，也是后续新页面/新组件评审的长期标准。
> 与 `GLOSSARY.md`（领域术语）、`docs/adr/`（决策记录）互补：ADR 管"为什么这么定"，本文档管"标准是什么"。
> 对应 ADR-0027 小程序结构；2026-11 主题重构源自智能家居类 App 的视觉调研（浅灰底 + 纯白卡 + 极轻漫射阴影 + 图标胶囊 + 悬浮 Dock）。

---

## 1. 设计原则

1. **柔光通透**：极浅冷灰底（`#F5F6F8`）+ 纯白卡 + 极轻漫射阴影。层级靠**底色差与阴影**表达，不靠描边。卡片内部不切 1rpx 分割线。
2. **层级三层**：页面底 `bg` → 卡片 `bg-elevated` → 卡内凹陷块 `bg-sunken`。任何"再套一层"的容器都在下一档底色上，不叠边框。
3. **同心圆角**：卡片 32rpx / 卡内块 20rpx / 胶囊 999rpx。嵌套时内层半径 = 外层半径 − 内边距，视觉上"嵌入"而非"摆放"。
4. **图标胶囊**：快捷入口与设置行一律「浅 tint 底圆形 + 线性图标」，激活态为「实心品牌色 + 白图标」。图标用纯 CSS 几何绘制，不用图标字体/图片（避免包体与 Android 缺字）。
5. **克制动效**：过渡一律 `0.25s ease-out`；按压 `scale(0.975) + opacity 0.85`。禁止滚动驱动动画、弹簧物理、`@keyframes`（分段条入场 fade 是唯一例外）。
6. **零硬编码颜色**：颜色一律走语义 token（第 3 节）。页面 wxss 不写 hex；wxml 内联属性（switch/slider 的 `color`）与 `app.json` 配色从 token 同源取值。
7. **渐进增强**：毛玻璃只用于功能层（悬浮 Dock、浮层提示）。`backdrop-filter` 不生效时走的降级纯色是一等公民，不是妥协。

---

## 2. 载体约束

| 项 | 值 | 说明 |
|---|---|---|
| 基础库 | 2.32.0（保持不升级） | CSS 能力足够；升级另立任务 |
| 导航栏 | 微信原生 `navigationStyle: default` | 胶囊按钮无法覆盖，不做沉浸式延伸 |
| tabBar | **自定义 `custom-tab-bar`（悬浮 Dock）** | `app.json` 中 `"custom": true`；两个 Tab 页 onShow 调 `getTabBar().setData({selected})` 同步 |
| 尺寸单位 | rpx（750 设计稿），页面容器 `max-width: 750rpx` 居中 | 宽屏（iPad/折叠屏）不拉伸 |
| 字体 | `-apple-system, "SF Pro", "PingFang SC", "Helvetica Neue", sans-serif` | iOS 中文实际走苹方；SF Pro 只对英文/数字生效 |

### 2.1 悬浮 Dock 的页面配合

带 Dock 的 Tab 页根部必须加 `.page--dock`（`padding-bottom: 220rpx`），否则内容会被 Dock 与 FAB 压住。非 Tab 页（device-list / pin-detail）不加 `.page--dock`，按各自底部留白（pin-detail 自身 `padding-bottom: 220rpx`）。

---

## 3. 色彩 token（浅/深双表）

命名规则：语义名（`--bt-color-*`），禁止 `--bt-color-white/blue` 这类表象名。定义于 `app.wxss` 的 `page` 选择器与 `@media (prefers-color-scheme: dark)`。

### 3.1 品牌与功能色

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bt-color-accent` | `#0088FF` | `#0A84FF` | 主按钮、选中态、开关、FAB、tab 选中 |
| `--bt-color-accent-pressed` | `#0066CC` | `#3395FF` | 主按钮按压态 |
| `--bt-color-danger` | `#FF383C` | `#FF4245` | 删除、破坏性操作、关机按钮 |
| `--bt-color-success` | `#34C759` | `#30D158` | "已连接"状态点、RSSI 柱 |
| `--bt-color-warning` | `#FF8D28` | `#FF9230` | 模拟模式提示 |

### 3.2 柔光阶梯（本轮新增）

品牌色的低透明度阶梯，用于图标胶囊底、tag 底、选中态浅底。**不在页面里手写 `rgba(...)`**。

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bt-color-accent-soft` | `rgba(0,136,255,0.08)` | `rgba(10,132,255,0.16)` | 图标胶囊底、`--tint` 按钮底、保存 badge |
| `--bt-color-accent-soft-2` | `rgba(0,136,255,0.14)` | `rgba(10,132,255,0.24)` | 更实一档：阶段激活底、拖选中段、空槽虚线 |
| `--bt-color-success-soft` | `rgba(52,199,89,0.10)` | `rgba(48,209,88,0.16)` | 「已连接」胶囊底 |
| `--bt-color-danger-soft` | `rgba(255,56,60,0.10)` | `rgba(255,66,69,0.16)` | 解绑/删除/退出登录的弱化成块 |
| `--bt-color-warning-soft` | `rgba(255,141,40,0.12)` | `rgba(255,146,48,0.18)` | 模拟模式条底 |

### 3.3 中性色

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bt-color-label` | `#111827` | `#FFFFFF` | 主文案 |
| `--bt-color-label-secondary` | `#6B7280` | `rgba(235,235,245,0.62)` | 次文案、设置行标题旁说明 |
| `--bt-color-label-tertiary` | `#9CA3AF` | `rgba(235,235,245,0.34)` | 提示、值、时间戳 |
| `--bt-color-label-quaternary` | `#C7CAD1` | `rgba(235,235,245,0.20)` | 箭头、占位符、无图占位数字 |
| `--bt-color-bg` | `#F5F6F8` | `#0B0B0D` | 页面底（极浅冷灰） |
| `--bt-color-bg-elevated` | `#FFFFFF` | `#191A1D` | 卡片底 |
| `--bt-color-bg-sunken` | `#F7F8FA` | `#131416` | 卡内凹陷块（媒体区、图表容器、参数区） |
| `--bt-color-bg-input` | `#F2F3F5` | `#232427` | 输入框、药丸容器、滑块底 |
| `--bt-color-separator` | `rgba(17,24,39,0.06)` | `rgba(255,255,255,0.08)` | 仅用于弹出列表内的必要分隔 |
| `--bt-color-gray-1..6` | `#8E8E93 #AEAEB2 #C7C7CC #D1D1D6 #E5E5EA #F2F2F7` | `#8E8E93 #636366 #48484A #3A3A3C #2C2C2E #1C1C1E` | systemGray 阶梯（禁用态、空柱、抓手） |

### 3.4 阴影与材质

阴影是本轮的核心语汇：卡片"浮"在底色上，靠两层叠加的极轻漫射，不用边框。

| token | 浅色 | 用途 |
|---|---|---|
| `--bt-shadow-card` | `0 2rpx 6rpx rgba(17,24,39,.03), 0 10rpx 28rpx rgba(17,24,39,.05)` | 所有卡片的默认阴影 |
| `--bt-shadow-raised` | `0 4rpx 12rpx rgba(17,24,39,.05), 0 16rpx 40rpx rgba(17,24,39,.08)` | 弹窗、空态主视觉、拖动中的分段 |
| `--bt-shadow-dock` | `0 -2rpx 8rpx rgba(17,24,39,.02), 0 12rpx 40rpx rgba(17,24,39,.1)` | 悬浮 Dock |
| `--bt-shadow-accent` | `0 6rpx 18rpx rgba(0,136,255,.28)` | 主按钮、FAB、开关图标（品牌色投影） |
| `--bt-stage-glow` | `radial-gradient(90% 70% at 50% 34%, rgba(0,136,255,.13), rgba(0,136,255,.05) 38%, transparent 72%)` | 舞台品牌色柔光 |
| `--bt-stage-floor` | `radial-gradient(60% 12% at 50% 78%, rgba(17,24,39,.1), transparent)` | 舞台地面投影 |
| `--bt-glass-bg` | `rgba(255,255,255,0.78)` | 功能层玻璃底（Dock、提示条） |
| `--bt-glass-blur` | `blur(24px)` | backdrop-filter 半径 |
| `--bt-glass-border` | `rgba(255,255,255,0.6)` | 玻璃层高光描边 |
| `--bt-glass-fallback` | `rgba(255,255,255,0.96)` | **降级态**（不支持 backdrop-filter） |

> 深色表的阴影（`--bt-shadow-*`）统一换为 `rgba(0,0,0,…)` 系列；令牌名不变，页面无需分支。

### 3.5 圆角与间距

| token | 值 | 用途 |
|---|---|---|
| `--bt-radius-card` | `32rpx` | 卡片、舞台、分段条容器、弹层 |
| `--bt-radius-inner` | `20rpx` | 卡内块（媒体区、输入框、色块、次级按钮） |
| `--bt-radius-pill` | `999rpx` | 按钮、胶囊、药丸容器、Dock |

间距基准 4rpx 网格：`4 / 8 / 12 / 16 / 20 / 24 / 28 / 32 / 40 / 48`。页面水平边距 32rpx（舞台/时间轴等大块用 24rpx 外扩以求饱满）；卡片内 padding 28rpx；卡片间距 16–24rpx。

### 3.6 非 CSS 通道的同源约定

- `app.json` `window`：`backgroundColor` 与 `navigationBarBackgroundColor` 均为 `#F5F6F8`（= `--bt-color-bg` 浅色值）。
- `app.json` `tabBar`：`color #9CA3AF`（= label-tertiary）、`selectedColor #0088FF`（= accent）。自定义 Dock 实际不读这些值，但保留以便对照。
- wxml 内联 `switch`/`slider` 的 `color` / `activeColor` 仍为字面量 `#0088FF`（wxml 不支持 CSS 变量插值），与 accent 同源，改主色需同步。

---

## 4. 排版阶梯

1rpx = 0.5pt @375pt 屏（750 设计稿）。字号取 Apple Dynamic Type 换算后收紧，构建"角色→字号/字重/行高"映射。

| 角色 class | 字号/行高/字重 | 用途 |
|---|---|---|
| `.bt-type-large-title` | 46rpx / 58rpx / 700，`letter-spacing:-0.5rpx` | 页面大标题（首个卡片内主标题） |
| `.bt-type-title1` | 40rpx / 52rpx / 600 | 区块标题 |
| `.bt-type-title3` | 34rpx / 44rpx / 600 | 卡片主标题 |
| `.bt-type-headline` | 30rpx / 40rpx / 600 | 行主文案 |
| `.bt-type-body` | 30rpx / 40rpx / 400 | 正文 |
| `.bt-type-subhead` | 28rpx / 38rpx / 400 | 次要行、标签 |
| `.bt-type-footnote` | 24rpx / 34rpx / 400 | 说明、提示 |
| `.bt-type-caption` | 22rpx / 32rpx / 400 | 徽标、通道字母 |
| `.bt-type-metric` | **64rpx / 72rpx / 300**，`letter-spacing:-1.5rpx` | 展示数字（亮度值等） |
| `.bt-type-metric-unit` | 26rpx / 32rpx / 400，tertiary 色 | 数字后的小单位（`/255`） |

页面基础：`font-size: 28rpx; line-height: 40rpx`。

**输入框/按钮高度**：统一 `88rpx`（44pt 触控下限），`line-height` 与 `height` 一致；`box-sizing: border-box` 防溢出。更大的可点区（亮度条、picker）用 96rpx。

**字号与颜色分工**：数字用 `metric`（大字 + 轻字重），单位用小号 tertiary 色，是参考图的核心语汇。不要给大数字加粗（会变"表格"而非"仪表"）。

---

## 5. 组件与工具类（`app.wxss`）

| 类 | 规格 | 用途 |
|---|---|---|
| `.bt-card` | 白底 + 32rpx 圆角 + 28rpx padding + 16rpx 32rpx margin + `--bt-shadow-card` | 所有内容卡 |
| `.bt-inset` | `bg-sunken` + 20rpx 圆角 | 卡内凹陷块 |
| `.bt-row` / `.bt-row--between` | flex / space-between | 行布局 |
| `.bt-text--secondary` | label-secondary + 28rpx | 次要文案 |
| `.bt-section-title` | 32/40/12rpx padding，label-secondary，26rpx/600 | 区块标题 |
| `.bt-divider` | 1rpx separator | 仅在必须分隔时使用 |
| `.bt-icon-pill` | 76rpx 圆 + `accent-soft` 底 + accent 图标 | 快捷入口、设置行左图标 |
| `.bt-icon-pill--on` | accent 实心 + 白图标 + `--shadow-accent` | 激活态 |
| `.bt-icon-pill--muted` / `--success` / `--danger` | 对应 tint 底与前景 | 中性 / 成功 / 危险场景 |
| `.bt-ico` + `--list/--cloud/--chip/--doc/--trash/--refresh/--info/--chat/--bulb` | 36rpx（bulb 72rpx）纯 CSS 几何图标，`currentColor` | 所有线性图标 |
| `.bt-chip` / `--on` + `.bt-chip__dot` | 胶囊 22rpx；on 态 success-soft 底 + 绿点 | 连接状态、轻量标签 |
| `.bt-segmented` / `__item` / `__item--on` | 药丸容器内嵌白底选中块 | 分段切换 |
| `.bt-glass` | `--bt-glass-*` + `@supports` 降级 | 功能层玻璃（Dock、提示条） |
| `.bt-btn` | 88rpx 高胶囊 | 按钮基类 |
| `.bt-btn--primary` | accent 底 + 白字 + `--shadow-accent` | 主操作 |
| `.bt-btn--secondary` | 白底 + 轻阴影 | 次操作 |
| `.bt-btn--tint` | accent-soft 底 + accent 字 | 弹窗内次要动作 |
| `.bt-btn--danger` | danger 底 + 白字 | 破坏性操作 |
| `.bt-pressable` | `:active` scale(.975) + opacity .85 | 所有可点元素 |
| `.page` / `.page--dock` | 750rpx 钳制 / 底部 220rpx 留白 | 页面容器 |

**图标规则**：只增 `--bt-ico--*` 变体，不引入图片或图标字体。形状用伪元素 + `border` / `background: currentColor` 拼，尺寸与 `.bt-icon-pill` 同心（36rpx 画框）。新增时检查 `currentColor` 继承，确保换 tint 时自动变色。

---

## 6. 页面范式

### 6.1 舞台范式：`home`（设备 Tab）

1. **舞台卡**（`.stage`）：40rpx 圆角白卡，内部 `--bt-stage-glow` 品牌色柔光 + 顶部渐变收向页面底色。
   - 左上：设备名（46rpx/700）+「切换 ›」小字；右上：连接状态 `.bt-chip` + 固件版本小字。
   - 中部：480rpx 高图片区，`aspectFit` 居中悬浮；底部 `.stage__floor` 椭圆投影让设备"站"在台上。无图时显示 CSS 灯泡 + 「长按此处添加设备图」。
   - 长按舞台 → 编辑设备名/图片弹窗。
2. **控制卡**（`.control-card`）：左侧「亮度」+ `bt-type-metric` 大数字 + `/255` 小单位；右侧圆形电源按钮（关=accent / 开=danger）+ 文案。下方亮度滑块，历史 sparkline 绝对定位叠在滑块上方（canvas 配色走 accent）。
3. **引脚区**：`.bt-section-title` + 2 列卡片网格。卡内方形媒体区（`bg-sunken` 底、22rpx 圆角）+ 卡内底部名称/灯组数（不再压黑色渐变条）。
   - 未配置引脚：透明底 + 虚线边框 + 大数字占位。
   - 设备关机：整卡 `opacity .45 + grayscale(1)` 且不可点（ADR-0032）。

### 6.2 工具页范式：`device-list` / `pin-detail`

- 单列白卡列表，无舞台柔光。
- **device-list**：方形媒体区 + 卡内信息行（名称 / 设备 ID / 解绑弱化红胶囊）。浮层只留「使用中」accent 胶囊与在线/离线白底半透明胶囊。
- **pin-detail**：顶部信息卡（图 + 名称 + 引脚号/开关 + 药丸灯组选择与「配置」）→ 阶段分段条（白卡容器，段间 1rpx 极淡分隔，激活段 accent-soft）→ 时间轴甘特（白卡 + 内凹轨道）→ 阶段详情气泡卡（三角箭头指向当前段）→ 图层双槽卡（`bg-sunken` 底 + 20rpx 圆角，空槽虚线 accent-soft）。
- 弹层统一：40rpx 圆角、`--bt-shadow-raised`、遮罩 `rgba(17,24,39,.4)`、右上圆形灰底关闭钮。

### 6.3 设置页范式：`profile`（我的 Tab）

- 首屏账号卡：圆形头像（120rpx）+ 昵称（40rpx/700）+ 提示；未登录显示主按钮，已登录显示 danger-soft 底「退出登录」条。
- 每个区块 = `.bt-section-title` + 一张 `.bt-card.settings-card`（`padding: 8rpx 20rpx`）。
- 设置行 = **图标胶囊（76rpx）+ 文案两行（标题 30rpx/600 + 提示 22rpx）+ 值/箭头**，行高 ≥112rpx。**行与行之间不用分割线**，靠 16rpx 间距与图标列形成节奏。
- 弹层用底部 sheet：40rpx 顶圆角 + 顶部抓手（72×8rpx 灰胶囊）+ 圆形关闭钮。

### 6.4 图表规范

**不引入第三方图表库**（包体 + 风格统一），图表一律"纯函数算数据 + 原生渲染"两步：

- 数据层：`utils/chartHelpers.js`（无 wx/BLE 依赖，Jest 覆盖）。含 `layerGradientCss`、`buildTimeline`、`aggregateErrorLog`、`pushBrightnessHistory`/`loadBrightnessHistory`、`createRssiSampler`。
- 灯效可视化数据层：`utils/effectPreview.js`（纯函数）——`effectPixel`/`renderStrip` 逐灯珠渲染（规则镜像固件 `effects.cpp`，时间单位 10ms tick），`stripPoints`/`projectPoints` 做长条排布与透视投影。
- 渲染分三档：
  - **纯 CSS**（优先）：柱状图、渐变色带、进度区间。零成本、可深色、无 DPR 问题。
  - **canvas 2d**：`<canvas type="2d">` + `createSelectorQuery().fields({node:true,size:true})`，必须按 `pixelRatio` 缩放（否则真机模糊）。
  - **不用 canvas**：简单分段用 view + 百分比定位。
- 配色：图表数据色取灯效主题色 `EFFECT_COLORS`；网格/轴标签用 `label-*` / `separator`；主数据色用 `accent`。canvas 内无法读 CSS 变量，须写与 token 同源的 rgba 字面量（**这是唯一允许写 hex/rgba 的地方，且必须注释同源**）。
- 尺寸：迷你图 48–120rpx，3D 灯效预览 220rpx（宽扁长条）；轴标签 20–22rpx tertiary；空数据不画图（不留空壳容器）。

| 页面 | 图表 | 类型 | 数据源 |
|---|---|---|---|
| pin-detail | 阶段时间轴（泳道甘特，含图层子条 + 过渡斜纹） | CSS 定位 | `buildTimeline(steps)` |
| pin-detail | 3D 灯效预览（图层弹窗内，可拖动旋转） | canvas 2d | `renderStageStrip` + `stripPoints` + `projectPoints` |
| pin-detail | 图层卡渐变色带 | CSS gradient | `layerGradientCss(effect, fields)` |
| home | 亮度历史 sparkline（叠在亮度条上方） | canvas 2d | `brightness_hist_<deviceId>` Storage |
| profile | 近 7 天错误分布柱状图（日志弹层内） | CSS 柱 | `aggregateErrorLog(error_log, 7)` |
| device-list | 扫描结果 RSSI 柱（行内细柱） | CSS 柱 | `createRssiSampler` 会话内采样 |

---

## 7. 动效规范

| 场景 | 参数 |
|---|---|
| 通用过渡（颜色/背景/圆角/位移） | `transition: 0.25s ease-out`（写具体属性，不裸 `all`） |
| 按压反馈 | `scale(0.975)` + `opacity 0.85`，0.25s |
| 弹层出现 | 无入场动画（瞬时显示）；只对内部数值做过渡（进度条 width 0.2s） |
| 分段条新增段 | 唯一 `@keyframes`：`stage-seg-in` fade 0.22s |
| 触感 | 仅关键操作（保存成功、连接成功、删除设备）：`wx.vibrateShort({ type: 'light' })` |
| 禁止 | 滚动驱动动画、视差、弹簧物理、>0.4s 过渡 |

---

## 8. 真机人工验收项

自动化（Jest 376 项）只覆盖逻辑层；以下必须真机：

1. **悬浮 Dock**：自定义 tabBar 在两个 Tab 间切换时选中态同步、不闪；FAB 点击进设备列表；`env(safe-area-inset-bottom)` 在全面屏/刘海屏正确留白。
2. **Dock 遮挡**：home / profile 底部内容可完整滚出，不被 Dock 与 FAB 压住（`.page--dock` 生效）。
3. **毛玻璃降级**：iOS（backdrop-filter 生效）与 Android（大概率降级）各看一次 Dock 与模拟模式条，确认两种底色都可读。
4. **舞台柔光**：iOS 与 Android 的 radial-gradient 渲染是否一致；无设备图时灯泡占位与「长按此处」提示是否清晰。
5. **深色模式**：系统切深色，逐页确认卡片浮起（阴影为黑系）、图标胶囊 tint 可见、canvas 图表可读。
6. **CSS 图标**：8 个设置行图标在目标机型上形状正确（无缺笔画）、随 tint 变色。
7. **触控热区**：灯珠方格 88rpx 热区、开关缩放 0.62 后是否好按。
8. **原生导航栏**：`#F5F6F8` 导航底色与页面底的衔接是否无缝。
9. **宽屏**：iPad / 折叠屏展开态，750rpx 钳制居中正常。

---

## 9. 实施记录与后续事项

**2026-11 主题重构已交付**：
- token 全量重写（`app.wxss`）：新增柔光阶梯、阴影层、圆角/舞台渐变 token；底色从 iOS grouped `#F2F2F7` 换成 `#F5F6F8`，卡片由"无阴影"改为"极轻漫射阴影"。
- 自定义悬浮 Dock（`custom-tab-bar/`）：毛玻璃胶囊 + 中央 FAB；`app.json` 转 `"custom": true`；home/profile onShow 同步 `selected`。
- 四页面全量视觉重构：home 改舞台范式、device-list 信息移到图下、profile 设置行改图标胶囊三段式、pin-detail 控件全面药丸化。
- CSS 几何图标系统（`--bt-ico--*`），替换全部 Unicode/emoji 图标。
- 回归：Jest 376 项全绿；`generate.py --check` 与 `test_repeatable.py` 通过。

**与旧规格的差异（已按实现更新）**：
- 旧 §7.2「顶部 hero 毛玻璃信息条 + 页面级光晕」不再适用，替换为舞台范式（舞台卡内柔光 + 地面投影）。
- 旧 §5.3「卡片无阴影」**已废止**，改为极轻漫射阴影（第 3.4 节）。
- 旧「原生 tabBar」**已废止**，改为自定义悬浮 Dock。

**后续事项（不在本轮）**：
1. **深色模式逐页精调** + 主题切换入口（profile 页开关，`wx.setStorage` 持久化）。
2. **wxml 内联色 token 化**：`switch`/`slider` 的 `color` 仍为 `#0088FF` 字面量（home ×1、profile ×1、pin-detail ×3）；待小程序支持 CSS 变量注入组件属性，或改用自定义控件。
3. **组件化扩展**：把 `.bt-card` + `.bt-icon-pill` + `.bt-ico` 抽成 `bt-card` / `bt-row` / `bt-icon` 组件，消除四页间的样式复制。
4. **基础库升级评估**：升级以获得新 CSS 能力（当前 2.32.0）。
5. **Dock 动效**：若真机性能允许，评估选中态图标位移动画（当前只做颜色过渡）。
