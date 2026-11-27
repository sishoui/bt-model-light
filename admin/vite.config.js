import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 后台挂在 nginx 的 /admin/ 路径下（见 scripts/backend_deploy.py），
// base 必须是 '/admin/'，否则产物里的资源路径会 404。
export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 产物是要 SFTP 上传到服务器的：不生成 sourcemap，减小体积。
    sourcemap: false,
  },
  server: {
    port: 5173,
    // 本地开发直连后端（node src/server.js 监听 3000），避免改 CORS。
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
})
