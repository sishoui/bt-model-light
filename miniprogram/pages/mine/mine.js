// 我的页（底部导航第二 Tab）：设置/关于/帮助（ADR-0027）。
// T5 (#25) 实现。

const GEN = require('../../utils/protocol_gen')

Page({
  data: {
    version: GEN.APP_VERSION.string,
    protocolVersion: GEN.PROTOCOL_VERSION.string,
  },
})