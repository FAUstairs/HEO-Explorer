import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/HEO-Explorer/',
  server: {
    proxy: {
      '/api/auth': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/api/notes': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
