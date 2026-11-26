# design.md — bt-model-light 小程序设计系统（iOS Liquid Glass 风格）

> 本文件是小程序 UI 的**唯一设计基准**：既是本轮主题重构的施工蓝图，也是后续新页面/新组件评审的长期标准。
> 与 `GLOSSARY.md`（领域术语）、`docs/adr/`（决策记录）互补：ADR 管"为什么这么定"，本文档管"标准是什么"。
> 对应 ADR-0027 小程序结构；重构任务源自 iOS 26/27 设计语言调研（2026-11）。

---

## 1. 设计原则

1. **功能层 / 内容层分离**（Liquid Glass 核心规则）：毛玻璃只属于功能层（导航区、底部操作栏、悬浮主按钮、浮层提示），内容层（卡片、列表、表单）保持纯色。玻璃不是装饰，是层级的表达。
2. **同心圆角**：控件圆角与容器圆角曲率连续（nested 时内层半径 = 外层半径 − 间距），视觉上"嵌入"而非"摆放"。
3. **克制动效**：短、有目的、可预期。过渡 0.25s，入场 fade-in 0.3s，不做滚动驱动动画与弹簧物理。
4. **渐进增强**：毛玻璃是增强项不是依赖项。半透明纯色为基底，支持 `backdrop-filter` 时叠加模糊；降级后的视觉规格（第 5 节）同样是一等公民。
5. **零硬编码颜色**：一切颜色走语义 token（第 3 节）。页面 wxss、wxml 内联属性（switch/slider color）、app.json 导航/tabBar 配色都从 token 取值或与之保持同源。

---

## 2. 载体约束与基础库

| 项 | 值 | 说明 |
|---|---|---|
| 基础库 | 2.32.0（保持不升级） | backdrop-filter CSS 层支持不依赖新基础库；升级另立任务 |
| 导航栏 | 微信原生（`navigationStyle: default`） | 胶囊按钮无法覆盖，自定义导航永远"半截"，不做沉浸式延伸；玻璃质感集中在页面内顶部区域 |
| tabBar | 微信原生 tabBar | 配色见第 3 节 token 映射 |
| 尺寸单位 | rpx（750 设计稿），页面容器 `max-width: 750rpx` 居中 | 宽屏（iPad/折叠屏）不拉伸 |
| iOS 微信字体 | 苹方 PingFang SC（iOS 渲染中文无 SF 字形，SF Pro 仅对英文/数字生效） | 字体栈：`font-family: -apple-system, "SF Pro", "PingFang SC", "Helvetica Neue", sans-serif` |

---

## 3. 色彩 token（浅/深双表，成对定义）

命名规则：语义名（`--bt-color-*`），禁止 `--bt-color-white/blue` 这类表象名。定义于 `app.wxss` 的 `page` 选择器（浅色）与 `@media (prefers-color-scheme: dark)`（深色）。

### 3.1 品牌与功能色

| token | 浅色 | 深色 | 来源 / 用途 |
|---|---|---|---|
| `--bt-color-accent` | `#0088FF` | `#0091FF` | Apple systemBlue（官方色卡）；主按钮、选中态、开关、tab 选中 |
| `--bt-color-accent-pressed` | `#0066CC` | `#3395FF` | 按压态加深/提亮 |
| `--bt-color-danger` | `#FF383C` | `#FF4245` | Apple systemRed（官方色卡）；删除、破坏性操作 |
| `--bt-color-success` | `#34C759` | `#30D158` | Apple systemGreen（官方色卡）；"已连接"状态 |
| `--bt-color-warning` | `#FF8D28` | `#FF9230` | Apple systemOrange（官方色卡）；模拟模式提示 |

> 微信绿 `#07c160` **退役**。历史上散落 8+ 处的 `#07c160` 全部替换为 `--bt-color-accent`。

### 3.2 中性色（文字 / 背景 / 分隔符）

| token | 浅色 | 深色 | 来源 |
|---|---|---|---|
| `--bt-color-label` | `#000000` | `#FFFFFF` | UIKit label（经典值） |
| `--bt-color-label-secondary` | `rgba(60,60,67,0.6)` | `rgba(235,235,245,0.6)` | UIKit secondaryLabel |
| `--bt-color-label-tertiary` | `rgba(60,60,67,0.3)` | `rgba(235,235,245,0.3)` | UIKit tertiaryLabel |
| `--bt-color-label-quaternary` | `rgba(60,60,67,0.18)` | `rgba(235,235,245,0.16)` | UIKit quaternaryLabel |
| `--bt-color-bg` | `#F2F2F7` | `#000000` | systemGroupedBackground 系 |
| `--bt-color-bg-elevated` | `#FFFFFF` | `#1C1C1E` | secondarySystemBackground（卡片/输入底） |
| `--bt-color-bg-input` | `#F2F2F7` | `#1C1C1E` | 输入框/点选格底（浅色同 grouped 底） |
| `--bt-color-separator` | `rgba(60,60,67,0.29)` | `rgba(84,84,88,0.65)` | UIKit separator |
| `--bt-color-gray-1..6` | `#8E8E93 #AEAEB2 #C7C7CC #D1D1D6 #E5E5EA #F2F2F7` | `#8E8E93 #636366 #48484A #3A3A3C #2C2C2E #1C1C1E` | systemGray 阶梯（UIKit 经典值；Apple 未公布 RGB，中可信度） |

> 可信度注记：systemBlue/Green/Red/Orange 为 Apple 官方色卡 RGB（高可信）；label/background/separator/gray 阶梯为 UIKit 文档长期公开值（Apple 颜色页只给 API 名，中等可信）。token 可覆盖，换值只改 `app.wxss` 一处。

### 3.3 材质 token（毛玻璃）

| token | 浅色 | 深色 | 说明 |
|---|---|---|---|
| `--bt-glass-bg` | `rgba(255,255,255,0.72)` | `rgba(30,30,30,0.72)` | 功能层玻璃底色（半透明白/深灰） |
| `--bt-glass-blur` | `blur(20px)` | `blur(20px)` | backdrop-filter 模糊半径 |
| `--bt-glass-border` | `rgba(255,255,255,0.45)` | `rgba(255,255,255,0.12)` | 玻璃层顶部高光描边 |
| `--bt-glass-fallback` | `rgba(255,255,255,0.92)` | `rgba(30,30,30,0.92)` | **降级态**（不支持 backdrop-filter 时）的高不透明度纯色 |
| `--bt-hero-glow` | `radial-gradient(120rpx at 20% 0%, rgba(0,136,255,0.10), transparent 60%)` | `radial-gradient(120rpx at 20% 0%, rgba(0,145,255,0.16), transparent 60%)` | 页面顶部柔和光晕（模拟折射），克制使用 |

### 3.4 app.json / wxml 映射（非 CSS 通道的同源约定）

- 导航栏（首页浅色）：背景 `#F2F2F7`、文字 black（`app.json` window 默认 + 首页 `wx.setNavigationBarColor` 动态设置）。
- tabBar：color `#8E8E93`（gray-1）、selectedColor `#0088FF`（accent）、backgroundColor `#F9F9F9`（半透明白近似，tabBar 不支持 rgba 时用 `#F9F9F9`）、borderStyle `white`。
- wxml 内联属性（switch/slider 的 `color`/`activeColor`）暂保持字面量 `#0088FF`（wxml 不支持 CSS 变量插值）；与 token 同源，改主色时需同步此 3 处，已登记在 §9 后续事项。

---

## 4. 排版阶梯（角色 → rpx）

1rpx = 0.5pt @375pt 屏（750 设计稿）。字号取 Apple Dynamic Type（Large 档）换算后收紧适配手机屏幕（真机反馈过大），构建"角色→字号/字重/行高"映射而非照抄散落值。

| 角色 class | 字号/行高/字重 | ≈pt | 用途 |
|---|---|---|---|
| `.bt-type-large-title` | 44rpx / 56rpx / 700 | 22pt Bold | 页面大标题（home 设备名） |
| `.bt-type-title1` | 40rpx / 52rpx / 600 | 20pt | 页面标题（mine 区块首行） |
| `.bt-type-title3` | 34rpx / 44rpx / 600 | 17pt Semibold | 卡片主标题（设备名、引脚名） |
| `.bt-type-headline` | 30rpx / 40rpx / 600 | 15pt Semibold | 行主文案（设置行、按钮文字） |
| `.bt-type-body` | 28rpx / 38rpx / 400 | 14pt | 正文/输入值 |
| `.bt-type-subhead` | 26rpx / 36rpx / 400 | 13pt | 次要行、标签 |
| `.bt-type-footnote` | 24rpx / 34rpx / 400 | 12pt | 说明、提示 |
| `.bt-type-caption` | 22rpx / 32rpx / 400 | 11pt | 徽标、通道字母 |

页面基础：`font-size: 28rpx; line-height: 1.5`（14pt body）。旧散落值（20–36rpx 共 9 档无规律）全部退役，映射进上表。

**输入框/按钮高度**：统一 `64rpx`（32pt），`line-height` 与 `height` 一致确保垂直居中，`box-sizing: border-box` 防溢出。

---

## 5. 间距 / 圆角 / 阴影 / 材质规格

### 5.1 间距（4rpx 基准网格）

`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64` rpx。常用语义：页面水平边距 32rpx；卡片内 padding 24rpx；卡片间距 16rpx；区块标题上下 24/8rpx。

### 5.2 圆角（同心连续曲率）

| 元素 | 圆角 | 说明 |
|---|---|---|
| 页面容器 | 0 | 通栏 |
| 卡片/分组 | 24rpx | iOS 分组卡片大曲率 |
| 输入框/点选格/内层块 | 12rpx | 同心：24 − 卡片 padding 内缩 |
| 按钮（主/次） | 999rpx（胶囊） | iOS 主按钮胶囊化 |
| tab 胶囊 | 999rpx | 已胶囊，保持 |
| 徽标 | 8rpx | 小圆角 |
| 占位图 | 16rpx | |

### 5.3 阴影与玻璃

- 卡片：**无阴影**（iOS grouped 风格靠背景分层，不用投影）。
- 功能层玻璃（现用于 sim-banner 顶部提示；页面级 hero 信息条/保存栏已随布局改版移除，见 §9）：`background: rgba(255,255,255,0.4); backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px); border-top: 1rpx solid rgba(255,255,255,0.6); box-shadow: inset 0 1rpx 0 rgba(255,255,255,0.5);`
- **降级规格**（`@supports not (backdrop-filter: blur(1px))` 或运行时检测）：`background: rgba(255,255,255,0.92); box-shadow: none;`，去 blur，其余不变。降级态是验收项。
- **真机注意**：微信小程序 `backdrop-filter` 在 iOS/Android 真机支持不稳定，模拟器与真机渲染差异大；降级态保证可读性，模糊效果视真机环境而定。

### 5.4 触控与按压

- 最小点击区 88rpx（≈44pt）。点选格现状 60rpx < 88rpx：**视觉上保持 60rpx 方格，点击热区经 padding 扩展至 88rpx**（`.led-cell` 外 margin 补偿）。
- 按压态：`.bt-pressable` 工具类 `:active { transform: scale(0.97); opacity: 0.8; }`，过渡 0.25s。

---

## 6. 动效规范

| 场景 | 参数 |
|---|---|
| 通用过渡（颜色/背景/圆角） | `transition: 0.25s ease-out`（写具体属性，不裸 all） |
| 按压反馈 | scale(0.97) + opacity 0.8，0.25s |
| 触感 | 仅关键操作（保存成功、连接成功、删除设备）：`wx.vibrateShort({ type: 'light' })`，挂页面事件处 |
| 禁止 | 滚动驱动动画、视差、弹簧物理、>0.4s 的过渡、`@keyframes` 动画（小程序兼容性差，已移除） |

---

## 7. 组件规范

### 7.1 已完成：`components/sim-banner`（模拟模式浮层提示）

- 结构：`sim-banner`（组件）/ `sim-banner.wxss|js|json`。
- 视觉：顶部通栏浮层，warning 色系（浅 `rgba(255,141,40,0.12)` 底 + `#B25000` 字；深 `rgba(255,146,72,0.18)` 底 + `#FFB340` 字），footnote 字号，居中，胶囊圆角内缩 32rpx 边距，玻璃底 + 降级。
- 交互：无（纯提示）；点击无绑定。
- 引用：`home / device-list / pin-detail` 三页 `<sim-banner wx:if="{{simMode}}" />`。
- 它同时是组件化路径的示范：后续按同模式抽取卡片、设置行、按钮组件（§9）。

### 7.2 页面范式 A：展示页（home / mine）

- 顶部 hero 区：大标题（title1/large-title）+ 页面级毛玻璃信息条（功能层玻璃）。
- 内容：分组卡片（24rpx 圆角、无阴影、grouped 底上叠 elevated 卡）。
- 背景：页面顶部 `--bt-hero-glow` 光晕，向下渐隐。

### 7.3 页面范式 B：工具页（device-list / pin-detail）

- iOS 设置/表单风：分组列表、紧凑行高（行高 ≥88rpx）、无玻璃装饰、无光晕。
- pin-detail 无底部操作栏（"保存"按钮已改为修改即推送）：顶部是纯文字同步状态条（同步中/已同步/仅本机/同步失败，`--bt-color-label-secondary`，非玻璃层）。
- 主按钮胶囊化（`.bt-btn--primary`：accent 底、白字、headline 字号、88rpx 高）——现用于 device-list「新增设备」与 home 编辑弹窗的「保存」。

### 7.4 通用类（app.wxss）

`.bt-card`（分组卡：elevated 底、24rpx 圆角、无阴影、16rpx 间距）、`.bt-row` / `.bt-row--between`、`.bt-text--secondary`（subhead + secondary label）、`.bt-type-*`（§4）、`.bt-pressable`（§5.4）、`.bt-divider`（separator 1rpx）、`.bt-section-title`（分组标题：footnote + tertiary label）、`.bt-btn`（按钮基类）/`--primary`（胶囊 accent）/`--danger`。

### 7.5 图表规范（2026-11 新增）

**原则：不引入第三方图表库**（包体 + 风格统一），图表一律走"纯函数算数据 + 原生渲染"两步：

- 数据层：`utils/chartHelpers.js`，无 wx/BLE 依赖，Jest 单测覆盖。含 `layerGradientCss`（渐变色带 CSS）、`buildTimeline`（阶段甘特）、`aggregateErrorLog`（错误按天聚合）、`pushBrightnessHistory`/`loadBrightnessHistory`（亮度历史）、`createRssiSampler`（RSSI 环形采样）。
- 灯效可视化数据层：`utils/effectPreview.js`，同样纯函数、无 wx 依赖。`effectPixel`/`renderStrip` 逐灯珠渲染（规则逐条镜像固件 `effects.cpp`，时间单位为 10ms tick），`stripPoints`/`projectPoints` 提供长条灯条的排布与透视投影。与固件的已知差异只在时间循环（流星亮头扫出灯带后预览回卷，固件则永久维持），已在源码注释标注。
- 渲染层按复杂度分三档：
  - **纯 CSS**（优先）：柱状图、渐变色带、进度区间——零成本、可深色模式、无 DPR 问题。用于 mine 错误分布、pin-detail 图层色带、device-list RSSI 柱。
  - **canvas 2d**（折线/灯效）：`<canvas type="2d">` + `createSelectorQuery().fields({node:true,size:true})`，必须按 `pixelRatio` 缩放（否则真机模糊）。用于 pin-detail 3D 灯效预览、home 亮度 sparkline。
  - **不用 canvas**：简单分段用 view + 百分比宽度定位即可（时间轴图主体）。
- 配色：图表色取灯效主题色 `EFFECT_COLORS`（`chartHelpers`），中性网格/分隔用 `--bt-color-label-*` / `--bt-color-separator`，主数据色用 `--bt-color-accent`，与 §3 token 同源。
- 尺寸：迷你图高度 48–120rpx，3D 灯效预览 200rpx（横向长条，宽扁比例）；轴标签 20–22rpx + tertiary label；图例 22rpx。空数据不画图（不留空壳容器）。

**各页图表落点**：

| 页面 | 图表 | 类型 | 数据源 |
|---|---|---|---|
| pin-detail | 阶段时间轴（泳道甘特，含图层子条 + 过渡斜纹） | CSS 定位 | `buildTimeline(steps)` |
| pin-detail | 3D 灯效预览（图层弹窗内，可拖动旋转） | canvas 2d 逐帧 | `effectPreview.renderStageStrip` + `stripPoints` + `projectPoints` |
| pin-detail | 图层卡渐变色带 | CSS gradient | `layerGradientCss(effect, fields)` |
| home | 亮度历史 sparkline（贴亮度条上方） | canvas 2d | `brightness_hist_<deviceId>` Storage |
| mine | 最近 7 天错误分布柱状图（日志弹层内） | CSS 柱 | `aggregateErrorLog(error_log, 7)` |
| device-list | 扫描结果 RSSI 曲线（行内细柱） | CSS 柱 | `createRssiSampler` 会话内采样 |

> 与 §6 动效约束一致：柱高/高度变化只做 `0.25s ease-out` 过渡，不做入场动画；图表不参与滚动驱动效果。


---

## 8. 真机人工验收项（iOS + Android）

自动化（Jest）只覆盖逻辑层；以下必须真机：

1. **毛玻璃观感**：iOS 微信（backdrop-filter 生效）与 Android 微信（大概率走降级）各看一眼 sim-banner 顶部提示，确认模糊与降级纯色都可读、无穿透文字。
2. **降级触发**：Android 端确认 `@supports` 降级路径生效（半透明纯色高不透明度）。
3. **深色模式**：系统切深色，确认双 token 生效（本轮只验收"不崩、可读"，逐页精调留后续）。
4. **触控热区**：灯珠点选格 88rpx 热区在真机上点按是否好按（尤其低端大屏）。
5. **触感**：保存成功 `wx.vibrateShort` 在 iOS 静默模式下的行为是否符合预期。
6. **原生导航栏配色**：首页动态设置导航色后，与页面顶部光晕衔接是否自然；tabBar 选中蓝色在新主题下的辨识度。
7. **宽屏**：iPad / 折叠屏展开态，750rpx 钳制居中是否正常。

---

## 9. 实施记录与后续事项

**本轮已交付（2026-11）**：token 双表（app.wxss）、app.json 导航/tabBar 配色、sim-banner 组件化、4 页面全量重构（展示页/工具页两范式）、Jest 回归通过。

**与实现的偏差（2026-11-26 核对，未修订）**——后续页面迭代超出了本文件规格，以下条目待重新对齐或补规格：

- 功能层毛玻璃现仅 `sim-banner` 在用；页面里已无 `.bt-glass` / `--bt-hero-glow` 引用（§1/§3.3/§5.3/§7.2 描述的"顶部 hero 毛玻璃信息条 + 光晕"当前不存在）。
- home 首页现为 1:1 大图卡（左上设备名/连接态 + 右下开关 + 底部亮度条）+ 2×4 引脚卡片网格，与 §7.2 展示页范式 A 的"大标题 + 信息条 + 分组卡片"不同。
- pin-detail 的灯组切换是下拉框（`picker`，固定 5 个，右侧「配置」按钮开弹窗改名称/灯珠范围），组内为横向阶段分段条 + 气泡参数卡；图层为**两列固定槽位卡（背景 / 动效）**，占用槽显示灯效名 + 色块 + 关键参数摘要（多色灯效另有一条渐变色带），点卡片开居中弹窗编辑灯效/参数；每格右上角 ✕ 就地删除该槽（另一格原位不动），空槽显示虚线「＋ 添加{背景|动效}」，两格都空时阶段下方提示「本阶段没有图层，灯珠不亮」。§7.3 的行式表单描述与实际结构已有差距。

**后续事项（登记，不在本轮）**：
1. **深色模式逐页精调** + 主题切换入口（mine 页开关，wx.setStorage 持久化）。
2. **wxml 内联色 token 化**：switch/slider color 属性暂为字面量 `#0088FF`（5 处：home ×1、mine ×1、pin-detail ×3）；另有 app.json tabBar `selectedColor` 同源，以及 home 亮度条（hero 卡内用 `#ffffff`，非 accent，不在收敛范围）；待小程序支持 CSS 变量注入组件属性或改用自定义 checkbox/switch 组件时收敛。
3. **组件化扩展**：按 sim-banner 模式继续抽取卡片（device-card / pin-card）、设置行（settings-row）、按钮（bt-button）组件，消除页面间样式复制。
4. **基础库升级评估**：升级到较新稳定版以获得新 CSS 能力（当前 2.32.0）。
5. **自定义导航栏（进阶选项）**：若未来要完全沉浸式 Liquid Glass，可评估 `navigationStyle: custom` + 胶囊避让方案；design.md 届时补充规格。