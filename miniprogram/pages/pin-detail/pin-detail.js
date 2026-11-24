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
  return { gid: uid(), name: name || '灯组 1', ledStart: 0, ledEnd: 9, steps: [defaultStep()] }
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
    // 灯组 Tab
    groups: [], // VM 数组
    activeGroup: 0,
    // 灯珠范围点选：'start' 下一次点设起点，'end' 下一次点设终点
    picking: 'start',
    ledCells: [], // [{ i, on }] 渲染用（避免 WXML 里写表达式）
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
    const groups =
      pinEntry && Array.isArray(pinEntry.groups) && pinEntry.groups.length
        ? pinEntry.groups.map((g, i) => groupToVM(g, i))
        : [defaultGroup('灯组 1')]

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
      picking: 'start',
      dirty: false,
      ledCells: this._buildLedCells(groups[0], ledCount),
    })
  },

  // 灯珠网格渲染模型：i 在 [start,end] 内点亮。
  _buildLedCells(group, ledCount) {
    const cells = []
    const start = group ? group.ledStart : 0
    const end = group ? group.ledEnd : -1
    for (let i = 0; i < ledCount; i++) cells.push({ i, on: i >= start && i <= end })
    return cells
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

  // ---- 灯组 Tab ---------------------------------------------------------------

  onTapGroup(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!this.data.groups[index]) return
    this.setData({ activeGroup: index, picking: 'start' })
    this.setData({ ledCells: this._buildLedCells(this.data.groups[index], this.data.ledCount) })
  },

  onAddGroup() {
    const groups = this.data.groups.slice()
    if (groups.length >= LIMITS.groupsPerPinMax) {
      wx.showToast({ title: `每引脚最多 ${LIMITS.groupsPerPinMax} 个灯组`, icon: 'none' })
      return
    }
    const g = defaultGroup(`灯组 ${groups.length + 1}`)
    groups.push(g)
    this.setData({ groups, activeGroup: groups.length - 1, picking: 'start' })
    this.setData({ ledCells: this._buildLedCells(g, this.data.ledCount) })
    this._markDirty()
  },

  onDeleteGroup(e) {
    const index = Number(e.currentTarget.dataset.index)
    const groups = this.data.groups
    if (groups.length <= 1) {
      wx.showToast({ title: '至少保留一个灯组', icon: 'none' })
      return
    }
    wx.showModal({
      title: '删除灯组',
      content: `确定删除「${groups[index].name}」？`,
      success: (res) => {
        if (!res.confirm) return
        const next = groups.slice()
        next.splice(index, 1)
        const activeGroup = Math.min(this.data.activeGroup, next.length - 1)
        this.setData({ groups: next, activeGroup, picking: 'start' })
        this.setData({ ledCells: this._buildLedCells(next[activeGroup], this.data.ledCount) })
        this._markDirty()
      },
    })
  },

  onGroupNameInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const groups = this.data.groups.slice()
    if (!groups[index]) return
    groups[index] = Object.assign({}, groups[index], { name: e.detail.value })
    this.setData({ groups })
    this._markDirty()
  },

  // ---- 灯珠范围点选 -----------------------------------------------------------

  onTapLed(e) {
    const i = Number(e.currentTarget.dataset.i)
    const group = Object.assign({}, this.data.groups[this.data.activeGroup])
    let picking
    if (this.data.picking === 'start') {
      group.ledStart = i
      if (group.ledEnd < i) group.ledEnd = i
      picking = 'end'
    } else {
      group.ledEnd = i
      if (group.ledEnd < group.ledStart) {
        // 反向点选：交换起止，保证 [start,end] 合法。
        const t = group.ledStart
        group.ledStart = group.ledEnd
        group.ledEnd = t
      }
      picking = 'start'
    }
    const groups = this.data.groups.slice()
    groups[this.data.activeGroup] = group
    this.setData({ groups, picking })
    this.setData({ ledCells: this._buildLedCells(group, this.data.ledCount) })
    this._markDirty()
  },

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

  // 参数输入：定位到 steps[si].layers[li].fields[fi]（rgb 再按通道 ch）。
  onParamInput(e) {
    const ds = e.currentTarget.dataset
    const si = Number(ds.si)
    const li = Number(ds.li)
    const fi = Number(ds.fi)
    const ch = ds.ch !== undefined ? Number(ds.ch) : null
    const raw = e.detail.value
    this._editActiveGroup((group, steps) => {
      const layers = steps[si].layers.slice()
      const layer = Object.assign({}, layers[li])
      const fields = layer.fields.slice()
      const field = Object.assign({}, fields[fi])
      if (field.type === 'rgb') {
        const arr = field.value.slice()
        arr[ch] = clamp(raw, 0, 255)
        field.value = arr
      } else {
        field.value = clamp(raw, field.min, field.max)
      }
      fields[fi] = field
      layer.fields = fields
      layers[li] = layer
      steps[si] = Object.assign({}, steps[si], { layers })
    })
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