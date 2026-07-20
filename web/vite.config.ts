import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const backend = {
  target: 'http://localhost:8000',
  changeOrigin: false,
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Forge',
        short_name: 'Forge',
        description: 'Agent-coached training log',
        start_url: '/',
        display: 'standalone',
        background_color: '#060708',
        theme_color: '#060708',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/ingest/, /^\/healthz/],
        importScripts: ['push-listener.js'],
      },
    }),
  ],
  server: {
    proxy: { '/api': backend, '/auth': backend, '/ingest': backend, '/healthz': backend },
  },
});
