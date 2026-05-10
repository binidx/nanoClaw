import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

function packageChunkName(id: string): string | null {
  if (id.includes('/src/i18n/locales/zh/')) return 'i18n-zh'
  if (id.includes('/src/i18n/locales/en/')) return 'i18n-en'
  if (id.endsWith('/src/i18n/index.ts')) return 'i18n-runtime'
  if (!id.includes('/node_modules/')) return null
  if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react-vendor'
  if (id.includes('/node_modules/react-router/') || id.includes('/node_modules/react-router-dom/')) return 'router-vendor'
  if (id.includes('/node_modules/i18next/') || id.includes('/node_modules/react-i18next/')) return 'i18n-vendor'
  if (id.includes('/node_modules/highlight.js/')) return 'highlight-vendor'
  if (id.includes('/node_modules/@xterm/')) return 'terminal-vendor'
  if (id.includes('/node_modules/pixi.js/')) return 'pixi-vendor'
  if (id.includes('/node_modules/pixi-live2d-display/')) return 'live2d-vendor'
  if (
    id.includes('/node_modules/react-force-graph-2d/') ||
    id.includes('/node_modules/dagre/') ||
    id.includes('/node_modules/d3-')
  ) return 'graph-vendor'
  if (id.includes('/node_modules/jszip/')) return 'zip-vendor'
  if (id.includes('/node_modules/react-virtuoso/')) return 'virtual-list-vendor'
  return null
}

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['pwa-icon.svg'],
      manifest: {
        name: 'NanoClaw',
        short_name: 'NanoClaw',
        description: 'AI Control Console',
        theme_color: '#1e293b',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3377',
      '/ws': {
        target: 'ws://localhost:3377',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          return packageChunkName(id)
        },
      },
    },
  },
})
