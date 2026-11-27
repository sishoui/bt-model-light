// 引脚配置详情页（ADR-0027 / #27 / T7）。
//
// 结构：顶部（图片/名称/开关）+ 灯组 Tab（长按弹配置窗改名称/灯珠范围）
// + 步骤/图层编辑器 + 灯效下拉 + 参数表单联动（同页）。修改即推送：任何有效改动落盘 Storage 后
// 经 autoSync 防抖下发固件（WRITE_CONFIG + APPLY），无保存按钮。
// 引脚固定 8 个（硬件不可增删），本页无删除引脚入口。
//
// 编辑态用页面 data（ADR-0023），与已保存态分离。离开拦截仅在同步在途
// （防抖窗口 <500ms）时提示；同步状态经 autoSync.subscribe 驱动顶部状态条。
// 灯效参数 schema 直接消费 protocol_gen 的 EFFECT_PARAMS（与固件 ADR-0018 同源），
// 切换灯效即按 schema 重建参数表单。Storage 真相源经 configCodec 编码下发固件。

const { getDeviceConfig, saveDeviceConfig, getDevicePower } = require('../../utils/deviceStore')
const { encodeConfigBlob, validateConfig, effectName, clampInt } = require('../../utils/configCodec')
const { getRecentColors, pushRecentColor, rgbToHex, hexToRgb, hsvToRgb, rgbToHsv } = require('../../utils/recentColors')
const { EFF, EFFECT_PARAMS, LIMITS } = require('../../utils/protocol_gen')
const autoSync = require('../../utils/autoSync')
const charts = require('../../utils/chartHelpers')
const effectPreview = require('../../utils/effectPreview')

// ---- 静态选项（下拉 range / 文案） -------------------------------------------

// 效果 id → 中文名（ADR-0017 表）。
const EFFECT_LABELS = {
  [EFF.SOLID]: '常亮',
  [EFF.BREATH]: '呼吸',
  [EFF.BLINK]: '闪烁',
  [EFF.MARQUEE]: '跑马灯',
  [EFF.RAINBOW]: '彩虹渐变',
  [EFF.METEOR]: '流星拖尾',
  [EFF.DUAL_GRADIENT]: '双色渐变',
  [EFF.RHYTHM]: '律动跳变',
}

// picker 选项：索引即 EFF id 顺序（1..8）。
const EFFECT_OPTIONS = Object.keys(EFF)
  .map((k) => EFF[k])
  .sort((a, b) => a - b)
  .map((id) => ({ id, label: EFFECT_LABELS[id] || `效果 ${id}` }))
const EFFECT_NAMES = EFFECT_OPTIONS.map((o) => o.label)

const TRANSITION_OPTIONS = ['无', '淡入淡出', '平滑']
const LOOP_OPTIONS = ['单次', '循环', '往复']

// 参数名 → 中文标签（表单展示）。
const PARAM_LABELS = {
  color: '颜色',
  color2: '第二颜色',
  brightness: '亮度',
  speed: '速度',
  direction: '方向',
  period: '周期(ms)',
  waveform: '波形',
  on_time: '亮时长(ms)',
  off_time: '灭时长(ms)',
  led_count: '灯珠数',
  gap: '间隔',
  spread: '扩散',
  tail_length: '尾长',
  decay: '衰减',
  mode: '模式',
  pattern: '节奏',
  step_size: '跳变步长',
}

// effect id → schema 名复用 configCodec.effectName（单一真相源，避免重造反向表）。
// clamp 复用 configCodec.clampInt。

function clamp(v, min, max) {
  return clampInt(v, min, max)
}

// 参数默认值（新建图层 / 切换灯效时）。
function defaultParamValue(p) {
  if (p.type === 'rgb') return [255, 255, 255]
  if (p.name === 'brightness') return 128
  if (p.name === 'speed') return 50
  return p.min
}

// 枚举型参数：离散取值用 picker（选项标签 → 值由 min 起算的序号）。
const PARAM_OPTIONS = {
  direction: ['正向', '反向'],
  waveform: ['正弦', '方波'],
  mode: ['渐变', '渐变回卷'],
}

// 连续型参数用滑块；离散/枚举用 picker；其余（小范围整数如灯珠数/间隔）留数字输入。
const SLIDER_PARAMS = new Set([
  'brightness', 'speed', 'period', 'on_time', 'off_time',
  'spread', 'tail_length', 'decay', 'step_size',
])

// ---- 图层参数：schema ↔ 表单字段 -------------------------------------------

// 按 effect 的 EFFECT_PARAMS schema 生成表单字段描述（供 WXML 渲染）。
function buildParamFields(effectId, params) {
  const spec = EFFECT_PARAMS[effectName(effectId)] || []
  const src = params || {}
  return spec.map((p) => {
    let value
    let hex = null
    if (p.type === 'rgb') {
      const v = Array.isArray(src[p.name]) ? src[p.name] : defaultParamValue(p)
      value = [clamp(v[0], 0, 255), clamp(v[1], 0, 255), clamp(v[2], 0, 255)]
      hex = rgbToHex(value)
    } else {
      const v = src[p.name] === undefined ? defaultParamValue(p) : src[p.name]
      value = clamp(v, p.min, p.max)
    }
    const options = p.type === 'rgb' ? null : PARAM_OPTIONS[p.name] || null
    // 枚举 picker 的 value 是选项序号（0 起），与协议值（min 起）差一个 min 偏移。
    const displayValue = options ? value - p.min : value
    return {
      name: p.name, label: PARAM_LABELS[p.name] || p.name, type: p.type,
      min: p.min, max: p.max, value, hex, options, displayValue,
      slider: !options && p.type !== 'rgb' && SLIDER_PARAMS.has(p.name),
    }
  })
}

// 表单字段 → params 对象（编码用）。
function fieldsToParams(fields) {
  const out = {}
  for (const f of fields) {
    if (f.type === 'rgb') out[f.name] = [clamp(f.value[0], 0, 255), clamp(f.value[1], 0, 255), clamp(f.value[2], 0, 255)]
    else out[f.name] = clamp(f.value, f.min, f.max)
  }
  return out
}

// ---- 3D 灯效预览几何 ---------------------------------------------------------

// 长条灯带模型：一颗灯珠一个点，等距排在一条直线上（长条灯条）。
const PREVIEW_STRIP = { length: 8 }
// 相机距离（模型单位）：长条几乎正对镜头，用较长焦（距离=焦距）压住透视畸变，
// 灯条保持"长条"观感而不是一截粗管。
const PREVIEW_LENS = 14
// 旋转限位：长条只需轻微倾斜就能读出立体感；转太大既会缩成一条斜线，
// 又会因投影缩放按最坏角度算而把整个灯条压小。这两个值同时决定缩放口径
// （projectPoints 按此范围算最坏尺寸），必须成对改。
const PREVIEW_YAW_LIMIT = 0.45
const PREVIEW_PITCH_LIMIT = 0.25
// 自动摆动：在限位内轻微来回摆，比整圈自转更适合长条。
const PREVIEW_SWAY_YAW = 0.34

// ---- 图层卡片摘要（两列卡片只读展示，详情在弹窗里编辑） ---------------------

// 摘要取这两个参数：各灯效都有、最常用；半屏宽的卡片只放得下两项。
const SUMMARY_PARAMS = ['brightness', 'speed']

// 字段 → 卡片摘要：首个 rgb 字段作色块，关键参数拼一行文案。
function buildLayerCard(fields) {
  const color = fields.find((f) => f.type === 'rgb')
  const parts = []
  for (const name of SUMMARY_PARAMS) {
    const f = fields.find((fd) => fd.name === name && fd.type !== 'rgb')
    if (f) parts.push(`${f.label} ${f.value}`)
  }
  return { swatch: color ? color.hex : null, summary: parts.join(' · ') }
}

// 图层 VM 的卡片摘要重算（字段改动后调用）：色板摘要 + 渐变色带。
// Object.assign 保留 slot/lid/role 等位置元数据（ADR-0033）。
function refreshLayerCard(layer) {
  const base = Object.assign({}, layer, buildLayerCard(layer.fields || []))
  // 渐变色带：RAINBOW/DUAL_GRADIENT/METEOR 等多色灯效在卡片底部画一条
  // CSS linear-gradient，让效果一眼可见（SOLID/BLINK 返回 null 不画）。
  base.gradientCss = charts.layerGradientCss(base.effect, base.fields || [])
  return base
}

// ---- 默认模型 + VM 转换 -----------------------------------------------------

let _uidSeq = 1
function uid() {
  return _uidSeq++
}

// 图层槽位：每阶段固定两格，0 = 背景、1 = 动效。槽位是位置语义而不是顺序——
// 删掉背景后动效仍留在第二格；两格都空即该阶段不亮（ADR-0033）。
const LAYER_SLOTS = [
  { slot: 0, role: '背景' },
  { slot: 1, role: '动效' },
]

// 空槽占位：卡片渲染用（保留在数组里让两格位置固定），不参与下发编码。
function emptyLayer(slot) {
  return {
    lid: `slot-${slot}`,
    slot,
    role: LAYER_SLOTS[slot].role,
    empty: true,
    effect: null,
    effectName: '',
    fields: [],
    swatch: null,
    summary: '',
    gradientCss: null,
  }
}

function emptyLayerSlots() {
  return LAYER_SLOTS.map((s) => emptyLayer(s.slot))
}

// 图层 VM：effectName 供 WXML 直接显示（避免依赖 EFF id 连续假设的下标运算）；
// swatch/summary 供两列卡片只读展示（详见弹窗编辑）。
function makeLayer(effectId, params, lid, slot) {
  const fields = buildParamFields(effectId, params)
  const card = buildLayerCard(fields)
  return Object.assign(
    {
      lid: lid || uid(),
      slot: slot || 0,
      role: LAYER_SLOTS[slot || 0].role,
      empty: false,
      effect: effectId,
      effectName: EFFECT_LABELS[effectId] || `效果 ${effectId}`,
      fields,
      swatch: card.swatch,
      summary: card.summary,
      // 渐变色带 CSS（多色灯效用，单色返回 null）。
      gradientCss: charts.layerGradientCss(effectId, fields),
    },
  )
}

function defaultLayer(effectId, slot) {
  return makeLayer(effectId || EFF.SOLID, null, null, slot)
}

// 阶段默认名：阶段一/二/…（上限 5，超出回退数字）。
const CN_NUMS = ['一', '二', '三', '四', '五']
function stageDefaultName(i) {
  return '阶段' + (CN_NUMS[i] || String(i + 1))
}

// 阶段条分段宽度：最小长度(rpx) + 按时长比例分配剩余宽度（运行时测量容器宽）。

function defaultStep(index) {
  // 只启用背景槽（默认常亮），动效槽留空——与旧行为一致（每阶段至少一层）。
  return {
    sid: uid(),
    name: stageDefaultName(index || 0),
    duration: 5,
    transition: 0,
    loopMode: 1,
    layers: [defaultLayer(EFF.SOLID, 0), emptyLayer(1)],
  }
}

function defaultGroup(name) {
  // 默认空态：ledStart == ledEnd == 255 哨兵（未选灯珠）。镜像 firmware config.cpp。
  return { gid: uid(), name: name || '灯组 1', ledStart: 0xff, ledEnd: 0xff, steps: [defaultStep(0)] }
}

// ---- 灯珠拖选几何（#31） ----------------------------------------------------
// 长按激活阈值：ms。短触（点击）不触发拖选，避免误改配置。
const LONG_PRESS_MS = 1000

// 坐标 → 灯珠格号：按每格真实渲染 rect 找最近中心。
// 不用"列数均分 rect"假设（实际列数随屏宽变化，是旧版偏移的根因）。
function indexFromRects(clientX, clientY, rects) {
  if (!rects || !rects.length) return 0
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r) continue
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    const d = dx * dx + dy * dy
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

// 取消区命中：拖到屏幕下方半透明覆盖层（微信语音取消样式）。
// 覆盖层 fixed 定在屏幕底部约 80rpx（≈40px）；clientY 超过阈值即视为进入取消区。
function inCancelZone(clientY, winH) {
  if (!winH) return false
  return clientY > winH - 40
}

// Storage / wire 模型 → 页面编辑态 VM（补 gid/sid/lid 与 fields）。
// 图层按槽位落格：优先读存储里的 slot 字段，旧配置（无 slot）按数组序 0/1 推断，
// 缺槽补空占位——两格位置始终固定（ADR-0033）。
function groupToVM(g, index) {
  return {
    gid: uid(),
    name: g.name || `灯组 ${index + 1}`,
    ledStart: g.ledStart,
    ledEnd: g.ledEnd,
    steps: (g.steps || []).map((s, i) => {
      const slots = emptyLayerSlots()
      ;(s.layers || []).forEach((l, li) => {
        if (!l || !l.effect) return
        const slot = l.slot === 0 || l.slot === 1 ? l.slot : li
        if (!slots[slot] || !slots[slot].empty) return // 槽位越界/重复：丢弃异常项
        slots[slot] = makeLayer(l.effect, l.params, null, slot)
      })
      return {
        sid: uid(),
        name: s.name || stageDefaultName(i),
        duration: s.duration,
        transition: s.transition,
        loopMode: s.loopMode,
        layers: slots,
      }
    }),
  }
}

// 页面编辑态 VM → Storage / wire 模型（去掉 gid/sid/lid/fields）。
// 空槽不下发；只发有图层的槽位，并带上 slot 以便重载后回到同一格。
function vmToGroup(g) {
  return {
    name: g.name,
    ledStart: g.ledStart,
    ledEnd: g.ledEnd,
    steps: g.steps.map((s) => ({
      name: s.name,
      duration: s.duration,
      transition: s.transition,
      loopMode: s.loopMode,
      layers: s.layers
        .filter((l) => l && !l.empty)
        .map((l) => ({ slot: l.slot, effect: l.effect, params: fieldsToParams(l.fields) })),
    })),
  }
}

// ---- 页面 -------------------------------------------------------------------

Page({
  data: {
    deviceId: null,
    pin: 0,
    ledCount: LIMITS.ledsPerPinMax, // 灯珠数（能力），范围点选用
    // 顶部
    img: '',
    pinName: '引脚',
    power: false,
    // 整机开关（ADR-0032）：关 = 设备输出全黑，本页的灯带开关随之置灰不可切换。
    masterPower: true,
    // 模拟模式标志（onLoad 设置，用于显示提示）。
    simMode: false,
    // 灯组 Tab（固定 5 个，无新增/删除；tab 上小字显示灯珠区间）
    groups: [], // VM 数组
    activeGroup: 0,
    // 灯珠拖选（#31）：dragging 拖拽中，dragRange [min,max] 实时渲染。
    dragging: false,
    dragRange: null,
    inCancelZone: false,
    ledCells: [], // [{ i, state }] 渲染用（state: empty/selected/occupied/drag-*）
    // 灯组配置弹窗（长按灯组 Tab 打开）：名称 + 灯珠范围拖选内嵌其中。
    groupConfigOpen: false,
    // 当前选中的阶段下标（横向阶段条 + 下方详情单页）。
    activeStepSi: 0,
    // 气泡卡片箭头水平位置(rpx)：当前选中段中心相对 stage-inner 起点。
    bubbleX: 0,
    // 长按拖动排序态：dragIndex 为正在拖动的节点下标（null=未拖），dragX 为其当前位移(rpx)，
    // hoverIndex 为当前悬停落点下标（拖动中其余节点据此实时避让）。
    dragIndex: null,
    dragX: 0,
    hoverIndex: 0,
    // 各节点相对 flex 基础位的位移(rpx)：拖动跟手 / 其余节点避让。
    offsets: {},
    // 各分段宽度(rpx)：按 duration 比例、带最小长度。
    segW: [],
    // 阶段时间轴图（泳道甘特）：steps 的归一化时间窗 + 图层子段 + 过渡区间。
    // 由 _refreshTimeline 在 groups/activeGroup/activeStepSi 变化时重算。
    timeline: [],
    // 3D 灯效预览 canvas：预览灯珠数与参与合成的图层数（标题栏展示）。
    previewLeds: effectPreview.PREVIEW_LEDS_FALLBACK,
    previewLayerCount: 1,
    // 新增节点的进入动画标记（该下标播放一次 scale-in 后清除）。
    enterIndex: -1,
    // 图层配置弹窗：卡片只读展示，点开弹窗改灯效/参数。target 为定位（si/li）。
    layerEditorOpen: false,
    layerEditorSi: 0,
    layerEditorLi: 0,
    // 颜色弹层（#33）。
    colorPickerOpen: false,
    colorPickerTarget: null, // 目标 field 定位（si/li/fi），随 setData 同步给 WXML
    recentColors: [],
    // 色轮选色状态：h[0,360)、s[0,100]；不含量度——亮度归图层的 brightness 参数管。
    // pickerHex 为当前预览 hex，pickerUi 为圆点位置。
    pickerHueSat: { h: 0, s: 0 },
    pickerHex: '#FFFFFF',
    pickerUi: { dotX: '50%', dotY: '50%' },
    // 同步状态条（autoSync 驱动）：state 为 syncing/synced/failed/local，idle 不显示。
    syncState: 'idle',
    syncAt: '',
    // 静态选项
    effectNames: EFFECT_NAMES,
    transitionOptions: TRANSITION_OPTIONS,
    loopOptions: LOOP_OPTIONS,
    // 上限透传给 WXML（避免模板里硬编码 5/2 与 JS 校验漂移）。
    groupsPerPinMax: LIMITS.groupsPerPinMax,
    stepsPerGroupMax: LIMITS.stepsPerGroupMax,
    layersPerStepMax: LIMITS.layersPerStepMax,
    // 当前阶段两格都空 → WXML 提示"灯珠不亮"（_refreshTimeline 维护）。
    activeStepEmpty: false,
  },

  onLoad(options) {
    const q = options || {}
    const pin = Number(q.pin)
    const app = getApp()
    this._deviceId = (app && app.globalData && app.globalData.currentDeviceId) || null
    _uidSeq = 1
    try {
      this._winW = (wx.getSystemInfoSync() || {}).windowWidth || 375
    } catch (e) {
      this._winW = 375
    }
    this._loadFromStore(Number.isFinite(pin) ? pin : 0)
    this.setData({ simMode: !!(app && app.globalData && app.globalData.simMode) })
    // 同步状态条订阅（autoSync 全局单例）；页面卸载时退订。
    this._offSync = autoSync.subscribe((snap) => {
      this.setData({ syncState: snap.state, syncAt: snap.at })
      this._syncUnloadGuard()
    })
    this._syncUnloadGuard()
  },

  onUnload() {
    this._stopPreviewLoop()
    if (this._offSync) this._offSync()
    this._syncUnloadGuard()
  },

  // 切后台停掉预览动画（省电），回来时若弹窗还开着就重取节点并恢复（内部会重启循环）。
  onHide() {
    this._stopPreviewLoop()
  },

  onShow() {
    if (this.data.layerEditorOpen && wx.nextTick) wx.nextTick(() => this._drawEffectPreview())
  },

  onReady() {
    this._measureStage()
  },

  // 从 Storage 读该引脚配置 → 编辑态；无配置则初始化默认灯组。
  _loadFromStore(pin) {
    const ledCount = LIMITS.ledsPerPinMax
    let pinEntry = null
    if (this._deviceId) {
      const cfg = getDeviceConfig(this._deviceId)
      const pins = (cfg && Array.isArray(cfg.pins) ? cfg.pins : []).filter((p) => p && p.pin === pin)
      pinEntry = pins.length ? pins[0] : null
    }
    // 灯组固定 5 个：已存配置原样保留，不足用默认灯组补齐（旧配置只存了 1 组也能显示 5 tab）。
    const saved = pinEntry && Array.isArray(pinEntry.groups) ? pinEntry.groups : []
    const groups = []
    for (let i = 0; i < LIMITS.groupsPerPinMax; i++) {
      groups.push(saved[i] ? groupToVM(saved[i], i) : defaultGroup(`灯组 ${i + 1}`))
    }

    this.setData({
      deviceId: this._deviceId,
      pin,
      ledCount,
      img: (pinEntry && pinEntry.img) || '',
      pinName: (pinEntry && pinEntry.name) || `引脚 ${pin + 1}`,
      // 灯带开关：只有显式 power === false 才算关（老配置无该字段 → 开，ADR-0028）；
      // 首次配置保存时写入该默认值，与 home 引脚卡片开关同口径。
      power: !pinEntry || pinEntry.power !== false,
      // 设备关机时本页灯带开关置灰（ADR-0032）——状态照旧显示，只是不可切换。
      masterPower: getDevicePower(this._deviceId),
      groups,
      activeGroup: 0,
      activeStepSi: 0,
      dragging: false,
      dragRange: null,
      inCancelZone: false,
    })
    // 初始灯珠网格按 activeGroup=0 渲染，含其他组占用灰显。
    this.setData({ ledCells: this._buildLedCells(groups[0], ledCount, this._computeOccupied(0), null) })
    this._refreshTimeline()
  },

  // ---- 视图导航 --------------------------------------------------------------

  // 轻点阶段节点：选中该阶段（图层卡片随之切到该阶段）。
  onSelectStage(e) {
    if (this.data.dragIndex !== null) return // 拖动中忽略点击
    const si = Number(e.currentTarget.dataset.si)
    const group = this.data.groups[this.data.activeGroup]
    if (!group || !group.steps[si]) return
    this.setData({ activeStepSi: si, layerEditorOpen: false })
    this._recalcBubbleX()
    this._refreshTimeline()
  },

  // 测量阶段条容器宽度(px)，并按段时长比例(带最小长度)计算各段宽(rpx)。
  _measureStage() {
    if (typeof wx === 'undefined' || !wx.createSelectorQuery) return
    const q = wx.createSelectorQuery().in(this)
    q.select('.stage-inner').boundingClientRect((r) => {
      if (r && r.width) {
        this._stageW = r.width
        this._recalcSegW()
      }
    })
    q.exec()
  },

  // 段宽：最小 MIN(rpx)，其余按 duration 比例分配；总宽不足时全取最小（横向滚动）。
  _recalcSegW() {
    const steps = this.data.groups[this.data.activeGroup].steps
    const n = steps.length || 1
    const winW = this._winW || 375
    const availPx = this._stageW || winW * 0.9
    const availRpx = (availPx * 750) / winW
    const MIN = 96
    let widths
    if (n * MIN >= availRpx) {
      widths = []
      for (let i = 0; i < n; i++) widths.push(MIN)
    } else {
      const total = steps.reduce((s, st) => s + (st.duration || 1), 0) || 1
      const rem = availRpx - n * MIN
      widths = steps.map((st) => MIN + (rem * (st.duration || 1)) / total)
    }
    this._segRpx = widths
    this.setData({ segW: widths })
    this._recalcBubbleX()
  },

  // 气泡箭头水平位置：当前选中段中心(rpx)。stage-inner 左右各 24rpx 外边距，
  // 气泡卡片同样 24rpx 外边距，二者起点对齐，故段中心即箭头 left。
  _recalcBubbleX() {
    const widths = this._segRpx || []
    const si = this.data.activeStepSi
    if (!widths.length || si >= widths.length) {
      this.setData({ bubbleX: 0 })
      return
    }
    let x = 0
    for (let i = 0; i < si; i++) x += widths[i]
    x += widths[si] / 2
    this.setData({ bubbleX: x })
  },

  // 各段像素宽 / 累计起点(px)，供拖动使用。
  _segLayoutPx() {
    const winW = this._winW || 375
    const k = winW / 750
    const widths = (this._segRpx || []).map((w) => w * k)
    const base = []
    let acc = 0
    for (let i = 0; i < widths.length; i++) {
      base.push(acc)
      acc += widths[i]
    }
    return { widths, base, total: acc }
  },

  // 拖动中按落点避让：被拖段跟手，其余按被拖段宽让位。
  _recalcOffsets(dragX, hoverIndex) {
    const dragIndex = this.data.dragIndex
    const n = this.data.groups[this.data.activeGroup].steps.length
    const { widths, base } = this._segLayoutPx()
    const wDrag = widths[dragIndex] || 0
    const off = {}
    for (let si = 0; si < n; si++) {
      if (dragIndex === null || dragIndex === si) {
        off[si] = dragIndex === si ? dragX - base[si] : 0
        continue
      }
      let d = 0
      if (dragIndex < hoverIndex && si > dragIndex && si <= hoverIndex) d = -wDrag
      else if (dragIndex > hoverIndex && si >= hoverIndex && si < dragIndex) d = wDrag
      off[si] = d
    }
    return off
  },

  // 长按段：进入跟手拖动。
  onStageLongPress(e) {
    const si = Number(e.currentTarget.dataset.si)
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    this._dragStartClientX = t.clientX || 0
    const { base } = this._segLayoutPx()
    const startX = base[si] || 0
    this.setData({ dragIndex: si, dragX: startX, hoverIndex: si, enterIndex: -1, offsets: this._recalcOffsets(startX, si) })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  onStageTouchMove(e) {
    if (this.data.dragIndex === null) return
    const t = e.touches && e.touches[0]
    if (!t) return
    const { widths, base, total } = this._segLayoutPx()
    const wDrag = widths[this.data.dragIndex] || 0
    const x = Math.max(0, Math.min(total - wDrag, (base[this.data.dragIndex] || 0) + (t.clientX - this._dragStartClientX)))
    // 落点：被拖段中心落在哪一段区间。
    const center = x + wDrag / 2
    let hover = 0
    for (let i = 0; i < widths.length; i++) {
      if (center >= base[i]) hover = i
    }
    const changed = hover !== this.data.hoverIndex
    this.setData({ dragX: x, hoverIndex: hover, offsets: this._recalcOffsets(x, hover) })
    if (changed && wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  onStageTouchEnd() {
    if (this.data.dragIndex === null) return
    const from = this.data.dragIndex
    const to = this.data.hoverIndex
    if (to !== from) {
      this._editActiveGroup((group, arr) => {
        const moved = arr.splice(from, 1)[0]
        arr.splice(to, 0, moved)
      })
      this.setData({ activeStepSi: to, layerEditorOpen: false })
      this._recalcBubbleX()
    }
    this.setData({ dragIndex: null, dragX: 0, offsets: {} })
  },

  // 点图层卡片：打开该图层的配置弹窗（灯效 + 参数表单都在弹窗里）。
  // 点空槽卡片 = 在该槽位新建图层，不打开弹窗。
  onOpenLayerEditor(e) {
    const si = Number(e.currentTarget.dataset.si)
    const li = Number(e.currentTarget.dataset.li)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    const layer = step && step.layers && step.layers[li]
    if (!layer) return
    if (layer.empty) {
      this.onAddLayer(e)
      return
    }
    this.setData({ layerEditorOpen: true, layerEditorSi: si, layerEditorLi: li })
    this._preparePreview(si, li, true)
    // canvas 节点在 wx:if 内，必须等下一帧再取节点。
    if (wx.nextTick) wx.nextTick(() => this._drawEffectPreview())
  },

  onCloseLayerEditor() {
    this._stopPreviewLoop()
    this.setData({ layerEditorOpen: false })
  },

  // 预览数据装配：目标阶段 → 各图层渲染参数、灯珠数、长条几何。
  // 弹窗内每次字段变更都调用（灯珠数会影响几何）；resetView 仅在打开弹窗时置位。
  _preparePreview(si, li, resetView) {
    const group = this.data.groups[this.data.activeGroup]
    const step = group && group.steps[si]
    if (!step) return
    // 预览按阶段整体合成（0~2 个图层），编辑中的图层自然包含在内——
    // 这才能反映"动效层亮灯珠覆盖背景层"的真实输出（镜像固件 compose_layer）。
    // 空槽不参与合成；两格都空时预览画布整条不亮。
    this._previewLayers = (step.layers || [])
      .filter((l) => l && !l.empty && l.effect)
      .map((l) => ({ effect: l.effect, params: fieldsToParams(l.fields || []) }))
    const leds = effectPreview.stripLength(group)
    this._previewLeds = leds
    this._previewGeometry = effectPreview.stripPoints(leds, PREVIEW_STRIP)
    if (resetView || this._previewElapsed === undefined) {
      this._previewElapsed = 0
      // 初始视角略偏侧 + 略俯视：能看出灯条的纵深与灯珠层次，又保住横向长条形状。
      this._previewYaw = -0.28
      this._previewPitch = 0.22
      this._previewSway = 0
    }
    if (this.data.previewLeds !== leds) this.setData({ previewLeds: leds })
    if (this.data.previewLayerCount !== this._previewLayers.length) {
      this.setData({ previewLayerCount: this._previewLayers.length })
    }
  },

  // 预览舞台拖动旋转：水平拖 → 绕 y 轴，垂直拖 → 俯仰。
  // 两个方向都限位：长条转过 ±50° 会缩成一条斜线，看不出灯珠阵列。
  onPreviewTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    this._previewDragging = true
    this._previewTouchAt = Date.now()
    this._previewTouchStart = { x: t.clientX || 0, y: t.clientY || 0 }
    this._previewStartAngles = { yaw: this._previewYaw || 0, pitch: this._previewPitch || 0 }
  },

  onPreviewTouchMove(e) {
    if (!this._previewDragging) return
    const t = (e.touches && e.touches[0]) || {}
    const start = this._previewTouchStart
    const angles = this._previewStartAngles
    if (!start || !angles) return
    const dx = (t.clientX || 0) - start.x
    const dy = (t.clientY || 0) - start.y
    this._previewYaw = clamp(angles.yaw + dx * 0.012, -PREVIEW_YAW_LIMIT, PREVIEW_YAW_LIMIT)
    this._previewPitch = clamp(angles.pitch + dy * 0.010, -PREVIEW_PITCH_LIMIT, PREVIEW_PITCH_LIMIT)
    this._previewTouchAt = Date.now()
    this._renderPreviewFrame()
  },

  onPreviewTouchEnd() {
    this._previewDragging = false
    this._previewTouchAt = Date.now()
  },

  // 灯珠网格渲染模型：按 state 渲染（空/选中/占用/拖选起终/拖选中间）。
  // occupied: 其他组占用的格号集合；dragRange: [min,max] 拖选临时区间。
  _buildLedCells(group, ledCount, occupied, dragRange) {
    const cells = []
    const empty = !group || group.ledStart === 0xff || group.ledEnd === 0xff
    const s = group ? group.ledStart : 0
    const e = group ? group.ledEnd : -1
    const hasDrag = dragRange && dragRange[1] >= dragRange[0]
    const dStart = hasDrag ? dragRange[0] : -1
    const dEnd = hasDrag ? dragRange[1] : -1
    for (let i = 0; i < ledCount; i++) {
      let state = 'empty'
      if (occupied && occupied.has(i)) state = 'occupied'
      else if (hasDrag) {
        if (i === dStart) state = 'drag-start'
        else if (i === dEnd) state = 'drag-end'
        else if (i > dStart && i < dEnd) state = 'drag-mid'
        else state = 'empty'
      } else if (!empty && i >= s && i <= e) {
        state = 'selected'
      }
      cells.push({ i, state })
    }
    return cells
  },

  // 其他 4 组占用的格号集合（空组 255 不计入）。用于拖选时灰显不可选格。
  _computeOccupied(exceptIndex) {
    const set = new Set()
    const ledMax = LIMITS.ledsPerPinMax
    this.data.groups.forEach((g, idx) => {
      if (idx === exceptIndex) return
      if (!g || g.ledStart === 0xff || g.ledEnd === 0xff) return
      for (let i = g.ledStart; i <= g.ledEnd && i < ledMax; i++) set.add(i)
    })
    return set
  },

  // 标记编辑态：组装配置 → 校验 → 落盘 Storage → 安排下发（autoSync）。
  // opts.immediate：离散动作（灯带开关）跳过防抖立即发；输入框/滑块保持防抖合并。
  // 校验/编码失败时静默跳过（编辑中间态的瞬时非法是常态，避免刷屏 Toast）。
  _markDirty(opts) {
    if (!this._deviceId) return
    const pinConfig = {
      pin: this.data.pin,
      configured: true,
      name: this.data.pinName,
      power: this.data.power,
      img: this.data.img,
      groups: this.data.groups.map(vmToGroup),
    }
    const base = getDeviceConfig(this._deviceId)
    const pins = (base && Array.isArray(base.pins) ? base.pins : []).filter((p) => p && p.pin !== this.data.pin)
    pins.push(pinConfig)
    pins.sort((a, b) => a.pin - b.pin)
    const config = { version: 1, pins }

    const verr = validateConfig(config)
    if (verr) return
    let blob
    try {
      blob = encodeConfigBlob(config)
    } catch (err) {
      return
    }
    saveDeviceConfig(this._deviceId, config)
    autoSync.schedule(this._deviceId, config, opts)
  },

  // 离开拦截：仅在同步在途（防抖窗口 <500ms 或下发中）时提示「正在同步」；
  // 其余情况改动已落盘且 autoSync 全局存活，离开不丢数据，无需拦截。
  _syncUnloadGuard() {
    if (typeof wx === 'undefined' || !wx.enableAlertBeforeUnload) return
    if (this.data.syncState === 'syncing') {
      wx.enableAlertBeforeUnload({ message: '正在同步，确定离开？' })
    } else {
      wx.disableAlertBeforeUnload({})
    }
  },

  // 状态条「失败·重试」点击 → 立即重发。
  onSyncRetry() {
    autoSync.retry()
  },

  // 替换 activeGroup 的 VM（不可变更新）：mutator 直接在克隆上改，返回后写回。
  _editActiveGroup(mutator, opts) {
    const groups = this.data.groups.slice()
    const group = Object.assign({}, groups[this.data.activeGroup])
    const steps = (group.steps || []).map((s) => Object.assign({}, s))
    mutator(group, steps)
    group.steps = steps
    groups[this.data.activeGroup] = group
    this.setData({ groups })
    this._refreshTimeline()
    // 图层弹窗开着时，参数变更 → 重建预览（几何可能随灯珠数变化）并重绘。
    if (this.data.layerEditorOpen) {
      this._preparePreview(this.data.layerEditorSi, this.data.layerEditorLi)
    }
    if (!(opts && opts.silent)) this._markDirty()
  },

  // 阶段时间轴图数据（泳道甘特）：当前灯组的 steps → 归一化时间窗 + 图层子段。
  // 与横向分段条互补：分段条用于选中/拖排序，时间轴图用于看"总时长比例 + 图层构成"。
  _refreshTimeline() {
    const group = this.data.groups[this.data.activeGroup]
    if (!group) {
      this.setData({ timeline: [], timelineTotal: 0, timelineLegend: [], activeStepEmpty: true })
      return
    }
    const timeline = charts.buildTimeline(group.steps || [])
    // 选中态：时间轴图里当前阶段高亮。
    const si = this.data.activeStepSi
    let total = 0
    const seen = {}
    const legend = []
    for (const seg of timeline) {
      seg.active = seg.si === si
      total += seg.duration
      for (const ly of seg.layers) {
        if (seen[ly.effect]) continue
        seen[ly.effect] = true
        legend.push({
          effect: ly.effect,
          name: EFFECT_LABELS[ly.effect] || `效果 ${ly.effect}`,
          color: ly.color,
        })
      }
    }
    // 当前阶段两格都空 → 页面提示"灯珠不亮"（与下发语义一致）。
    const layers = (group.steps && group.steps[si] && group.steps[si].layers) || []
    const activeStepEmpty = !layers.some((l) => l && !l.empty)
    this.setData({ timeline, timelineTotal: Math.round(total * 10) / 10, timelineLegend: legend, activeStepEmpty })
  },

  // 3D 灯效预览 canvas：把阶段的灯效逐灯珠渲染后投影成长条灯条。
  // 页面只有这一个预览 canvas（图层弹窗内）；字段变动重绘，弹窗打开时动画自转。
  _drawEffectPreview() {
    if (typeof wx === 'undefined' || !wx.createSelectorQuery) return
    const step = this.data.groups[this.data.activeGroup] &&
      this.data.groups[this.data.activeGroup].steps[this.data.layerEditorSi]
    const layer = step && step.layers && step.layers[this.data.layerEditorLi]
    if (!layer || layer.empty) return
    const query = wx.createSelectorQuery().in(this)
    query.select('.effect3d-canvas').fields({ node: true, size: true })
    query.exec((res) => {
      const info = res && res[0]
      if (!info || !info.node) return
      const canvas = info.node
      const ctx = canvas.getContext('2d')
      const dpr = (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2
      const w = info.width || 300
      const h = info.height || 180
      canvas.width = w * dpr
      canvas.height = h * dpr
      this._previewCanvas = { canvas, ctx, w, h, dpr }
      this._renderPreviewFrame()
      this._startPreviewLoop()
    })
  },

  // 单帧：动画时间 + 相机角度 → 灯珠屏幕坐标与颜色。ctx 用 CSS 像素坐标（已按 dpr 缩放）。
  // 画法分三层：灯条板身（带一点厚度感的圆角长条）→ 每颗灯珠的发光 → 灯芯。
  // 发光用 lighter（加色）混合叠两个圆，比逐颗建径向渐变便宜得多。
  _renderPreviewFrame() {
    const view = this._previewCanvas
    if (!view) return
    const { ctx, w, h, dpr } = view
    const layers = this._previewLayers
    if (!layers || !layers.length) return
    const colors = effectPreview.renderStageStrip(layers, this._previewLeds, this._previewElapsed || 0)
    const points = effectPreview.projectPoints(this._previewGeometry, {
      width: w,
      height: h,
      yaw: this._previewYaw || 0,
      pitch: this._previewPitch || 0,
      distance: PREVIEW_LENS,
      focal: PREVIEW_LENS,
      yawRange: PREVIEW_YAW_LIMIT,
      pitchRange: PREVIEW_PITCH_LIMIT,
    })
    if (!points.length) return
    const scale = w / 300
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // 灯条板身：灯珠连成一条（半透明底 + 描边），先铺出"长条灯条"的实体感。
    this._drawStripBody(ctx, points, scale)
    // 由远及近绘制：近处灯珠盖住远处。
    const order = points.map((p, i) => i).sort((a, b) => points[b].depth - points[a].depth)
    ctx.globalCompositeOperation = 'lighter'
    for (const i of order) {
      const p = points[i]
      const c = colors[i] || [0, 0, 0]
      const lit = c[0] + c[1] + c[2]
      if (lit <= 0) continue
      // 深度衰减：越远越暗，模拟空气透视。
      const depthK = Math.min(1, Math.max(0.35, p.rel || 1))
      const core = Math.max(1.1, 2.2 * (p.rel || 1) * scale)
      const halo = core * 3.4
      const strength = (lit / 765) * depthK
      // 光晕：淡而大。
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.30 * strength})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, halo, 0, Math.PI * 2)
      ctx.fill()
      // 灯芯：提亮到接近白，模拟 LED 过曝核心。
      const wr = Math.min(255, Math.round(c[0] + 70 * strength))
      const wg = Math.min(255, Math.round(c[1] + 70 * strength))
      const wb = Math.min(255, Math.round(c[2] + 70 * strength))
      ctx.fillStyle = `rgba(${wr},${wg},${wb},${Math.min(1, 0.55 + 0.45 * strength)})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, core, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  },

  // 灯条板身：把灯珠位置连成一条带宽度的长条（模拟柔性灯带的白色基板）。
  // 用每个点向两侧法线方向偏移半个条宽再串成闭合路径，宽度随透视深度缩放。
  _drawStripBody(ctx, points, scale) {
    const n = points.length
    if (n < 2) return
    const halfW = (pt) => Math.max(1.6, 3.4 * (pt.rel || 1) * scale)
    const left = []
    const right = []
    for (let i = 0; i < n; i++) {
      const p = points[i]
      // 切线方向用相邻点差分（端点退化为一段）。
      const a = points[Math.max(0, i - 1)]
      const b = points[Math.min(n - 1, i + 1)]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      // 法线：切线旋转 90°。
      const nx = -dy / len
      const ny = dx / len
      const hw = halfW(p)
      left.push({ x: p.x + nx * hw, y: p.y + ny * hw })
      right.push({ x: p.x - nx * hw, y: p.y - ny * hw })
    }
    ctx.beginPath()
    ctx.moveTo(left[0].x, left[0].y)
    for (let i = 1; i < n; i++) ctx.lineTo(left[i].x, left[i].y)
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y)
    ctx.closePath()
    // 板身底色：略亮的深灰，暗灯珠时也能看出灯条轮廓。
    ctx.fillStyle = 'rgba(150,156,172,0.16)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(170,178,196,0.20)'
    ctx.lineWidth = Math.max(0.6, 1 * scale)
    ctx.stroke()
  },

  // 启动预览动画（弹窗打开时）：灯效时间推进 + 灯条轻微摆动 + 逐帧重绘。
  // 长条不做整圈自转（转过 90° 会缩成一条斜线），改为在 ±55° 内缓慢来回摆。
  // 限帧 30fps：灯效本身变化慢，30fps 足够顺滑且省电。
  _startPreviewLoop() {
    this._stopPreviewLoop()
    if (typeof wx === 'undefined') return
    const FRAME_MS = 33
    let lastDraw = 0
    const tick = () => {
      if (!this._previewRunning) return
      const now = Date.now()
      const dt = Math.min(64, now - (this._previewLastTs || now))
      this._previewLastTs = now
      // 选色弹层在上时冻结动画（避免用户选色时背景还在跑）。
      if (!this.data.colorPickerOpen) {
        this._previewElapsed += dt
        // 拖动后暂停摆动 1.5s，让用户能停在想看的角度。
        const idle = now - (this._previewTouchAt || 0) > 1500
        if (idle && !this._previewDragging) {
          this._previewSway = (this._previewSway || 0) + dt * 0.0009
          this._previewYaw = Math.sin(this._previewSway) * PREVIEW_SWAY_YAW - 0.32
        }
      }
      if (now - lastDraw >= FRAME_MS - 2) {
        lastDraw = now
        this._renderPreviewFrame()
      }
      this._previewRaf = this._requestFrame(tick)
    }
    this._previewRunning = true
    this._previewLastTs = Date.now()
    this._previewRaf = this._requestFrame(tick)
  },

  // 逐帧调度：优先 canvas.requestAnimationFrame（2d canvas 节点自带），否则退回 setTimeout。
  _requestFrame(cb) {
    const view = this._previewCanvas
    if (view && view.canvas && typeof view.canvas.requestAnimationFrame === 'function') {
      return view.canvas.requestAnimationFrame(cb)
    }
    return setTimeout(cb, 16)
  },

  _stopPreviewLoop() {
    this._previewRunning = false
    const view = this._previewCanvas
    if (this._previewRaf && view && view.canvas && typeof view.canvas.cancelAnimationFrame === 'function') {
      view.canvas.cancelAnimationFrame(this._previewRaf)
    } else if (this._previewRaf) {
      clearTimeout(this._previewRaf)
    }
    this._previewRaf = null
  },

  // ---- 顶部 -------------------------------------------------------------------

  onPinNameInput(e) {
    this.setData({ pinName: e.detail.value })
    this._markDirty()
  },

  onPowerChange(e) {
    if (!this.data.masterPower) return // 设备关机时不可切换（ADR-0032，WXML 已 disabled）
    this.setData({ power: e.detail.value })
    // 灯带开关是离散动作：跳过防抖立即下发（ADR-0029）。
    this._markDirty({ immediate: true })
  },

  // ---- 灯组选择（固定 5 个，无新增/删除；下拉框内显示灯珠区间） ---------------

  // 切到指定灯组：重置阶段选中/图层弹窗/拖选态，重建灯珠网格与气泡箭头。
  _activateGroup(index) {
    if (!this.data.groups[index]) return
    if (index === this.data.activeGroup) return
    this.setData({ activeGroup: index, activeStepSi: 0, layerEditorOpen: false, dragging: false, dragRange: null, inCancelZone: false })
    this.setData({ ledCells: this._buildLedCells(this.data.groups[index], this.data.ledCount, this._computeOccupied(index), null) })
    this._recalcBubbleX()
    this._refreshTimeline()
    if (wx.nextTick) wx.nextTick(() => this._measureStage())
  },

  // 下拉框选组（picker selector）：越界/同组忽略。
  onGroupPick(e) {
    this._activateGroup(Number(e.detail.value))
  },

  // 打开当前组配置弹窗（名称 + 灯珠范围拖选内嵌，修改即推送）。
  onOpenGroupConfig() {
    this.setData({ groupConfigOpen: true, dragging: false, dragRange: null, inCancelZone: false })
    this.setData({ ledCells: this._buildLedCells(this.data.groups[this.data.activeGroup], this.data.ledCount, this._computeOccupied(this.data.activeGroup), null) })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  // 关闭灯组配置弹窗。
  onCloseGroupConfig() {
    this.setData({ groupConfigOpen: false })
  },

  onGroupNameInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const groups = this.data.groups.slice()
    if (!groups[index]) return
    groups[index] = Object.assign({}, groups[index], { name: e.detail.value })
    this.setData({ groups })
    this._markDirty()
  },

  // ---- 灯珠范围拖选（#31） ---------------------------------------------------
  // 长按 300ms 或拖动超 8px 激活（纯点击不触发，避免误改）；
  // 激活后 touchmove 按每格真实 rect 反查格号，实时渲染蓝框/浅蓝条；
  // 松手拖出网格底部（红色取消区）→ 回滚保留上次，否则写回区间。

  onLedTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    this._pressStart = { x: t.clientX, y: t.clientY }
    this._dragActive = false
    this._inCancel = false
    this._rectsReady = false
    // 查询网格 + 每格真实 rect（偏移问题的根治：不假设列数）。
    const query = wx.createSelectorQuery()
    query.in(this)
    query.select('.led-grid').boundingClientRect()
    query.selectAll('.led-cell').boundingClientRect()
    query.exec((res) => {
      this._gridRect = res && res[0]
      this._cellRects = (res && res[1]) || []
      this._rectsReady = true
    })
    // 窗口高度（取消区几何用）。
    try {
      const si = wx.getSystemInfoSync()
      this._winH = (si && si.windowHeight) || 667
    } catch (e) {
      this._winH = 667
    }
    // 长按计时：1s 未松手则激活（唯一激活路径）。
    this._clearLongPress()
    this._longPressTimer = setTimeout(() => {
      if (this._dragActive) return
      this._activateDrag(this._pressStart.x, this._pressStart.y)
    }, LONG_PRESS_MS)
  },

  // 激活拖选：占用检查 → 快照 → 进入 dragging。起点即占用格则不激活。
  _activateDrag(clientX, clientY) {
    if (this._dragActive || !this._rectsReady) return
    const occupied = this._computeOccupied(this.data.activeGroup)
    const anchor = indexFromRects(clientX, clientY, this._cellRects)
    if (occupied.has(anchor)) return
    const g = this.data.groups[this.data.activeGroup]
    this._dragBefore = { ledStart: g.ledStart, ledEnd: g.ledEnd }
    this._dragAnchor = anchor
    this._occupied = occupied
    this._dragRange = [anchor, anchor]
    this._lastRangeKey = anchor + '-' + anchor
    this._dragActive = true
    this._clearLongPress()
    this.setData({ dragging: true, inCancelZone: false, dragRange: [anchor, anchor] })
    this.setData({ ledCells: this._buildLedCells(g, this.data.ledCount, occupied, [anchor, anchor]) })
  },

  onLedTouchMove(e) {
    if (!this._dragActive) return // 未激活（未长按 1s）：移动不触发，杜绝误拖
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    // 取消区：拖到屏幕下方半透明覆盖层。
    const inCancel = inCancelZone(t.clientY, this._winH)
    if (inCancel !== this._inCancel) {
      this._inCancel = inCancel
      this.setData({ inCancelZone: inCancel })
    }
    if (inCancel) return
    const i = indexFromRects(t.clientX, t.clientY, this._cellRects)
    const a = this._dragAnchor
    // 路径检查：anchor→i 的连续区间内遇到占用格就截断（停在占用格前一格），
    // 不跳过灰色格继续扩展（手指快速划过灰色格时也能正确停在边界）。
    let lo = Math.min(a, i)
    let hi = Math.max(a, i)
    let blocked = false
    for (let j = lo; j <= hi; j++) {
      if (this._occupied.has(j)) {
        blocked = true
        if (a < i) hi = j - 1 // 向下拖：停在占用格前一格
        else lo = j + 1 // 向上拖：停在占用格后一格
        break
      }
    }
    if (blocked && lo > hi) return // 整个路径都是占用格，不扩展
    const range = [lo, hi]
    const key = range[0] + '-' + range[1]
    if (key === this._lastRangeKey) return // 区间未变，跳过重渲染
    this._dragRange = range
    this._lastRangeKey = key
    this.setData({ dragRange: range })
    this.setData({ ledCells: this._buildLedCells(this.data.groups[this.data.activeGroup], this.data.ledCount, this._occupied, range) })
  },

  onLedTouchEnd(e) {
    this._clearLongPress()
    if (!this._dragActive) return // 纯点击/短触：不触发拖选，配置不变
    const cancelled = this._inCancel || (e && e.type === 'touchcancel')
    const range = this._dragRange
    const groups = this.data.groups.slice()
    const group = Object.assign({}, groups[this.data.activeGroup])
    if (cancelled) {
      // 回滚到拖拽前快照，保留上次选中。
      group.ledStart = this._dragBefore.ledStart
      group.ledEnd = this._dragBefore.ledEnd
    } else if (range) {
      group.ledStart = range[0]
      group.ledEnd = range[1]
    }
    groups[this.data.activeGroup] = group
    this.setData({ groups, dragging: false, dragRange: null, inCancelZone: false })
    this.setData({ ledCells: this._buildLedCells(group, this.data.ledCount, this._computeOccupied(this.data.activeGroup), null) })
    if (!cancelled) this._markDirty()
    this._resetDragState()
  },

  _clearLongPress() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer)
      this._longPressTimer = null
    }
  },

  _resetDragState() {
    this._dragActive = false
    this._dragBefore = null
    this._dragRange = null
    this._occupied = null
    this._inCancel = false
    this._lastRangeKey = null
  },

  // 一键清除当前组灯珠选择（设 255 空哨兵）。
  onClearLeds() {
    const groups = this.data.groups.slice()
    const group = Object.assign({}, groups[this.data.activeGroup], { ledStart: 0xff, ledEnd: 0xff })
    groups[this.data.activeGroup] = group
    this.setData({ groups })
    this.setData({ ledCells: this._buildLedCells(group, this.data.ledCount, this._computeOccupied(this.data.activeGroup), null) })
    this._markDirty()
  },

  noop() {},

  // ---- 步骤/图层编辑 ----------------------------------------------------------

  onAddStep() {
    if (this.data.groups[this.data.activeGroup].steps.length >= LIMITS.stepsPerGroupMax) {
      wx.showToast({ title: `每灯组最多 ${LIMITS.stepsPerGroupMax} 个阶段`, icon: 'none' })
      return
    }
    const newSi = this.data.groups[this.data.activeGroup].steps.length
    this._editActiveGroup((group, steps) => {
      steps.push(defaultStep(newSi))
    })
    // 添加后选中新阶段；新节点播放一次进入动画。
    this.setData({ activeStepSi: newSi, enterIndex: newSi, layerEditorOpen: false })
    this._recalcBubbleX()
    this._refreshTimeline() // 选中态变了，时间轴高亮需重算
    setTimeout(() => {
      if (this.data.enterIndex === newSi) this.setData({ enterIndex: -1 })
    }, 300)
    if (wx.nextTick) wx.nextTick(() => this._measureStage())
  },

  onDeleteStep(e) {
    const si = Number(e.currentTarget.dataset.si)
    const steps = this.data.groups[this.data.activeGroup].steps
    if (steps.length <= 1) {
      wx.showToast({ title: '至少保留一个阶段', icon: 'none' })
      return
    }
    this._editActiveGroup((group, arr) => {
      arr.splice(si, 1)
    })
    // 删除后选中顺延：删中间选中原下一个（同下标），删尾选新的最后一个。
    const nextLen = this.data.groups[this.data.activeGroup].steps.length
    const nextSi = si < nextLen ? si : nextLen - 1
    this.setData({ activeStepSi: nextSi, layerEditorOpen: false })
    this._recalcBubbleX()
    this._refreshTimeline() // 选中态变了，时间轴高亮需重算
    if (wx.nextTick) wx.nextTick(() => this._measureStage())
  },

  onStageNameInput(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = e.detail.value
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { name: v })
    })
  },

  // 时长数字输入：与 slider 双向绑定（onDurationChange 同步改）。
  onDurationInput(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = clamp(e.detail.value, LIMITS.stepDurationMin, LIMITS.stepDurationMax)
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { duration: v })
    })
    this._recalcSegW()
  },

  // 时长滑块拖动中：实时更新 VM（不触发下发，松手 onDurationChange 才落盘）。
  onDurationChanging(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = clamp(e.detail.value, LIMITS.stepDurationMin, LIMITS.stepDurationMax)
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { duration: v })
    }, { silent: true })
    this._recalcSegW()
  },

  onDurationChange(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = clamp(e.detail.value, LIMITS.stepDurationMin, LIMITS.stepDurationMax)
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { duration: v })
    })
    this._recalcSegW()
  },

  onTransitionChange(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = Number(e.detail.value)
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { transition: v })
    })
  },

  onLoopChange(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = Number(e.detail.value)
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { loopMode: v })
    })
  },

  // 在指定槽位加图层：点空槽卡片（或「添加图层」占位）把该格填成默认常亮。
  onAddLayer(e) {
    const si = Number(e.currentTarget.dataset.si)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    if (!step) return
    const slot = Number(e.currentTarget.dataset.slot)
    const target = Number.isInteger(slot) && slot >= 0 && slot < LAYER_SLOTS.length
      ? slot
      : this._firstEmptySlot(step)
    if (target === -1) {
      wx.showToast({ title: `每阶段最多 ${LIMITS.layersPerStepMax} 个图层`, icon: 'none' })
      return
    }
    this._editActiveGroup((group, steps) => {
      const layers = (steps[si].layers || []).slice()
      layers[target] = defaultLayer(EFF.SOLID, target)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
  },

  // 第一个空槽下标；两格都占满返回 -1。
  _firstEmptySlot(step) {
    const layers = (step && step.layers) || []
    for (let i = 0; i < LAYER_SLOTS.length; i++) {
      if (!layers[i] || layers[i].empty) return i
    }
    return -1
  },

  // 删除图层：清空该槽位但保留占位，另一层原位不动；两格都空则该阶段不亮。
  onDeleteLayer(e) {
    const si = Number(e.currentTarget.dataset.si)
    const li = Number(e.currentTarget.dataset.li)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    if (!step || !step.layers || !step.layers[li]) return
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const slot = layers[li].slot === undefined ? li : layers[li].slot
      layers[slot] = emptyLayer(slot)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
    this.setData({ layerEditorOpen: false })
  },

  // 切换灯效：重建该图层参数表单（schema 联动，ADR-0018）。
  onEffectChange(e) {
    const si = Number(e.currentTarget.dataset.si)
    const li = Number(e.currentTarget.dataset.li)
    const opt = EFFECT_OPTIONS[Number(e.detail.value)]
    if (!opt) return
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const old = layers[li]
      if (!old || old.empty) return
      // 换灯效只换 effect/params，槽位与 lid 保持不变（位置语义，ADR-0033）。
      layers[li] = makeLayer(opt.id, null, old.lid, old.slot)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
  },

  // 参数输入：标量数字走 input；枚举 picker / 连续滑块走 onParamChange。rgb 走色块弹层（#33）。
  onParamInput(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    const field = this._locateField(si, li, fi)
    if (!field) return
    if (field.type === 'rgb') {
      // rgb 已由 onOpenColorPicker + onColorSelected 处理；旧 data-ch 入口不再绑定。
      return
    }
    // 标量（u8/u16）数字输入。
    const raw = e.detail.value
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields[fi])
      f.value = clamp(raw, f.min, f.max)
      fields[fi] = f
      layer.fields = fields
      layers[li] = refreshLayerCard(layer)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
  },

  // 参数滑块拖动中：实时更新 VM（不触发下发）。
  onParamChanging(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    const field = this._locateField(si, li, fi)
    if (!field) return
    const raw = clamp(e.detail.value, field.min, field.max)
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields[fi])
      f.value = raw
      fields[fi] = f
      layer.fields = fields
      layers[li] = refreshLayerCard(layer)
      steps[si] = Object.assign({}, steps[si], { layers })
    }, { silent: true })
  },

  // 参数滑块：连续量按 min~max 写入（松手落盘）。
  onParamChange(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    const field = this._locateField(si, li, fi)
    if (!field) return
    if (field.type === 'rgb') {
      // rgb 已由 onOpenColorPicker + onColorSelected 处理；旧 data-ch 入口不再绑定。
      return
    }
    const raw = e.detail.value
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields[fi])
      f.value = clamp(raw, f.min, f.max)
      fields[fi] = f
      layer.fields = fields
      layers[li] = refreshLayerCard(layer)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
  },

  // 枚举单选：点击胶囊选项，按序号 + min 偏移还原协议值。
  onParamOptionTap(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    const oi = Number(ds.oi)
    const field = this._locateField(si, li, fi)
    if (!field || !field.options) return
    const raw = field.min + oi
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields[fi])
      f.value = clamp(raw, f.min, f.max)
      f.displayValue = oi
      fields[fi] = f
      layer.fields = fields
      layers[li] = refreshLayerCard(layer)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
  },

    // ---- 颜色弹层（#33） ---------------------------------------------------------
  // rgb 色块点击：打开弹层，定位到目标 field，把最近色带入弹层。
  // 色轮只管色相/饱和度；亮度由图层自己的 brightness 参数控制（固件 scale_rgb 缩放），
  // 所以这里选中色一律按满亮度（v=100）写入，避免两处重复压暗。
  onOpenColorPicker(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    this._colorPickerTarget = { si, li, fi }
    const field = this._locateField(si, li, fi)
    const hsv = (field && field.value && rgbToHsv(field.value)) || null
    this._setPickerHueSat(hsv ? hsv.h : 0, hsv ? hsv.s : 0)
    this.setData({ colorPickerOpen: true, colorPickerTarget: { si, li, fi }, recentColors: getRecentColors() })
    // 色轮画在 canvas 上，节点在 wx:if 内，必须等下一帧再画。
    if (wx.nextTick) wx.nextTick(() => this._drawColorWheel())
  },

  // 色相/饱和度 → 弹层 UI 派生：当前 hex 预览 + 色轮圆点位置。
  // 单一计算点，打开初始化与拖动更新共用，避免两处漂移。
  _setPickerHueSat(hue, sat) {
    // 色相取整到 [0,359]：360 与 0 同色，封顶 359 使圆点稳定停在最后一段不回卷。
    const h = Math.round(Math.max(0, Math.min(359, Number(hue) || 0)))
    const s = Math.round(Math.max(0, Math.min(100, Number(sat) || 0)))
    const hex = rgbToHex(hsvToRgb(h, s, 100)).toUpperCase()
    // 色轮圆点：色相为绕圆角度（0° 指向右，顺时针），饱和度为圆心到边缘的比例。
    const rad = (h * Math.PI) / 180
    // 两位小数取整：cos/sin 的浮点误差会把 50% 算成 49.99999999999999%，样式里没必要。
    const pct = (v) => Math.round(v * 100) / 100 + '%'
    this._pickerHueSat = { h, s }
    this._pickerHex = hex
    this.setData({
      pickerHueSat: { h, s },
      pickerHex: hex,
      pickerUi: { dotX: pct(50 + Math.cos(rad) * (s / 2)), dotY: pct(50 + Math.sin(rad) * (s / 2)) },
    })
  },

  // 色轮作画：绕圆 180 段（每段 2°），每段用"圆心白 → 边缘纯色相"的径向渐变填充，
  // 叠出标准 HSV 色轮。色轮只与几何相关，打开弹层画一次即可。
  _drawColorWheel() {
    if (typeof wx === 'undefined' || !wx.createSelectorQuery) return
    const query = wx.createSelectorQuery().in(this)
    query.select('.color-wheel').fields({ node: true, size: true })
    query.exec((res) => {
      const info = res && res[0]
      if (!info || !info.node) return
      const canvas = info.node
      const ctx = canvas.getContext('2d')
      const dpr = (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2
      const w = info.width || 240
      const hgt = info.height || w
      canvas.width = w * dpr
      canvas.height = hgt * dpr
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, hgt)
      const cx = w / 2
      const cy = hgt / 2
      const r = Math.min(w, hgt) / 2
      const segs = 180
      const stepRad = (Math.PI * 2) / segs
      for (let i = 0; i < segs; i++) {
        const a0 = i * stepRad
        const hue = (i * 360) / segs
        const c = rgbToHex(hsvToRgb(hue, 100, 100)).toUpperCase()
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
        grad.addColorStop(0, '#FFFFFF')
        grad.addColorStop(1, c)
        ctx.beginPath()
        // 每段多铺 0.5 个步长，避免相邻扇形之间露白缝。
        ctx.moveTo(cx, cy)
        ctx.arc(cx, cy, r, a0 - stepRad / 2, a0 + stepRad * 1.5)
        ctx.closePath()
        ctx.fillStyle = grad
        ctx.fill()
      }
    })
  },

  // 色轮拖动：start 记录轮盘 rect（后续 move 复用），move 按坐标反解 h/s。
  onPickerTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    const query = wx.createSelectorQuery()
    query.in(this)
    query.select('.picker-wheel').boundingClientRect()
    query.exec((res) => {
      this._wheelRect = (res && res[0]) || null
      this._pickerDragging = true
      this._applyPickerTouch(t)
    })
  },

  onPickerTouchMove(e) {
    if (!this._pickerDragging) return
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    this._applyPickerTouch(t)
  },

  // 松手：写回 field（应用颜色 + 持久化最近色），弹层保持打开可继续微调。
  onPickerTouchEnd() {
    if (!this._pickerDragging) return
    this._pickerDragging = false
    const target = this._colorPickerTarget || {}
    if (!Number.isFinite(target.si) || !Number.isFinite(target.li) || !Number.isFinite(target.fi)) return
    this._applyColorHex(target.si, target.li, target.fi, this._pickerHex)
  },

  // 触摸点 → 色轮上的 h/s 更新。rect 未就绪（查询未回）时忽略。
  _applyPickerTouch(t) {
    const rect = this._wheelRect
    if (!rect || !rect.width) return
    const cur = this._pickerHueSat || { h: 0, s: 0 }
    // 坐标相对圆心反解——角度为色相，半径为饱和度。
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = (t.clientX || 0) - cx
    const dy = (t.clientY || 0) - cy
    const radius = rect.width / 2
    const sRatio = Math.max(0, Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius))
    // 圆心（无方向）保持当前色相：atan2(0,0) 恒为 0，会让色相突跳到红。
    const h = sRatio > 0 ? ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 : cur.h
    this._setPickerHueSat(Math.min(359, h), sRatio * 100)
  },

  // 弹层选色：hex → rgb 写入 target field → 持久化最近色 → 关闭弹层。
  onColorSelected(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const target = this._colorPickerTarget || {}
    const si = Number(ds.si !== undefined ? ds.si : target.si)
    const li = Number(ds.li !== undefined ? ds.li : target.li)
    const fi = Number(ds.fi !== undefined ? ds.fi : target.fi)
    const hex = (e && e.detail && e.detail.value) || ds.hex || ''
    if (!Number.isFinite(si) || !Number.isFinite(li) || !Number.isFinite(fi)) return
    this._applyColorHex(si, li, fi, hex)
    this._colorPickerTarget = null
    this.setData({ colorPickerOpen: false, colorPickerTarget: null })
  },

  // 关闭弹层：不写回、不持久化（仅取消）。
  onCloseColorPicker() {
    this._colorPickerTarget = null
    this.setData({ colorPickerOpen: false, colorPickerTarget: null })
  },

  // 单一选色应用点：hex 校验 → rgb 写入 field.value（及派生 fld.hex） → 持久化最近色。
  _applyColorHex(si, li, fi, hex) {
    const rgb = hexToRgb(String(hex || ''))
    if (!rgb) return
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields[fi])
      f.value = rgb
      f.hex = rgbToHex(rgb)
      fields[fi] = f
      layer.fields = fields
      layers[li] = refreshLayerCard(layer)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
    const hexStr = rgbToHex(rgb)
    if (hexStr) pushRecentColor(hexStr)
  },

  _locateField(si, li, fi) {
    const step = this.data.groups[this.data.activeGroup] && this.data.groups[this.data.activeGroup].steps[si]
    if (!step) return null
    const layer = step.layers[li]
    if (!layer) return null
    return layer.fields[fi] || null
  },

})