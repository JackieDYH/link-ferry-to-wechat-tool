// Vite 构建配置：Vue3 单页应用，产物输出到 dist/（由 xhs-web-server.mjs 托管）
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 600
  },
  // 开发模式：/api 请求代理到本地后端（9527），实现前后端分离联调
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:9527'
    }
  }
})
