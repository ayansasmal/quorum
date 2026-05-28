import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const gatewayUrl = process.env.VITE_GATEWAY_URL ?? 'http://localhost:8002'

const proxy = {
  '/auth':        { target: gatewayUrl, changeOrigin: true },
  '/api':         { target: gatewayUrl, changeOrigin: true },
  '/.well-known': { target: gatewayUrl, changeOrigin: true },
  '/config':      { target: gatewayUrl, changeOrigin: true },
  '/health':      { target: gatewayUrl, changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
})
