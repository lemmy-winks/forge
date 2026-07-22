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
    // The OG/Twitter tags carry an __ORIGIN__ placeholder that FastAPI fills with
    // the request's own origin at runtime (host-aware, multi-domain). The built
    // dist/index.html must keep the token; only the dev server, where nothing
    // injects it, strips it to leave valid relative URLs.
    {
      name: 'og-origin-dev',
      transformIndexHtml: {
        order: 'pre' as const,
        handler(html: string, ctx: { server?: unknown }) {
          return ctx.server ? html.replaceAll('__ORIGIN__', '') : html;
        },
      },
    },
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
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/ingest/, /^\/healthz/, /^\/welcome/],
        importScripts: ['push-listener.js'],
        // The maplibre chunk only loads on the run-detail route — keep it out
        // of the install-time precache and cache it on first use instead.
        // og-image.png is only ever fetched by link-preview scrapers, never by
        // the app itself — no reason to ship it in every client's precache.
        globIgnores: ['**/maplibre-gl-*', 'og-image.png'],
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
