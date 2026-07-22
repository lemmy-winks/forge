/* Run-detail route card (E5.4). Two renderers behind one card:
   - TraceSvg: the original self-contained SVG sketch — instant, offline-safe,
     and the only renderer when no MapTiler key is configured.
   - LiveMap: a MapLibre GL basemap styled from the live design tokens, lazy-
     loaded so the ~800 KB library never touches the main bundle. The SVG stays
     on screen until the map's first full render, then fades out — a run always
     shows its route immediately, tiles or not. */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';

type Pt = [number, number]; // [lat, lon] — as stored in workout_series

/* ---------------- token plumbing ---------------- */

function tok(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Blend two #rrggbb colors; t=0 → a, t=1 → b. Used to derive map hues
    (water, park) from the neutral tokens so every palette stays coherent. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => {
    const va = (pa >> sh) & 255, vb = (pb >> sh) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return '#' + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, '0')).join('');
}

/** Re-render the map when theme or accent palette changes under us. */
const themeKey = () => {
  const d = document.documentElement.dataset;
  return `${d.theme || 'dark'}:${d.palette || 'volt'}`;
};
const subTheme = (cb: () => void) => {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
  return () => o.disconnect();
};

/* ---------------- basemap style ---------------- */

/** A minimal OpenMapTiles style built from the app's tokens: ground is --bg,
    streets are hairlines, buildings sit on --raised, water/park lean gently
    away from neutral. One accent — the route — stays the only saturated thing. */
function forgeStyle(key: string): any {
  const light = document.documentElement.dataset.theme === 'light';
  const bg = tok('--bg'), raised = tok('--raised'), hair = tok('--hair');
  const mut = tok('--mut'), volt = tok('--volt');
  const water = mix(bg, '#3d7bb8', light ? 0.28 : 0.20);
  const park = mix(bg, volt, light ? 0.12 : 0.08);
  const major = mix(hair, mut, 0.35);
  const MAJOR = ['match', ['get', 'class'],
    ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false];
  return {
    version: 8,
    glyphs: `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=${key}`,
    sources: {
      omt: { type: 'vector', url: `https://api.maptiler.com/tiles/v3/tiles.json?key=${key}` },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': bg } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park',
        paint: { 'fill-color': park } },
      { id: 'grass', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['match', ['get', 'class'], ['grass', 'wood'], true, false],
        paint: { 'fill-color': park, 'fill-opacity': 0.6 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water',
        paint: { 'fill-color': water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway',
        paint: { 'line-color': water, 'line-width': 1.5 } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building',
        minzoom: 13, paint: { 'fill-color': raised } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: ['!', MAJOR],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': hair,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 4] } },
      { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation',
        filter: MAJOR,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': major,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 7] } },
      { id: 'road-name', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name',
        minzoom: 14,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'], 'text-size': 10.5 },
        paint: { 'text-color': mut, 'text-halo-color': bg, 'text-halo-width': 1 } },
      { id: 'place-name', type: 'symbol', source: 'omt', 'source-layer': 'place',
        filter: ['match', ['get', 'class'],
          ['suburb', 'neighbourhood', 'quarter', 'village', 'town'], true, false],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'],
          'text-size': 11.5, 'text-letter-spacing': 0.08,
          'text-transform': 'uppercase' },
        paint: { 'text-color': mut, 'text-halo-color': bg, 'text-halo-width': 1.2 } },
    ],
  };
}

function addRoute(map: any, pts: Pt[]) {
  const volt = tok('--volt'), bg = tok('--bg');
  const coords = pts.map((p) => [p[1], p[0]]);
  map.addSource('route', { type: 'geojson', data: {
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } });
  map.addSource('route-ends', { type: 'geojson', data: { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { end: 'start' },
      geometry: { type: 'Point', coordinates: coords[0] } },
    { type: 'Feature', properties: { end: 'finish' },
      geometry: { type: 'Point', coordinates: coords[coords.length - 1] } },
  ] } });
  map.addLayer({ id: 'route-glow', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': volt, 'line-width': 9, 'line-opacity': 0.22 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': volt, 'line-width': 3 } });
  map.addLayer({ id: 'route-finish', type: 'circle', source: 'route-ends',
    filter: ['==', ['get', 'end'], 'finish'],
    paint: { 'circle-radius': 4.5, 'circle-color': bg,
      'circle-stroke-color': volt, 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'route-start', type: 'circle', source: 'route-ends',
    filter: ['==', ['get', 'end'], 'start'],
    paint: { 'circle-radius': 5, 'circle-color': volt } });
}

/* ---------------- renderers ---------------- */

/** The original tile-free sketch: equirectangular projection, volt on the
    raised surface. Also the permanent fallback (offline / no key / tile 4xx). */
export function TraceSvg({ pts }: { pts: Pt[] }) {
  const W = 320, PAD = 14;
  const midLat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * kx), ys = pts.map((p) => -p[0]);
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 1e-6);
  const spanY = Math.max(Math.max(...ys) - Math.min(...ys), 1e-6);
  const H = Math.min(300, Math.max(120, ((W - 2 * PAD) * spanY) / spanX + 2 * PAD));
  const sc = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const px = (i: number): [number, number] => [
    PAD + (xs[i] - x0) * sc + (W - 2 * PAD - spanX * sc) / 2,
    PAD + (ys[i] - y0) * sc + (H - 2 * PAD - spanY * sc) / 2,
  ];
  const path = pts.map((_, i) => px(i));
  const [sx, sy] = path[0], [ex, ey] = path[path.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}
      role="img" aria-label="Route map trace">
      <path d={path.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')}
        fill="none" stroke="var(--volt)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={sx} cy={sy} r="4" fill="var(--volt)" />
      <circle cx={ex} cy={ey} r="4" fill="none" stroke="var(--volt)" strokeWidth="2" />
    </svg>
  );
}

function LiveMap({ pts, apiKey }: { pts: Pt[]; apiKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let map: any = null, dead = false, loaded = false;
    (async () => {
      try {
        const [{ default: maplibregl }] = await Promise.all([
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        if (dead || !ref.current) return;
        const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
        map = new maplibregl.Map({
          container: ref.current,
          style: forgeStyle(apiKey),
          bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          fitBoundsOptions: { padding: 36, maxZoom: 16 },
          attributionControl: { compact: true },
          dragRotate: false, pitchWithRotate: false, touchPitch: false,
        });
        map.touchZoomRotate?.disableRotation();
        map.on('load', () => {
          if (dead) return;
          addRoute(map, pts);
          loaded = true;
          setState('ready');
        });
        // Bad key / no network before first render → stay on the SVG for good.
        map.on('error', (e: any) => {
          const status = e?.error?.status;
          if (!dead && !loaded && (status >= 400 || e?.error?.message === 'Failed to fetch')) {
            setState('failed');
          }
        });
      } catch {
        if (!dead) setState('failed');
      }
    })();
    return () => { dead = true; map?.remove(); }; // never leak a WebGL context
  }, [apiKey, pts]);
  if (state === 'failed') return <TraceSvg pts={pts} />;
  return (
    <div style={{ position: 'relative' }}>
      <div ref={ref} className="runmap"
        style={{ opacity: state === 'ready' ? 1 : 0, transition: 'opacity .35s' }} />
      {state !== 'ready' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center' }}>
          <TraceSvg pts={pts} />
        </div>
      )}
    </div>
  );
}

/* ---------------- the card ---------------- */

export function RouteCard({ pts }: { pts: Pt[] }) {
  const cfg = useQuery<{ enabled: boolean; key: string }>({
    queryKey: ['map-config'],
    queryFn: () => api('/api/map/config'),
    staleTime: 60 * 60 * 1000,
  });
  // key by theme+palette: token changes rebuild the map with fresh colors
  const themed = useSyncExternalStore(subTheme, themeKey, themeKey);
  const live = !!cfg.data?.enabled && navigator.onLine;
  return (
    <div className="card">
      <div className="row"><span className="xname">Route</span></div>
      <div style={{ marginTop: 6 }}>
        {live ? <LiveMap key={themed} pts={pts} apiKey={cfg.data!.key} /> : <TraceSvg pts={pts} />}
      </div>
      <div className="sub">● start · ○ finish</div>
    </div>
  );
}
