// 服务入口（systemd ExecStart=node src/server.js，ADR-0036）。
//
// 只做三件事：建 app、listen、优雅关停。测试不走这里（用 createApp 注入）。

'use strict'

const { createApp } = require('./app')
const { config } = require('./config')

const app = createApp()
const server = app.listen(config.port, config.bind, () => {
  const log = app.locals.log
  log.info('api listening', { bind: config.bind, port: config.port, db: config.dbPath })
})

function shutdown(signal) {
  app.locals.log.info('shutting down', { signal })
  server.close(() => {
    try {
      app.locals.db.close()
    } catch (_e) {
      /* 关闭失败无所谓：进程即将退出 */
    }
    process.exit(0)
  })
  // 兜底：3s 内没关完就硬退，避免 systemd 反复 SIGKILL。
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
