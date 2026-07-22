import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const backend = {
  target: 'http://localhost:8000',
  changeOrigin: false,
};

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'icon-512.png', 'og.png'],
      manifest: {
        name: 'Forge',
        short_name: 'Forge',
        description: 'Agent-coached training & nutrition',
        start_url: '/',
        display: 'standalone',
        background_color: '#060708',
        theme_color: '#060708',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/ingest/, /^\/healthz/, /^\/welcome/],
        importScripts: ['push-listener.js'],
      },
    }),
  ],
  server: {
    proxy: { '/api': backend, '/auth': backend, '/ingest': backend, '/healthz': backend },
  },
});
