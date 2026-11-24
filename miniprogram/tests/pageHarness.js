// 页面测试公共装载器：把页面 js 的 Page({...}) 定义转成可调用实例。
//
// 小程序页面在运行时由框架调用生命周期（onShow 等）。测试里我们：
//   1. 调用方 beforeEach 装 wx mock（installWxMock）
//   2. 全局 getApp() 返回测试注入的 app 桩
//   3. 捕获 Page() 注册的定义，绑定生命周期方法 + setData 后返回实例
//
// 页面模块经 jest.isolateModules 加载：与测试文件直接 require 的 utils 副本
// 相互独立，但 bleClient 单例存全局 slot（__btBleClient），页面副本也能
// 取到测试注入的实例——这是页面级 BLE 交互可被测试的关键 seam。
//
// 用法：
//   const { loadPage, makeApp } = require('./pageHarness')
//   const page = loadPage('../pages/home/home', app)

'use strict'

// 微信 setData 支持数据路径（'a.b[0].c'）。纯键仍走直接赋值，路径键逐段下钻。
// 被测页面用路径键做嵌套数组的不可变更新，这里必须同构支持，否则测试观测不到。
function setPath(obj, path, value) {
  const segs = []
  const re = /([^.[\]]+)|\[(\d+)\]/g
  let m
  while ((m = re.exec(path))) segs.push(m[2] !== undefined ? Number(m[2]) : m[1])
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) cur[segs[i]] = typeof segs[i + 1] === 'number' ? [] : {}
    cur = cur[segs[i]]
  }
  cur[segs[segs.length - 1]] = value
}

// 装载页面模块并返回实例；全局 Page/getApp 在该测试文件内保持注入。
function loadPage(pagePath, app) {
  global.getApp = () => app

  let def = null
  global.Page = (o) => {
    def = o
  }
  jest.isolateModules(() => {
    require(pagePath)
  })
  if (!def) throw new Error(`Page() not called by ${pagePath}`)

  // 实例：data 深拷贝 + setData（含路径键）+ 生命周期方法绑定。
  const page = {
    data: JSON.parse(JSON.stringify(def.data || {})),
    setData(patch) {
      for (const key of Object.keys(patch)) {
        if (key.indexOf('.') >= 0 || key.indexOf('[') >= 0) setPath(this.data, key, patch[key])
        else this.data[key] = patch[key]
      }
    },
  }
  for (const [k, v] of Object.entries(def)) {
    if (k !== 'data' && typeof v === 'function') page[k] = v.bind(page)
  }
  page.wx = global.wx // 便捷访问
  return page
}

// 测试用 app 桩（globalData.currentDeviceId 与 app.js 同构）。
function makeApp(currentDeviceId) {
  return {
    globalData: { currentDeviceId: currentDeviceId || null },
  }
}

module.exports = { loadPage, makeApp }