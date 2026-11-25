import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const base = '/HEO-Explorer/'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendTarget = env.VITE_API_BASE_URL || 'http://localhost:3001'

  return {
    plugins: [react()],
    base,
    server: {
      proxy: {
        [`^(?:${base.slice(0, -1)})?/api/(?:auth|admin|notes|query|config|questions)(?:[/?]|$)`]: {
          target: backendTarget,
          changeOrigin: true,
          rewrite: (path) => path.startsWith(base) ? path.slice(base.length - 1) : path,
        },
      },
      host: '127.0.0.1',
      port: 5173,
      allowedHosts: ['baula-staging.kwarc.info'],
    },
  }
})
