// Jest 单测：home 页的层叠/命中区约束（纯 CSS 断言）。
//
// 为什么需要它：亮度竖条展开后要能接收滑动。曾出现两次「点了没反应 / 滑不动」，
// 都不是 JS 逻辑错，而是样式让它收不到事件：
//   1. 竖条被困在 .hero__controls（z-index: 3，自成层叠上下文）里，
//      自身 z-index 再高也只是层内比较，被 z-index: 35 的遮罩盖住 → 滑动落到遮罩上，
//      页面跟着滚。
//   2. 遮罩在控制层之上时，点空白收起与点竖条拖动必须同时成立 → 需要
//      pointer-events 分工。
// 这些都不体现在 JS 行为里，只能对样式做断言。

'use strict'

const fs = require('fs')
const path = require('path')

const WXSS = path.join(__dirname, '../pages/home/home.wxss')
const WXML = path.join(__dirname, '../pages/home/home.wxml')

// 取某个选择器的声明块。选择器可能跨多行书写（多选择器分组），
// 所以按"归一化空白后"匹配。先剥掉注释——注释里出现的花括号会把块切错。
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

// 取块内某属性值（去掉分号与空白）。
function prop(block, name) {
  const m = block.match(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : ''
}

function num(value) {
  const m = String(value).match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : NaN
}

describe('home 页层叠与命中区约束', () => {
  let css
  let wxml

  beforeEach(() => {
    css = fs.readFileSync(WXSS, 'utf8')
    wxml = fs.readFileSync(WXML, 'utf8')
  })

  test('遮罩与"抬起"的控制层都在，且控制层高于遮罩', () => {
    const maskZ = num(prop(ruleBody(css, '.brightness-mask'), 'z-index'))
    const liftedZ = num(prop(ruleBody(css, '.hero__controls--lifted'), 'z-index'))
    expect(Number.isFinite(maskZ)).toBe(true)
    expect(Number.isFinite(liftedZ)).toBe(true)
    // 展开时竖条必须比遮罩更靠上，否则滑动会被遮罩吃掉（页面滚动的根因）。
    expect(liftedZ).toBeGreaterThan(maskZ)
  })

  test('基础控制层不高于遮罩（收起态没有遮罩，此条防止有人用抬高控件来"解决"）', () => {
    const baseZ = num(prop(ruleBody(css, '.hero__controls'), 'z-index'))
    const maskZ = num(prop(ruleBody(css, '.brightness-mask'), 'z-index'))
    expect(baseZ).toBeLessThan(maskZ)
  })

  test('抬起的控制层让空白穿透，但竖条与开关本体仍可点', () => {
    const lifted = ruleBody(css, '.hero__controls--lifted')
    expect(prop(lifted, 'pointer-events')).toBe('none')

    // 竖条与开关各自恢复 auto —— 否则「点空白收起」会失效或竖条点不到。
    const barRule = ruleBody(css, '.hero__controls--lifted .hero__bar')
    const powerRule = ruleBody(css, '.hero__controls--lifted .hero__power')
    expect(prop(barRule, 'pointer-events')).toBe('auto')
    expect(prop(powerRule, 'pointer-events')).toBe('auto')
  })

  test('展开的竖条用 fixed 居中，且不被舞台 overflow 裁切', () => {
    const hero = ruleBody(css, '.hero')
    expect(prop(hero, 'overflow')).toBe('hidden')

    // fixed 的包含块要留在视口：祖先不能有 transform / filter / perspective。
    // 否则 fixed 会退化成相对该祖先定位，被 overflow: hidden 裁掉头尾。
    for (const name of ['transform', 'filter', 'perspective', 'will-change', 'contain']) {
      expect(prop(hero, name)).toBe('')
    }

    const open = ruleBody(css, '.hero__bar--open')
    expect(prop(open, 'position')).toBe('fixed')
    expect(prop(open, 'left')).toMatch(/50/)
    expect(prop(open, 'top')).toMatch(/50/)
  })

  test('展开态由 brightnessExpanded 驱动（同时抬层 + 出遮罩）', () => {
    // 抬层与遮罩必须同生同灭，否则要么滑不动、要么点不回去。
    expect(wxml).toMatch(/brightnessExpanded \? 'hero__controls--lifted'/)
    expect(wxml).toMatch(/wx:if="\{\{brightnessExpanded\}\}"[\s\S]{0,80}brightness-mask/)
  })

  test('竖条绑的是 catch 触摸事件，滑动不会冒泡去滚页面', () => {
    // 用 catchtouchmove（不是 bindtouchmove）：必须阻断冒泡，否则滑亮度会带着页面滚。
    expect(wxml).toMatch(/catchtouchmove="onBrightnessDrag"/)
    // 点击不再依赖 tap（节点 catch 了触摸事件链，tap 不保证合成），改由 touchend 判定。
    expect(wxml).not.toMatch(/catchtap="onBrightnessTap"/)
  })
})
