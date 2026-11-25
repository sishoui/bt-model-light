// 引脚配置详情页（ADR-0027 / #27 / T7）。
//
// 结构：顶部（图片/名称/开关）+ 灯组 Tab + 灯珠范围点选 + 步骤/图层编辑器
// + 灯效下拉 + 参数表单联动（同页）。修改即推送：任何有效改动落盘 Storage 后
// 经 autoSync 防抖下发固件（WRITE_CONFIG + APPLY），无保存按钮。
// 引脚固定 8 个（硬件不可增删），本页无删除引脚入口。
//
// 编辑态用页面 data（ADR-0023），与已保存态分离。离开拦截仅在同步在途
// （防抖窗口 <500ms）时提示；同步状态经 autoSync.subscribe 驱动顶部状态条。
// 灯效参数 schema 直接消费 protocol_gen 的 EFFECT_PARAMS（与固件 ADR-0018 同源），
// 切换灯效即按 schema 重建参数表单。Storage 真相源经 configCodec 编码下发固件。

const { getDeviceConfig, saveDeviceConfig } = require('../../utils/deviceStore')
const { encodeConfigBlob, validateConfig, effectName, clampInt } = require('../../utils/configCodec')
const { getRecentColors, pushRecentColor, rgbToHex, hexToRgb } = require('../../utils/recentColors')
const { EFF, EFFECT_PARAMS, LIMITS } = require('../../utils/protocol_gen')
const autoSync = require('../../utils/autoSync')

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
    return { name: p.name, label: PARAM_LABELS[p.name] || p.name, type: p.type, min: p.min, max: p.max, value, hex }
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

// ---- 默认模型 + VM 转换 -----------------------------------------------------

let _uidSeq = 1
function uid() {
  return _uidSeq++
}

// 图层 VM：effectName 供 WXML 直接显示（避免依赖 EFF id 连续假设的下标运算）。
function makeLayer(effectId, params, lid) {
  return { lid: lid || uid(), effect: effectId, effectName: EFFECT_LABELS[effectId] || `效果 ${effectId}`, fields: buildParamFields(effectId, params) }
}

function defaultLayer(effectId) {
  return makeLayer(effectId || EFF.SOLID, null)
}

// 阶段默认名：阶段一/二/…（上限 5，超出回退数字）。
const CN_NUMS = ['一', '二', '三', '四', '五']
function stageDefaultName(i) {
  return '阶段' + (CN_NUMS[i] || String(i + 1))
}

// 阶段条分段宽度：最小长度(rpx) + 按时长比例分配剩余宽度（运行时测量容器宽）。

function defaultStep(index) {
  return { sid: uid(), name: stageDefaultName(index || 0), duration: 5, transition: 0, loopMode: 1, layers: [defaultLayer(EFF.SOLID)] }
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
function groupToVM(g, index) {
  return {
    gid: uid(),
    name: g.name || `灯组 ${index + 1}`,
    ledStart: g.ledStart,
    ledEnd: g.ledEnd,
    steps: (g.steps || []).map((s, i) => ({
      sid: uid(),
      name: s.name || stageDefaultName(i),
      duration: s.duration,
      transition: s.transition,
      loopMode: s.loopMode,
      layers: (s.layers || []).map((l) => makeLayer(l.effect, l.params)),
    })),
  }
}

// 页面编辑态 VM → Storage / wire 模型（去掉 gid/sid/lid/fields）。
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
      layers: s.layers.map((l) => ({ effect: l.effect, params: fieldsToParams(l.fields) })),
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
    ledPickerOpen: false, // 灯珠选择弹出层显隐
    // 当前选中的阶段下标（横向阶段条 + 下方详情单页）。
    activeStepSi: 0,
    // 长按拖动排序态：dragIndex 为正在拖动的节点下标（null=未拖），dragX 为其当前位移(rpx)，
    // hoverIndex 为当前悬停落点下标（拖动中其余节点据此实时避让）。
    dragIndex: null,
    dragX: 0,
    hoverIndex: 0,
    // 各节点相对 flex 基础位的位移(rpx)：拖动跟手 / 其余节点避让。
    offsets: {},
    // 各分段宽度(rpx)：按 duration 比例、带最小长度。
    segW: [],
    // 新增节点的进入动画标记（该下标播放一次 scale-in 后清除）。
    enterIndex: -1,
    // 图层折叠状态（独立 data 字段，不污染 groups VM）。
    // 键 "si-li"：si = activeStepSi；默认按图层数决定。
    expandedLayers: {},
    // 颜色弹层（#33）。
    colorPickerOpen: false,
    colorPickerTarget: null, // 目标 field 定位（si/li/fi），随 setData 同步给 WXML
    recentColors: [],
    colorPalette: [
      '#000000', '#FFFFFF', '#808080', '#404040', '#C0C0C0',
      '#FF0000', '#FF8800', '#FFFF00', '#00FF00', '#00FFFF',
      '#0000FF', '#8000FF', '#FF69B4', '#FFDAB9', '#FFBF00', '#008080',
    ],
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
    if (this._offSync) this._offSync()
    this._syncUnloadGuard()
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
      power: !!(pinEntry && pinEntry.power),
      groups,
      activeGroup: 0,
      activeStepSi: 0,
      dragging: false,
      dragRange: null,
      inCancelZone: false,
    })
    // 初始灯珠网格按 activeGroup=0 渲染，含其他组占用灰显。
    this.setData({ ledCells: this._buildLedCells(groups[0], ledCount, this._computeOccupied(0), null) })
  },

  // 图层折叠默认策略：图层数 ≤2 全展开；>2 首层展开、其余收起。
  // 键 si-li（si = activeStepSi）。进入步骤详情时调用。
  _defaultExpandedLayers(group, si) {
    const step = group && group.steps && group.steps[si]
    const count = step ? step.layers.length : 0
    const map = {}
    for (let li = 0; li < count; li++) {
      map[`${si}-${li}`] = count <= 2 || li === 0
    }
    return map
  },

  // ---- 视图导航 --------------------------------------------------------------

  // 轻点阶段节点：选中该阶段，初始化其图层折叠默认态。
  onSelectStage(e) {
    if (this.data.dragIndex !== null) return // 拖动中忽略点击
    const si = Number(e.currentTarget.dataset.si)
    const group = this.data.groups[this.data.activeGroup]
    if (!group || !group.steps[si]) return
    this.setData({
      activeStepSi: si,
      expandedLayers: this._defaultExpandedLayers(group, si),
    })
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
      this.setData({
        activeStepSi: to,
        expandedLayers: this._defaultExpandedLayers(this.data.groups[this.data.activeGroup], to),
      })
    }
    this.setData({ dragIndex: null, dragX: 0, offsets: {} })
  },

  onToggleLayer(e) {
    const si = Number(e.currentTarget.dataset.si)
    const li = Number(e.currentTarget.dataset.li)
    const key = `${si}-${li}`
    const next = Object.assign({}, this.data.expandedLayers, { [key]: !this.data.expandedLayers[key] })
    this.setData({ expandedLayers: next })
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

  // 标记编辑态：组装配置 → 校验 → 落盘 Storage → 安排防抖下发（autoSync）。
  // 校验/编码失败时静默跳过（编辑中间态的瞬时非法是常态，避免刷屏 Toast）。
  _markDirty() {
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
    autoSync.schedule(this._deviceId, config)
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
  _editActiveGroup(mutator) {
    const groups = this.data.groups.slice()
    const group = Object.assign({}, groups[this.data.activeGroup])
    const steps = (group.steps || []).map((s) => Object.assign({}, s))
    mutator(group, steps)
    group.steps = steps
    groups[this.data.activeGroup] = group
    this.setData({ groups })
    this._markDirty()
  },

  // ---- 顶部 -------------------------------------------------------------------

  onPinNameInput(e) {
    this.setData({ pinName: e.detail.value })
    this._markDirty()
  },

  onPowerChange(e) {
    this.setData({ power: e.detail.value })
    this._markDirty()
  },

  // ---- 灯组 Tab（固定 5 个，无新增/删除；tab 小字显示灯珠区间） -------------

  onTapGroup(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!this.data.groups[index]) return
    // 点当前组 Tab：无操作（单页阶段条常驻，无返回列表语义）。
    if (index === this.data.activeGroup) return
    this.setData({ activeGroup: index, activeStepSi: 0, expandedLayers: {}, dragging: false, dragRange: null, inCancelZone: false })
    this.setData({ ledCells: this._buildLedCells(this.data.groups[index], this.data.ledCount, this._computeOccupied(index), null) })
    if (wx.nextTick) wx.nextTick(() => this._measureStage())
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

  onOpenLedPicker() {
    this.setData({ ledPickerOpen: true })
  },

  onCloseLedPicker() {
    if (this.data.dragging) return // 拖选进行中不允许关闭，避免丢失
    this.setData({ ledPickerOpen: false })
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
    // 添加后选中新阶段并初始化其图层折叠默认态；新节点播放一次进入动画。
    const group = this.data.groups[this.data.activeGroup]
    this.setData({
      activeStepSi: newSi,
      enterIndex: newSi,
      expandedLayers: this._defaultExpandedLayers(group, newSi),
    })
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
    const group = this.data.groups[this.data.activeGroup]
    this.setData({
      activeStepSi: nextSi,
      expandedLayers: this._defaultExpandedLayers(group, nextSi),
    })
    if (wx.nextTick) wx.nextTick(() => this._measureStage())
  },

  onStageNameInput(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = e.detail.value
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { name: v })
    })
  },

  onDurationInput(e) {
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

  onAddLayer(e) {
    const si = Number(e.currentTarget.dataset.si)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    if (!step || step.layers.length >= LIMITS.layersPerStepMax) {
      wx.showToast({ title: `每阶段最多 ${LIMITS.layersPerStepMax} 个图层`, icon: 'none' })
      return
    }
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { layers: steps[si].layers.concat([defaultLayer(EFF.SOLID)]) })
    })
    // 新图层折叠态：总数 ≤2 展开（与默认策略一致），>2 收起。
    const newCount = this.data.groups[this.data.activeGroup].steps[si].layers.length
    const expandedLayers = Object.assign({}, this.data.expandedLayers)
    expandedLayers[`${si}-${newCount - 1}`] = newCount <= 2
    this.setData({ expandedLayers })
  },

  onDeleteLayer(e) {
    const si = Number(e.currentTarget.dataset.si)
    const li = Number(e.currentTarget.dataset.li)
    const step = this.data.groups[this.data.activeGroup].steps[si]
    if (!step || step.layers.length <= 1) {
      wx.showToast({ title: '至少保留一个图层', icon: 'none' })
      return
    }
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      layers.splice(li, 1)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
    // 重建该 step 的 layer 键。
    const oldLayers = this.data.expandedLayers || {}
    const newLayers = Object.assign({}, oldLayers)
    // 移除被删图层键
    delete newLayers[`${si}-${li}`]
    // 重新编号后续图层
    const count = this.data.groups[this.data.activeGroup].steps[si].layers.length
    const tmp = {}
    for (let j = 0; j < count; j++) {
      const srcLi = j < li ? j : j + 1
      if (oldLayers[`${si}-${srcLi}`] !== undefined) tmp[`${si}-${j}`] = oldLayers[`${si}-${srcLi}`]
    }
    // 清理该 step 所有旧层键后写入新键
    for (const k of Object.keys(newLayers)) {
      if (k.startsWith(`${si}-`)) delete newLayers[k]
    }
    Object.assign(newLayers, tmp)
    if (newLayers[`${si}-0`] === undefined) newLayers[`${si}-0`] = true
    this.setData({ expandedLayers: newLayers })
  },

  // 切换灯效：重建该图层参数表单（schema 联动，ADR-0018）。
  onEffectChange(e) {
    const si = Number(e.currentTarget.dataset.si)
    const li = Number(e.currentTarget.dataset.li)
    const opt = EFFECT_OPTIONS[Number(e.detail.value)]
    if (!opt) return
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      layers[li] = makeLayer(opt.id, null, layers[li].lid)
      steps[si] = Object.assign({}, steps[si], { layers })
    })
  },

  // 参数输入：标量（u8/u16）走数字。rgb 不再有逐通道 input（色块 + 弹层，#33）。
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
    // 标量（u8/u16）。
    const raw = e.detail.value
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields[fi])
      f.value = clamp(raw, f.min, f.max)
      fields[fi] = f
      layer.fields = fields
      layers[li] = layer
      steps[si] = Object.assign({}, steps[si], { layers })
    })
  },

  // ---- 颜色弹层（#33） ---------------------------------------------------------
  // rgb 色块点击：打开弹层，定位到目标 field，把最近色带入弹层。
  onOpenColorPicker(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    this._locateField(si, li, fi)
    this._colorPickerTarget = { si, li, fi }
    this.setData({ colorPickerOpen: true, colorPickerTarget: { si, li, fi }, recentColors: getRecentColors() })
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
      layers[li] = layer
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