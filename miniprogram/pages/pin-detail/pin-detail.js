// 引脚配置详情页（ADR-0027 / #27 / T7）。
//
// 结构：顶部（图片/名称/开关）+ 灯组 Tab + 灯珠范围点选 + 步骤/图层编辑器
// + 灯效下拉 + 参数表单联动（同页）。保存同时写 Storage + 下发固件 + APPLY。
//
// 编辑态用页面 data（ADR-0023），与已保存态分离，dirty 标志驱动离开拦截。
// 灯效参数 schema 直接消费 protocol_gen 的 EFFECT_PARAMS（与固件 ADR-0018 同源），
// 切换灯效即按 schema 重建参数表单。Storage 真相源经 configCodec 编码下发固件。

const { getCurrentBleClient } = require('../../utils/bleClient')
const { getDeviceConfig, saveDeviceConfig } = require('../../utils/deviceStore')
const { encodeConfigBlob, validateConfig, effectName, clampInt } = require('../../utils/configCodec')
const { friendlyMessage, logError } = require('../../utils/errorHandler')
const { getRecentColors, pushRecentColor, rgbToHex, hexToRgb } = require('../../utils/recentColors')
const { EFF, EFFECT_PARAMS, LIMITS, CMD } = require('../../utils/protocol_gen')

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
    if (p.type === 'rgb') {
      const v = Array.isArray(src[p.name]) ? src[p.name] : defaultParamValue(p)
      value = [clamp(v[0], 0, 255), clamp(v[1], 0, 255), clamp(v[2], 0, 255)]
    } else {
      const v = src[p.name] === undefined ? defaultParamValue(p) : src[p.name]
      value = clamp(v, p.min, p.max)
    }
    return { name: p.name, label: PARAM_LABELS[p.name] || p.name, type: p.type, min: p.min, max: p.max, value }
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

function defaultStep() {
  return { sid: uid(), duration: 5, transition: 0, loopMode: 1, layers: [defaultLayer(EFF.SOLID)] }
}

function defaultGroup(name) {
  // 默认空态：ledStart == ledEnd == 255 哨兵（未选灯珠）。镜像 firmware config.cpp。
  return { gid: uid(), name: name || '灯组 1', ledStart: 0xff, ledEnd: 0xff, steps: [defaultStep()] }
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
    steps: (g.steps || []).map((s) => ({
      sid: uid(),
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
    // 该引脚是否已配置（决定是否展示"删除引脚"；新建未保存的引脚不可删）。
    configured: false,
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
    dirty: false,
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
    this._loadFromStore(Number.isFinite(pin) ? pin : 0)
    this.setData({ simMode: !!(app && app.globalData && app.globalData.simMode) })
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
      power: !!(pinEntry && pinEntry.power),
      configured: !!(pinEntry && pinEntry.configured),
      groups,
      activeGroup: 0,
      dragging: false,
      dragRange: null,
      inCancelZone: false,
      dirty: false,
    })
    // 初始灯珠网格按 activeGroup=0 渲染，含其他组占用灰显。
    this.setData({ ledCells: this._buildLedCells(groups[0], ledCount, this._computeOccupied(0), null) })
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

  // 标记编辑态（任何改动调用）；驱动离开拦截。
  _markDirty() {
    if (!this.data.dirty) this.setData({ dirty: true })
    this._syncUnloadGuard()
  },

  _syncUnloadGuard() {
    // 有未保存改动时开启离开确认（真机 wx API；Jest mock 里为 no-op 桩）。
    if (typeof wx !== 'undefined' && wx.enableAlertBeforeUnload) {
      if (this.data.dirty) wx.enableAlertBeforeUnload({ message: '有未保存的修改，确定离开？' })
      else wx.disableAlertBeforeUnload({})
    }
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
    this.setData({ activeGroup: index, dragging: false, dragRange: null, inCancelZone: false })
    this.setData({ ledCells: this._buildLedCells(this.data.groups[index], this.data.ledCount, this._computeOccupied(index), null) })
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
      wx.showToast({ title: `每灯组最多 ${LIMITS.stepsPerGroupMax} 个步骤`, icon: 'none' })
      return
    }
    this._editActiveGroup((group, steps) => {
      steps.push(defaultStep())
    })
  },

  onDeleteStep(e) {
    const si = Number(e.currentTarget.dataset.si)
    if (this.data.groups[this.data.activeGroup].steps.length <= 1) {
      wx.showToast({ title: '至少保留一个步骤', icon: 'none' })
      return
    }
    this._editActiveGroup((group, steps) => {
      steps.splice(si, 1)
    })
  },

  onDurationInput(e) {
    const si = Number(e.currentTarget.dataset.si)
    const v = clamp(e.detail.value, LIMITS.stepDurationMin, LIMITS.stepDurationMax)
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { duration: v })
    })
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
      wx.showToast({ title: `每步骤最多 ${LIMITS.layersPerStepMax} 个图层`, icon: 'none' })
      return
    }
    this._editActiveGroup((group, steps) => {
      steps[si] = Object.assign({}, steps[si], { layers: steps[si].layers.concat([defaultLayer(EFF.SOLID)]) })
    })
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

  // 参数输入：rgb 走 hex（颜色弹层，#33），标量（u8/u16）走数字。
  // 兼容两种 rgb 入口：
  //   - 数字通道（data-ch 存在）：旧三通道 input，按通道写入 field.value[ch]。
  //   - hex（data-ch 不存在）：颜色弹层选中回调，hex → rgb 写入 + 持久化最近色。
  onParamInput(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    const field = this._locateField(si, li, fi)
    if (!field) return
    const raw = e.detail.value
    if (field.type === 'rgb') {
      if (ds.ch !== undefined) {
        // 数字通道写入（旧入口，保留兼容）。
        const ch = Number(ds.ch)
        this._editActiveGroup((group, steps) => {
          const layers = steps[si].layers.slice()
          const layer = Object.assign({}, layers[li])
          const fields = layer.fields.slice()
          const f = Object.assign({}, fields[fi])
          const arr = f.value.slice()
          arr[ch] = clamp(raw, 0, 255)
          f.value = arr
          fields[fi] = f
          layer.fields = fields
          layers[li] = layer
          steps[si] = Object.assign({}, steps[si], { layers })
        })
        return
      }
      // hex 入口（颜色弹层，#33 接入）。
      this._applyColorHex(si, li, fi, raw)
      return
    }
    // 标量（u8/u16）。
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

  // 颜色弹层选中回调（#33 接入）：hex → rgb 写入 + 最近色持久化。
  onColorPicked(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    const hex = (e.detail && e.detail.value) || ds.hex || ''
    this._applyColorHex(si, li, fi, hex)
  },

  // 单一选色应用点：hex 校验 → rgb 写入 field.value → 持久化最近色。
  // onParamInput hex 分支与 onColorPicked 共用，避免重复。
  _applyColorHex(si, li, fi, hex) {
    const rgb = hexToRgb(String(hex || ''))
    if (!rgb) return
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const f = Object.assign({}, fields[fi])
      f.value = rgb
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

  // ---- 保存 -------------------------------------------------------------------

  // 组装整设备配置（保留其他引脚），校验 → 写 Storage → 下发 WRITE_CONFIG + APPLY。
  onSave() {
    if (!this._deviceId) {
      wx.showToast({ title: '未选择设备', icon: 'none' })
      return
    }
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
    if (verr) {
      wx.showToast({ title: verr.message, icon: 'none' })
      return
    }
    let blob
    try {
      blob = encodeConfigBlob(config)
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '配置编码失败', icon: 'none' })
      return
    }

    // Storage 为真相源：先落盘（即使 BLE 未连接也保住编辑）。
    saveDeviceConfig(this._deviceId, config)
    this.setData({ dirty: false })
    this._syncUnloadGuard()

    const client = getCurrentBleClient()
    if (!client || !client.connected) {
      // Storage 是真相源已落盘；固件需连接后重新保存才会同步（无自动补发）。
      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: '已保存到本机（设备未连接，连接后请重新保存以同步）', icon: 'none' })
      return
    }
    this._pushToFirmware(client, blob)
  },

  // WRITE_CONFIG（配置 blob）→ APPLY（即时播放）。顺序下发，失败给 Toast。
  async _pushToFirmware(client, blob) {
    wx.showLoading({ title: '下发中' })
    try {
      await client.sendCmd(CMD.WRITE_CONFIG, Array.from(blob))
      await client.sendCmd(CMD.APPLY, [])
      wx.hideLoading()
      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: '已保存并应用', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      logError(err, '下发配置')
      wx.showToast({ title: `已保存到本地，下发失败：${friendlyMessage(err)}`, icon: 'none' })
    }
  },

  // ---- 删除引脚 ---------------------------------------------------------------

  // 删除整个引脚：从本机配置移除 → 落盘（真相源）→ 已连接则下发固件同步 → 返回。
  // 仅对已配置引脚开放（WXML 按 configured 显隐），未保存的新引脚无需删除。
  onDeletePin() {
    if (!this._deviceId) {
      wx.showToast({ title: '未选择设备', icon: 'none' })
      return
    }
    const pin = this.data.pin
    wx.showModal({
      title: '删除引脚',
      content: `确定删除「${this.data.pinName}」？该引脚下的灯组配置将一并清除。`,
      success: (res) => {
        if (!res.confirm) return
        const base = getDeviceConfig(this._deviceId)
        const pins = (base && Array.isArray(base.pins) ? base.pins : []).filter(
          (p) => p && p.pin !== pin
        )
        const config = { version: 1, pins }

        const verr = validateConfig(config)
        if (verr) {
          wx.showToast({ title: verr.message, icon: 'none' })
          return
        }
        let blob
        try {
          blob = encodeConfigBlob(config)
        } catch (err) {
          wx.showToast({ title: (err && err.message) || '配置编码失败', icon: 'none' })
          return
        }

        // Storage 为真相源：先落盘并解除离开拦截（返回时不再弹未保存确认）。
        saveDeviceConfig(this._deviceId, config)
        this.setData({ dirty: false })
        this._syncUnloadGuard()

        const client = getCurrentBleClient()
        if (!client || !client.connected) {
          wx.showToast({ title: '已删除（本机）', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 500)
          return
        }
        this._pushDeleteToFirmware(client, blob)
      },
    })
  },

  // 删除后的下发链路：WRITE_CONFIG（移除该引脚）→ APPLY → 返回首页。
  // 本机已删除；下发失败不阻塞返回（连接后重新保存其它引脚即可同步）。
  async _pushDeleteToFirmware(client, blob) {
    wx.showLoading({ title: '下发中' })
    try {
      await client.sendCmd(CMD.WRITE_CONFIG, Array.from(blob))
      await client.sendCmd(CMD.APPLY, [])
      wx.hideLoading()
      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: '已删除并应用', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    } catch (err) {
      wx.hideLoading()
      logError(err, '删除引脚')
      wx.showToast({ title: `已删除本机，下发失败：${friendlyMessage(err)}`, icon: 'none' })
      setTimeout(() => wx.navigateBack(), 500)
    }
  },
})