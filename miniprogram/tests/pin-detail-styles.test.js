// Jest 单测：pin-detail 竖向时间轴的布局约束（纯 CSS 断言）。
//
// 为什么需要它：左轴「时刻 / 节点 / 连线」三件套要连成一条不断开的线，靠的全是
// flex 几何，行为测试看不到：
//   1. 行容器必须 stretch，左轴列才能撑满整行高——改成 center 后连线会缩成一小段，
//      每张卡片下方断开一截，视觉上时间轴散架。
//   2. 连线必须 flex:1 且有 min-height，否则短卡片行里连线退化成 0 高（完全不可见）。
//   3. 卡片与轴之间不留 margin-top：节点要对齐卡片内序号行，靠的是 .tl-axis__time
//      的 margin-top 与 .tl-card 的 margin 配对，单边改就会错位。

'use strict'

const fs = require('fs')
const path = require('path')

const WXSS = path.join(__dirname, '../pages/pin-detail/pin-detail.wxss')
const WXML = path.join(__dirname, '../pages/pin-detail/pin-detail.wxml')

// 取某个选择器的声明块（多选择器分组、跨行书写都按归一化空白后匹配）。
// 先剥注释——注释里的花括号会把块切错。
function ruleBody(css, selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const target = norm(selector)
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(stripped))) {
    const selectors = m[1]
      .split(',')
      .map(norm)
      .filter(Boolean)
    if (selectors.includes(target)) return m[2]
  }
  throw new Error(`样式里找不到 ${selector}`)
}

function prop(block, name) {
  const m = block.match(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : ''
}

describe('pin-detail 竖向时间轴布局约束', () => {
  let css
  let wxml

  beforeEach(() => {
    css = fs.readFileSync(WXSS, 'utf8')
    wxml = fs.readFileSync(WXML, 'utf8')
  })

  test('行容器 stretch：左轴列才能撑满整行，连线连到下一节点', () => {
    expect(prop(ruleBody(css, '.tl-row'), 'align-items')).toBe('stretch')
    // 左轴列纵向排布（时刻 → 节点 → 连线）。
    expect(prop(ruleBody(css, '.tl-axis'), 'flex-direction')).toBe('column')
  })

  test('连线撑满剩余高度并留有最小长度，否则短卡片行里不可见', () => {
    const line = ruleBody(css, '.tl-axis__line')
    expect(prop(line, 'flex')).toMatch(/^1(\s|$)/)
    expect(prop(line, 'min-height')).not.toBe('')
    expect(prop(line, 'width')).not.toBe('')
  })

  test('节点是圆环：等宽高 + 50% 圆角 + 描边（环色由内联 style 覆盖）', () => {
    const dot = ruleBody(css, '.tl-axis__dot')
    expect(prop(dot, 'border-radius')).toBe('50%')
    expect(prop(dot, 'border')).not.toBe('')
    const w = prop(dot, 'width')
    expect(prop(dot, 'height')).toBe(w)
  })

  test('模板里节点环色是条件内联：有灯效色才写 border-color', () => {
    expect(wxml).toContain('stepAxis[si].color')
    expect(wxml).toMatch(/border-color/)
  })

  test('模板已无旧阶段条 / 甘特 / 气泡卡的选择器与绑定', () => {
    expect(wxml).not.toContain('stage-seg')
    expect(wxml).not.toContain('stage-inner')
    expect(wxml).not.toContain('timeline__')
    expect(wxml).not.toContain('step-bubble')
    expect(wxml).not.toContain('onSelectStage')
  })

  test('升序按钮绑 onMoveStep，方向由 data-dir 传（±1）', () => {
    expect(wxml).toContain('onMoveStep')
    expect(wxml).toContain('data-dir="-1"')
    expect(wxml).toContain('data-dir="1"')
  })

  test('模板已无图层配置弹窗与 3D 预览（改圆环 + 刻度轴）', () => {
    expect(wxml).not.toContain('layerEditorOpen')
    expect(wxml).not.toContain('effect3d')
    expect(wxml).not.toContain('onOpenLayerEditor')
  })

  test('阶段卡片里没有时长滑块与过渡/循环选择器（时长归左轴圆点）', () => {
    expect(wxml).not.toContain('onDurationChange')
    expect(wxml).not.toContain('onTransitionChange')
    expect(wxml).not.toContain('onLoopChange')
    expect(wxml).not.toContain('transitionOptions')
    expect(wxml).not.toContain('loopOptions')
  })

  test('图层纵向一列：.layer-row 不再是两列 calc 宽度', () => {
    const row = ruleBody(css, '.layer-row')
    expect(prop(row, 'width')).toBe('') // 由父级 flex 列决定，不写死两列宽
    expect(ruleBody(css, '.layer-list')).not.toBe('')
  })

  test('参数圆环是细边环：外环 2rpx 挖空，环长由 conic-gradient 驱动', () => {
    const ring = ruleBody(css, '.ring-item__ring')
    expect(prop(ring, 'border-radius')).toBe('50%')
    const w = prop(ring, 'width')
    expect(prop(ring, 'height')).toBe(w)
    // 挖空层四边各 2rpx → 环宽就是 2rpx（细边）
    const hole = ruleBody(css, '.ring-item__hole')
    expect(prop(hole, 'top')).toBe('2rpx')
    expect(prop(hole, 'left')).toBe('2rpx')
    expect(prop(hole, 'right')).toBe('2rpx')
    expect(prop(hole, 'bottom')).toBe('2rpx')
    // 环长来自 WXML 内联 conic-gradient（fld.ring 百分比）——同一行内同时出现即可
    // （不能对括号内做 [^)]* 贪婪，conic-gradient 里还嵌着 var(...)）。
    const gradientLine = wxml.split('\n').find((l) => l.includes('conic-gradient') && l.includes('fld.ring'))
    expect(gradientLine).toBeTruthy()
  })

  test('参数图标：环内 bt-ico 画框小于挖空直径', () => {
    expect(wxml).toMatch(/ring-item__hole[\s\S]{0,200}bt-ico--p-\{\{fld\.icon\}\}/)
    // 挖空直径 60rpx（64 - 2×2），参数图标 28rpx 留出足够内边距。
    const ico = ruleBody(css, '.ring-item__hole .bt-ico')
    expect(prop(ico, 'width')).toBe('28rpx')
    expect(prop(ico, 'height')).toBe('28rpx')
  })

  test('灯效磁贴：卡头是方框图标 + 名称，8 种灯效图标都有定义', () => {
    // 卡头方块 + 面板磁贴共用一套图标，靠 --ico-size 缩放。
    expect(prop(ruleBody(css, '.effect-tile__icon'), '--ico-size')).not.toBe('')
    expect(prop(ruleBody(css, '.pick-card__icon'), '--ico-size')).not.toBe('')
    for (const name of ['solid', 'breath', 'blink', 'marquee', 'rainbow', 'meteor', 'dual', 'rhythm']) {
      expect(css).toContain(`.bt-ico--e-${name}::before`)
    }
    // 面板里每枚磁贴都有图标 + 名称，点它换灯效。
    expect(wxml).toMatch(/pick-card__icon[\s\S]{0,200}pick-card__name/)
    expect(wxml).toContain('onPickEffect')
  })

  test('灯组与灯效共用同一套磁贴面板外壳（不再用原生 picker 下拉）', () => {
    // 两者都走 .pick-mask / .pick-panel / .pick-card，只有网格列数与卡内容不同。
    expect(wxml).toContain('class="pick-mask"')
    expect(wxml).toMatch(/pick-panel__title">选择灯组/)
    expect(wxml).toMatch(/pick-panel__title">选择灯效/)
    // 旧的原生 picker 与独立样式类已清理。
    expect(wxml).not.toContain('mode="selector"')
    expect(wxml).not.toContain('group-select__picker')
    expect(css).not.toContain('.effect-panel')
    expect(css).not.toContain('.effect-card')
    // 5 个灯组单行铺开，不成两行。
    expect(prop(ruleBody(css, '.pick-grid--groups'), 'grid-template-columns')).toBe('repeat(5, 1fr)')
  })

  test('点击只描边高亮，不给内圈染底（否则进度弧 + 染盘会被读成扇形）', () => {
    const on = ruleBody(css, '.ring-item__ring--on')
    expect(prop(on, 'box-shadow')).not.toBe('') // 描边高亮
    // 关键：激活态不得改内圈的 background（进度弧仍是唯一的"填充"）
    const onHole = ruleBody(css, '.ring-item__ring--on .ring-item__hole')
    expect(prop(onHole, 'background')).toBe('')
    // 也不许再放大（放大会让进度弧看起来更像一块饼）
    expect(prop(on, 'transform')).toBe('')
  })

  test('数字轴极简：一行 flex（轴 + 读数），轴上只有手柄', () => {
    const track = ruleBody(css, '.gauge__track')
    expect(prop(track, 'position')).toBe('relative')
    expect(prop(track, 'flex')).toMatch(/^1(\s|$)/)
    // 手柄 left 绑 gauge.ratio；不画进度填充、不排刻度数字。
    expect(wxml).toMatch(/gauge__handle"[^>]*left:\s*\{\{gauge\.ratio/)
    expect(wxml).not.toContain('gauge__fill')
    expect(wxml).not.toContain('gauge__tick')
    expect(wxml).not.toContain('gauge__head')
    // 两段横排，轴吃剩余宽度；名称不再占一列（圆环下那行已有）。
    expect(prop(ruleBody(css, '.gauge'), 'align-items')).toBe('center')
    expect(prop(ruleBody(css, '.gauge__value'), 'flex')).toMatch(/^0/)
    // 轴本身不再是一块 tint 底色卡片，只用分隔线标记"这是卡片内的附加行"。
    expect(prop(ruleBody(css, '.gauge'), 'background')).toBe('')
  })

  test('数字轴展开/收起走高度过渡，容器不再瞬时挪动', () => {
    const slot = ruleBody(css, '.gauge-slot')
    expect(prop(slot, 'grid-template-rows')).toBe('0fr')
    expect(prop(slot, 'transition')).not.toBe('')
    const open = ruleBody(css, '.gauge-slot--open')
    expect(prop(open, 'grid-template-rows')).toBe('1fr')
  })

  test('数值参数的说明文字与百分比同一行（不再分两行）', () => {
    // 模板里环下只有一条 caption（名称 + 值），旧的 label/value 双行已移除。
    expect(wxml).not.toContain('ring-item__label')
    expect(wxml).not.toContain('ring-item__value')
    expect(wxml).toMatch(/ring-item__caption">\{\{fld\.label\}\} \{\{fld\.valueText\}\}/)
  })

  test('枚举参数是选项卡：模板不再给枚举画圆环', () => {
    expect(wxml).toContain('option-tabs__item')
    // 圆环区只遍历 ringFields（数值 + 色盘），枚举走 optionFields。
    expect(wxml).toMatch(/wx:for="\{\{layer\.ringFields\}\}"/)
    expect(wxml).toMatch(/wx:for="\{\{layer\.optionFields\}\}"/)
  })

  test('左轴圆点同时是时长入口：数据绑 kind="duration"', () => {
    expect(wxml).toMatch(/data-kind="duration"[\s\S]{0,200}onToggleGauge/)
  })
})
