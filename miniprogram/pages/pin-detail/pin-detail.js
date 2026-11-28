// 引脚配置详情页（ADR-0027 / #27 / T7）。
//
// 结构：顶部（图片/名称/开关）+ 灯组选择（药丸 picker，右侧「配置」改名称/灯珠范围）
// + 竖向时间轴（左轴圆点管时长，右侧每段一张卡片）。阶段卡片里图层纵向排列，
// 每个可调数字参数是一个细边圆环控件：环长与环下数值都按量程显示成 1-100%，
// 点一下在该图层卡片内展开一行数字轴，拖动实时改值（环同步走），松手才下发；
// 枚举参数不占圆环，直接给一排选项卡，点一下即换档。
// 列表顺序即播放顺序，段内 ↑↓ 调整先后。修改即推送：任何有效改动落盘 Storage 后
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

// 效果 id → 磁贴图标类名（纯 CSS 画的方形图标，见 pin-detail.wxss）。
// 灯效选择从原生 picker 换成磁贴面板：图标比文字更快辨认，也容得下 8 种。
const EFFECT_ICONS = {
  [EFF.SOLID]: 'solid',
  [EFF.BREATH]: 'breath',
  [EFF.BLINK]: 'blink',
  [EFF.MARQUEE]: 'marquee',
  [EFF.RAINBOW]: 'rainbow',
  [EFF.METEOR]: 'meteor',
  [EFF.DUAL_GRADIENT]: 'dual',
  [EFF.RHYTHM]: 'rhythm',
}

// picker 选项：索引即 EFF id 顺序（1..8）。
const EFFECT_OPTIONS = Object.keys(EFF)
  .map((k) => EFF[k])
  .sort((a, b) => a - b)
  .map((id) => ({ id, label: EFFECT_LABELS[id] || `效果 ${id}`, icon: EFFECT_ICONS[id] || 'solid' }))

// 参数名 → 中文标签（圆环下方小字）。
const PARAM_LABELS = {
  color: '颜色',
  color2: '色 2',
  brightness: '亮度',
  speed: '速度',
  direction: '方向',
  period: '周期',
  waveform: '波形',
  on_time: '亮时',
  off_time: '灭时',
  led_count: '灯珠',
  gap: '间隔',
  spread: '扩散',
  tail_length: '尾长',
  decay: '衰减',
  mode: '模式',
  pattern: '节奏',
  step_size: '步长',
}

// 参数名 → 圆环内的图标类名（纯 CSS 伪元素画的极简线条图形，见 pin-detail.wxss）。
// 颜色参数不在此列——它是实心色盘，没有环也放不了图标。
const PARAM_ICONS = {
  brightness: 'sun',
  speed: 'speed',
  direction: 'arrow',
  period: 'clock',
  waveform: 'wave',
  on_time: 'lamp-on',
  off_time: 'lamp-off',
  led_count: 'dots',
  gap: 'gap',
  spread: 'spread',
  tail_length: 'tail',
  decay: 'decay',
  mode: 'toggle',
  pattern: 'rhythm',
  step_size: 'step',
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

// ---- 图层参数：schema ↔ 表单字段 -------------------------------------------

// 枚举型参数：不占圆环，渲染成一排选项卡（选项标签 → 值由 min 起算的序号）。
const PARAM_OPTIONS = {
  direction: ['正向', '反向'],
  waveform: ['正弦', '方波'],
  mode: ['渐变', '渐变回卷'],
}

// ---- 刻度轴（gauge）-----------------------------------------------------------
// 点数值圆环 → 在该图层卡片内展开一行数字轴（横向拖动改值）。
// 轴 = 量程 min..max 均分 steps 格，拖动位置按"格"量化，避免 u8 参数拖出小数；
// 刻度文字与环下数值同口径（1-100%），圆环进度与轴位置都从同一个 value 派生。
//
// 注意：比例（0~1）必须用 clampRatio 而不是 clamp——clamp 走 clampInt，
// 会把 0.4 取整成 0，拖动/环长全部退化成两端。

function clampRatio(v) {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// 比例（0~1）→ 展示用百分比（1~100）。全页数字统一走这一处：
// 环长 / 环下文字 / 数字轴刻度不会各算各的。0 显示 1%（不显示"无"）。
function percentOfRatio(ratio) {
  return Math.max(1, Math.min(100, 1 + Math.round(clampRatio(ratio) * 99)))
}

// 拖动位置（0~1）→ 刻度值：先落到最近的格，再换算回实际单位。
function gaugeValueAt(ratio, min, max, steps) {
  const n = Math.max(1, steps || 1)
  if (n === 1) return min
  const idx = Math.round(clampRatio(ratio) * (n - 1))
  // 连续量的步长恒为 1（schema 里的量程都是整数）。
  const span = max - min
  const stride = span / (n - 1)
  return clamp(Math.round(min + idx * stride), min, max)
}

// 刻度值 → 拖动位置（0~1）：gaugeValueAt 的逆，用于初始摆放高亮档。
function gaugeRatioOf(value, min, max) {
  const span = max - min
  if (!(span > 0)) return 0
  return clampRatio((value - min) / span)
}

// 数字轴只有一个手柄在细线上滑动，不排刻度数字：名称与当前百分比已经在同一行，
// 再铺 5 档数字只会让人读成"第二条进度条"。

// 按 effect 的 EFFECT_PARAMS schema 生成控件描述（供 WXML 渲染）。
// 三类控件：rgb → 实心色盘（走颜色弹层）；枚举 → 选项卡；其余数值 → 细边圆环，
// 环长与环下数值都是 1-100% 的百分比。下发固件的仍是原始值，百分比只是展示口径。
function buildParamFields(effectId, params) {
  const spec = EFFECT_PARAMS[effectName(effectId)] || []
  const src = params || {}
  return spec.map((p, fi) => {
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
    const isEnum = !!options
    // 刻度轴分档：连续量按 1 递增一格。
    const steps = p.type === 'rgb' ? 0 : p.max - p.min + 1
    const percent = p.type === 'rgb' || isEnum ? null : percentOfRatio(gaugeRatioOf(value, p.min, p.max))
    const optionIndex = isEnum ? clamp(value - p.min, 0, options.length - 1) : 0
    // 展示文本：色盘无文字；枚举是选中项名；数值是百分比（与环长同源）。
    const valueText = p.type === 'rgb' ? '' : isEnum ? options[optionIndex] : `${percent}%`
    return {
      name: p.name,
      label: PARAM_LABELS[p.name] || p.name,
      // 在 layer.fields 里的下标：色盘弹层按它定位目标字段。
      index: fi,
      type: p.type,
      min: p.min,
      max: p.max,
      value,
      hex,
      options,
      optionIndex,
      // 枚举选项序号（0 起），供选项卡高亮：value 是协议值，不能直接当索引。
      displayValue: isEnum ? optionIndex : value,
      percent,
      // 圆环进度（1~100）：rgb / 枚举不画环，给 null 让 WXML 走别的分支。
      ring: percent,
      // 环内图标（极简线条图形），色盘参数没有。
      icon: p.type === 'rgb' ? '' : PARAM_ICONS[p.name] || 'dot',
      steps,
      valueText,
    }
  })
}

// 把一个数值写进字段并重算派生项（百分比 / 环长 / 展示文本）。
// 刻度轴拖动、枚举选项卡、灯效切换都汇到这里，三处口径不会漂。
function applyNumberFieldValue(f, value) {
  f.value = clamp(value, f.min, f.max)
  if (f.options) {
    f.optionIndex = clamp(f.value - f.min, 0, f.options.length - 1)
    f.displayValue = f.optionIndex
    f.valueText = f.options[f.optionIndex]
    return f
  }
  f.percent = percentOfRatio(gaugeRatioOf(f.value, f.min, f.max))
  f.ring = f.percent
  f.valueText = `${f.percent}%`
  return f
}

// 表单字段 → params 对象（编码用）：发出去的永远是协议原值，不是百分比。
function fieldsToParams(fields) {
  const out = {}
  for (const f of fields) {
    if (f.type === 'rgb') out[f.name] = [clamp(f.value[0], 0, 255), clamp(f.value[1], 0, 255), clamp(f.value[2], 0, 255)]
    else out[f.name] = clamp(f.value, f.min, f.max)
  }
  return out
}

// ---- 图层卡片摘要（纵向一列，整行宽度足够放更多参数） -----------------------

// 摘要参数：这几个是用户最常看的（灯效节奏感与亮度），纵向整行放得下。
const SUMMARY_PARAMS = ['brightness', 'speed', 'spread', 'tail_length']

// 字段 → 卡片摘要：首个 rgb 字段作色块，关键参数拼一行文案（数值同口径 = 百分比）。
function buildLayerCard(fields) {
  const color = fields.find((f) => f.type === 'rgb')
  const parts = []
  for (const name of SUMMARY_PARAMS) {
    const f = fields.find((fd) => fd.name === name && fd.type !== 'rgb' && !fd.options)
    if (f) parts.push(`${f.label} ${f.valueText || f.percent}`)
  }
  return { swatch: color ? color.hex : null, summary: parts.join(' · ') }
}

// 图层 VM 的卡片摘要重算（字段改动后调用）：色板摘要 + 渐变色带 + 分组字段。
// Object.assign 保留 slot/lid/role 等位置元数据（ADR-0033）。
function refreshLayerCard(layer) {
  const fields = layer.fields || []
  const base = Object.assign({}, layer, buildLayerCard(fields), splitFields(fields))
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
    effectIcon: '',
    accent: '',
    fields: [],
    ringFields: [],
    optionFields: [],
    swatch: null,
    summary: '',
    gradientCss: null,
  }
}

function emptyLayerSlots() {
  return LAYER_SLOTS.map((s) => emptyLayer(s.slot))
}

// 图层 VM：effectName/effectIcon 供 WXML 直接显示（避免依赖 EFF id 连续假设的下标运算）；
// swatch/summary 供图层卡片只读展示。
// fields 保持 schema 原序（编码与测试都按它走），渲染另按控件形态分成两组：
// ringFields（圆环/色盘，四列）+ optionFields（枚举选项卡，整行）。
function splitFields(fields) {
  return {
    ringFields: fields.filter((f) => !f.options),
    optionFields: fields.filter((f) => !!f.options),
  }
}

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
      effectIcon: EFFECT_ICONS[effectId] || 'solid',
      // 灯效主题色：磁贴图标底/描边走它（与时间轴左轴节点同源）。
      accent: charts.effectColor(effectId),
      fields,
      ...splitFields(fields),
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

// 刻度轴展开/收起动画时长（ms）：与 pin-detail.wxss 的 .gauge--* 关键帧保持一致。
// 收起时先把 gauge 置空、把快照放进 gaugeClosing 播完动画再摘掉节点，
// 展开则直接挂载（高 0 → auto 用 grid-template-rows 过渡）。
const GAUGE_ANIM_MS = 200

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
    // 灯组磁贴面板（点顶部灯组药丸打开）：与灯效面板同款底部弹板。
    groupPickerOpen: false,
    // 灯组配置弹窗（长按灯组 Tab 打开）：名称 + 灯珠范围拖选内嵌其中。
    groupConfigOpen: false,
    // 竖向时间轴左轴的派生数据：每段起始时刻(s) / 节点环色 / 是否两格都空。
    stepAxis: [],
    // 当前灯组总时长(s)：阶段标题右侧展示。
    stepsTotal: 0,
    // 新增阶段的进入动画标记（该下标播放一次淡入后清除）。
    enterIndex: -1,
    // 展开中的刻度轴：{ si, li, kind, name, label, min, max, steps,
    //   value, readout, ratio }。kind = 'duration' | 'param'，
    //   kind === 'param' 时轴渲染在 li 这张图层卡片内；duration 渲染在阶段卡片底部。
    //   同一时刻只开一个，切走/删除/换灯组都会收起。
    gauge: null,
    // 正在收起的那条轴的快照：播完收缩动画后置 null（WXML 据此保留节点）。
    gaugeClosing: null,
    // 灯效磁贴面板：effectPickerOpen + 目标定位（si/li）。点卡头图标方块打开，
    // 选一个灯效后按 schema 重建参数区（ADR-0018）。
    effectPickerOpen: false,
    effectPickerTarget: null,
    // 面板里高亮"当前灯效"用：目标图层的 effect id（打开时写入）。
    currentEffectId: 0,
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
    // 静态选项：灯效磁贴面板的数据源（id/label/icon）
    effectOptions: EFFECT_OPTIONS,
    // 上限透传给 WXML（避免模板里硬编码 5/2 与 JS 校验漂移）。
    groupsPerPinMax: LIMITS.groupsPerPinMax,
    stepsPerGroupMax: LIMITS.stepsPerGroupMax,
    layersPerStepMax: LIMITS.layersPerStepMax,
  },

  onLoad(options) {
    const q = options || {}
    const pin = Number(q.pin)
    const app = getApp()
    this._deviceId = (app && app.globalData && app.globalData.currentDeviceId) || null
    _uidSeq = 1
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
    if (this._offSync) this._offSync()
    // 收起动画的定时器：卸载后不该再回调 setData。
    this._clearGaugeTimer()
    this._syncUnloadGuard()
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
      dragging: false,
      dragRange: null,
      inCancelZone: false,
    })
    // 初始灯珠网格按 activeGroup=0 渲染，含其他组占用灰显。
    this.setData({ ledCells: this._buildLedCells(groups[0], ledCount, this._computeOccupied(0), null) })
    this._refreshStepAxis()
  },

  // ---- 阶段排序 --------------------------------------------------------------

  // 卡片内 ↑↓：与相邻阶段交换位置，保持同一阶段在视线上跟手（列表顺序即播放顺序）。
  // 用上下移动按钮而不是拖动：纵向拖动与页面滚动手势冲突，且小程序无法阻止滚动抢占。
  onMoveStep(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const dir = Number(ds.dir)
    const steps = this.data.groups[this.data.activeGroup].steps
    const to = si + dir
    if (!steps[si] || to < 0 || to >= steps.length || !dir) return
    this._editActiveGroup((group, arr) => {
      const moved = arr.splice(si, 1)[0]
      arr.splice(to, 0, moved)
    })
    this._resetGauge()
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  // ---- 刻度轴（圆环 = 参数，点开后在卡片下方展开轴） --------------------------

  // 点数值圆环：展开/收起该参数的刻度轴。同一枚环再点一次收起；点别的环直接换过去。
  // 阶段时长也走这条路径（kind='duration'），圆环就是左轴上的那个节点——
  // 参数轴渲染在所属图层卡片内（不再往阶段卡片底部另起一块）。
  onToggleGauge(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const kind = ds.kind || 'param'
    const li = Number(ds.li)
    const name = ds.name || ''
    const cur = this.data.gauge
    if (cur && cur.si === si && cur.kind === kind && cur.li === li && cur.name === name) {
      this._closeGauge()
      return
    }
    const step = this.data.groups[this.data.activeGroup].steps[si]
    if (!step) return
    let gauge
    if (kind === 'duration') {
      gauge = this._durationGauge(si, step)
    } else {
      const layer = step.layers[li]
      const field = layer && (layer.fields || []).find((f) => f.name === name)
      if (!field || field.type === 'rgb' || field.options) return // 色盘走弹层，枚举走选项卡
      gauge = this._paramGauge(si, li, field)
    }
    if (!gauge) return
    this._openGauge(gauge)
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  _openGauge(gauge) {
    this._clearGaugeTimer()
    this.setData({ gauge, gaugeClosing: null })
  },

  // 收起刻度轴：gauge 立刻置空（各处都按"没有开着的轴"判断），
  // 快照交给 gaugeClosing 播一次收缩动画，之后摘掉节点。
  _closeGauge() {
    const cur = this.data.gauge
    if (!cur) return
    this._clearGaugeTimer()
    this.setData({ gauge: null, gaugeClosing: cur })
    this._gaugeTimer = setTimeout(() => {
      this._gaugeTimer = null
      this.setData({ gaugeClosing: null })
    }, GAUGE_ANIM_MS)
  },

  // 结构性改动（换组/删段/删图层/换灯效）直接清掉轴，不播动画。
  _resetGauge() {
    this._clearGaugeTimer()
    this.setData({ gauge: null, gaugeClosing: null })
  },

  _clearGaugeTimer() {
    if (this._gaugeTimer) {
      clearTimeout(this._gaugeTimer)
      this._gaugeTimer = null
    }
  },

  // 阶段时长刻度轴。时长没有"图层"，渲染在阶段卡片底部。
  _durationGauge(si, step) {
    const min = LIMITS.stepDurationMin
    const max = LIMITS.stepDurationMax
    const value = clamp(step.duration, min, max)
    return {
      si,
      li: -1,
      kind: 'duration',
      name: 'duration',
      label: '时长',
      min,
      max,
      steps: max - min + 1,
      value,
      // 时长读数是秒：1-60s 换算成百分比反而看不出还剩多久。
      readout: `${value}s`,
      ratio: gaugeRatioOf(value, min, max),
    }
  },

  // 灯效参数刻度轴（都是连续量，刻度不排数字，只留一条线与手柄）。
  _paramGauge(si, li, field) {
    const value = clamp(field.value, field.min, field.max)
    const ratio = gaugeRatioOf(value, field.min, field.max)
    return {
      si,
      li,
      kind: 'param',
      name: field.name,
      label: field.label,
      min: field.min,
      max: field.max,
      steps: field.steps,
      value,
      readout: `${percentOfRatio(ratio)}%`,
      ratio,
    }
  },

  // 刻度轴拖动：像素位置 → 量程比例 → 量化后的值，实时写回 VM 并同步圆环。
  // 拖动中 silent（不下发）；松手由 onGaugeTouchEnd 落盘。
  _applyGaugeX(touchX) {
    const gauge = this.data.gauge
    if (!gauge || !this._gaugeRect || !this._gaugeRect.width) return
    const ratio = (touchX - this._gaugeRect.left) / this._gaugeRect.width
    const value = gaugeValueAt(ratio, gauge.min, gauge.max, gauge.steps)
    if (value === gauge.value) return
    const nextRatio = gaugeRatioOf(value, gauge.min, gauge.max)
    this.setData({
      'gauge.value': value,
      'gauge.ratio': nextRatio,
      'gauge.readout': gauge.kind === 'duration' ? `${value}s` : `${percentOfRatio(nextRatio)}%`,
    })
    this._writeGauge(value, { silent: true })
  },

  // 把刻度轴的值写回该量的真相源：时长写 step.duration，参数写 field.value。
  // 参数写回后重算该图层的圆环/百分比文字/摘要（refreshLayerCard），环与数字才算同步。
  _writeGauge(value, opts) {
    const gauge = this.data.gauge
    if (!gauge) return
    const si = gauge.si
    if (gauge.kind === 'duration') {
      this._editActiveGroup((group, steps) => {
        steps[si] = Object.assign({}, steps[si], { duration: clamp(value, LIMITS.stepDurationMin, LIMITS.stepDurationMax) })
      }, opts)
      return
    }
    const li = gauge.li
    const name = gauge.name
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields.find((fd) => fd.name === name))
      if (!f || f.type === 'rgb') return
      applyNumberFieldValue(f, clamp(value, f.min, f.max))
      const idx = fields.findIndex((fd) => fd.name === name)
      fields[idx] = f
      layer.fields = fields
      layers[li] = refreshLayerCard(layer)
      steps[si] = Object.assign({}, steps[si], { layers })
    }, opts)
  },

  // 刻度轴按下：量定轴宽（后续拖动按它换算比例），并立即吸附到手指位置。
  onGaugeTouchStart(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    const query = wx.createSelectorQuery()
    query.in(this)
    query.select('.gauge__track').boundingClientRect()
    query.exec((res) => {
      this._gaugeRect = (res && res[0]) || null
      if (this._gaugeRect) this._applyGaugeX(t.clientX || 0)
    })
  },

  onGaugeTouchMove(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || {}
    this._applyGaugeX(t.clientX || 0)
  },

  // 松手：把当前值正式落盘并下发一次（拖动期间一直 silent）。
  onGaugeTouchEnd() {
    const gauge = this.data.gauge
    if (!gauge) return
    this._writeGauge(gauge.value, undefined)
  },

  // 点空槽：在该槽位新建图层。
  // 换灯效走原生 picker（见 WXML 的 layer-row__effect），不用 showActionSheet：
  // 灯效有 8 种，而 showActionSheet 的 itemList 上限是 6 项。
  onLayerCardTap(e) {
    const si = Number(e.currentTarget.dataset.si)
    const li = Number(e.currentTarget.dataset.li)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    const layer = step && step.layers && step.layers[li]
    if (!layer || !layer.empty) return
    this.onAddLayer(e)
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
    this._refreshStepAxis()
    // 刻度轴开着且改的是正在调的那个量 → 位置/文本已由拖动处就地更新，无需再算。
    if (!(opts && opts.silent)) this._markDirty()
  },

  // 竖向时间轴左轴的派生数据：每段起始时刻 = 前序 duration 累加（含本段时长），
  // 节点环色取该段首个图层灯效的主题色（空阶段给空串，由 CSS 兜底灰环）。
  _refreshStepAxis() {
    const group = this.data.groups[this.data.activeGroup]
    const steps = (group && group.steps) || []
    let acc = 0
    const stepAxis = steps.map((step) => {
      const layers = step.layers || []
      const first = layers.find((l) => l && !l.empty && l.effect)
      const axis = {
        startAt: Math.round(acc * 10) / 10,
        color: first ? charts.effectColor(first.effect) : '',
        allEmpty: !first,
      }
      acc += Math.max(0.1, Number(step.duration) || 1)
      return axis
    })
    this.setData({ stepAxis, stepsTotal: Math.round(acc * 10) / 10 })
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
    this._clearGaugeTimer()
    this.setData({ activeGroup: index, gauge: null, gaugeClosing: null, dragging: false, dragRange: null, inCancelZone: false })
    this.setData({ ledCells: this._buildLedCells(this.data.groups[index], this.data.ledCount, this._computeOccupied(index), null) })
    this._refreshStepAxis()
  },

  // 点灯组药丸：打开灯组磁贴面板（与灯效面板同款底部弹板）。
  onOpenGroupPicker() {
    if (!this.data.groups.length) return
    this.setData({ groupPickerOpen: true })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  onCloseGroupPicker() {
    this.setData({ groupPickerOpen: false })
  },

  // 磁贴面板里选一个灯组：面板收起后切组（重建灯珠网格与时间轴）。
  onPickGroup(e) {
    const index = Number(e.currentTarget.dataset.group)
    this.setData({ groupPickerOpen: false })
    this._activateGroup(index)
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
    // 新卡片播放一次淡入；新阶段在最底部，滚动落点交给系统即可。
    this._resetGauge()
    this.setData({ enterIndex: newSi })
    setTimeout(() => {
      if (this.data.enterIndex === newSi) this.setData({ enterIndex: -1 })
    }, 300)
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
    this._resetGauge()
  },

  onStageNameInput(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = e.detail.value
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { name: v })
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
    this._resetGauge()
  },

  // 点卡头灯效方块：打开磁贴面板（8 种灯效一屏铺开，比原生 picker 好认）。
  onOpenEffectPicker(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    const layer = step && step.layers && step.layers[li]
    if (!layer || layer.empty) return
    this._clearGaugeTimer()
    this.setData({
      effectPickerOpen: true,
      effectPickerTarget: { si, li },
      currentEffectId: layer.effect,
      gauge: null,
      gaugeClosing: null,
    })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  onCloseEffectPicker() {
    this.setData({ effectPickerOpen: false, effectPickerTarget: null })
  },

  // 磁贴面板里选一个灯效：面板收起，参数区按新 schema 重建。
  onPickEffect(e) {
    const id = Number(e.currentTarget.dataset.effect)
    const target = this.data.effectPickerTarget || {}
    if (!Number.isFinite(target.si) || !Number.isFinite(target.li)) return
    this.setData({ effectPickerOpen: false, effectPickerTarget: null })
    this._selectEffect(target.si, target.li, id)
  },

  // 换灯效的唯一写入口：只换 effect/params，槽位与 lid 保持不变（位置语义，ADR-0033）。
  _selectEffect(si, li, effectId) {
    if (!effectId) return
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const old = layers[li]
      if (!old || old.empty) return
      layers[li] = makeLayer(effectId, null, old.lid, old.slot)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
    this._resetGauge()
  },

  // 枚举参数选项卡：点一下直接换档（不再拖刻度轴），并收起已开着的轴。
  onPickOption(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const name = ds.name || ''
    const optIndex = Number(ds.index)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    const layer = step && step.layers && step.layers[li]
    const field = layer && (layer.fields || []).find((f) => f.name === name)
    if (!field || !field.options || !Number.isFinite(optIndex)) return
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const next = Object.assign({}, layers[li])
      const fields = next.fields.slice()
      const f = Object.assign({}, fields.find((fd) => fd.name === name))
      applyNumberFieldValue(f, f.min + optIndex)
      const idx = fields.findIndex((fd) => fd.name === name)
      fields[idx] = f
      next.fields = fields
      layers[li] = refreshLayerCard(next)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
    this._resetGauge()
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
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