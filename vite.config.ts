import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5188,
    allowedHosts: true,
    // 开发时前端在 Vite，房间服务在 wrangler（8787）。
    // 把 /parties 连同 WebSocket 一起代理过去，客户端才能直接用 location.origin。
    proxy: {
      '/parties': {
        target: 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
