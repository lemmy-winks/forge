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
        // The maplibre chunk only loads on the run-detail route — keep it out
        // of the install-time precache and cache it on first use instead.
        globIgnores: ['**/maplibre-gl-*'],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/maplibre-gl-.*\.(?:js|css)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'maplibre-lib',
              expiration: { maxEntries: 4, purgeOnQuotaError: true },
            },
          },
          // Basemap tiles/glyphs for the run-detail map: cache-first so a run
          // you've already looked at renders instantly and offline. Capped so
          // the cache can't grow without bound (MapTiler ToS allows transient
          // caching, not bulk pre-download).
          {
            urlPattern: /^https:\/\/api\.maptiler\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'maptiler',
              expiration: { maxEntries: 400, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: { '/api': backend, '/auth': backend, '/ingest': backend, '/healthz': backend },
  },
});
