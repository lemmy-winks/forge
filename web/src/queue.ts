/* Offline queue for set logging: IndexedDB-backed, flushed on reconnect. */
import { api, ApiError } from './api';

let db: IDBDatabase | null = null;

export function openQueue(): Promise<void> {
  return new Promise((res) => {
    const req = indexedDB.open('forge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('queue', { autoIncrement: true });
    req.onsuccess = () => { db = req.result; res(); };
    req.onerror = () => res();
  });
}

function add(item: { path: string; body: unknown }) {
  db?.transaction('queue', 'readwrite').objectStore('queue').add(item);
}

export async function flushQueue(onFlushed?: (n: number) => void): Promise<void> {
  if (!db) return;
  const store = db.transaction('queue', 'readonly').objectStore('queue');
  const items: { key: IDBValidKey; val: { path: string; body: unknown } }[] = await new Promise((res) => {
    const out: { key: IDBValidKey; val: { path: string; body: unknown } }[] = [];
    store.openCursor().onsuccess = (e) => {
      const c = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (c) { out.push({ key: c.key, val: c.value }); c.continue(); } else res(out);
    };
  });
  let done = 0;
  for (const it of items) {
    try {
      await api(it.val.path, { method: 'POST', body: it.val.body });
      db.transaction('queue', 'readwrite').objectStore('queue').delete(it.key);
      done++;
    } catch (e) {
      if (!(e instanceof ApiError)) break;
      if (e.network || e.status === 401) break; // offline or signed out — keep everything, retry later
      if ((e.status ?? 0) >= 500) continue; // server hiccup — keep this one, try the rest
      db.transaction('queue', 'readwrite').objectStore('queue').delete(it.key); // truly rejected: drop
    }
  }
  if (done && onFlushed) onFlushed(done);
}

/** POST that falls back to the queue when offline. Returns null when queued. */
export async function queuedPost<T = any>(path: string, body: unknown): Promise<T | null> {
  try {
    return await api<T>(path, { method: 'POST', body });
  } catch (e) {
    if (e instanceof ApiError && e.network) { add({ path, body }); return null; }
    throw e;
  }
}
