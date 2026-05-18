import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth':        'http://localhost:8002',
      '/api':         'http://localhost:8002',
      '/.well-known': 'http://localhost:8002',
      '/config':      'http://localhost:8002',
      '/health':      'http://localhost:8002',
    },
  },
})
