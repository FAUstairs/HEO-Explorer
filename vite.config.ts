import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendTarget = env.VITE_API_BASE_URL || 'http://localhost:3001'
  return {
  plugins: [react()],
  base: '/HEO-Explorer/',
  server: {
    proxy: {
      '/api/auth': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/api/notes': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/api/query': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/api/config': {
        target: backendTarget,
        changeOrigin: true,
      },
    },
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: ['baula-staging.kwarc.info'],
  },
  }
})
