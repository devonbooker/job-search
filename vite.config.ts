import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/sessions': 'http://localhost:3000',
      '/jobs': 'http://localhost:3000',
      '/config': 'http://localhost:3000',
      // Anchored regex: matches /drill/api/<anything>, NOT /drill/api.ts
      // (src/web/drill/api.ts is the frontend module and must be served by Vite).
      '^/drill/api/': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
    include: ['../../tests/web/**/*.{test,spec}.{ts,tsx}'],
  },
})
