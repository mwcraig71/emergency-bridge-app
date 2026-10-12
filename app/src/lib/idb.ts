// Minimal IndexedDB wrapper for the local-first store.
// Stores: bridges cache, inspection drafts, sync queue, settings.
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'emergency-bridge-app';
const DB_VERSION = 5;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        // contains() guards make this safe for fresh installs (v0→2)
        // and upgrades (v1→2).
        if (!d.objectStoreNames.contains('bridges'))
          d.createObjectStore('bridges', { keyPath: 'asset_id' });
        if (!d.objectStoreNames.contains('districts'))
          d.createObjectStore('districts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('drafts'))
          d.createObjectStore('drafts', { keyPath: 'client_inspection_id' });
        if (!d.objectStoreNames.contains('syncQueue'))
          d.createObjectStore('syncQueue', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('settings'))
          d.createObjectStore('settings', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('meta'))
          d.createObjectStore('meta', { keyPath: 'key' });
        // v2: team assignments + notifications
        if (!d.objectStoreNames.contains('assignments'))
          d.createObjectStore('assignments', { keyPath: 'asset_id' });
        if (!d.objectStoreNames.contains('notifications'))
          d.createObjectStore('notifications', { keyPath: 'id' });
        // v3: bulk assignment buckets
        if (!d.objectStoreNames.contains('buckets'))
          d.createObjectStore('buckets', { keyPath: 'id' });
        // v4: offline map tiles + named offline areas
        if (!d.objectStoreNames.contains('offlineTiles'))
          d.createObjectStore('offlineTiles', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('offlineAreas'))
          d.createObjectStore('offlineAreas', { keyPath: 'id' });
        // v5: firm multi-tenancy — firms + inspector roster (offline PIN login)
        if (!d.objectStoreNames.contains('firms'))
          d.createObjectStore('firms', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('inspectors'))
          d.createObjectStore('inspectors', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

export async function idbPut(store: string, value: unknown): Promise<void> {
  const d = await db();
  await d.put(store, value as never);
}

export async function idbBulkPut(store: string, values: unknown[]): Promise<void> {
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  await Promise.all(values.map((v) => tx.store.put(v as never)));
  await tx.done;
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const d = await db();
  return d.get(store, key) as Promise<T | undefined>;
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const d = await db();
  return d.getAll(store) as Promise<T[]>;
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const d = await db();
  await d.delete(store, key);
}

export async function idbClear(store: string): Promise<void> {
  const d = await db();
  await d.clear(store);
}

export async function idbCount(store: string): Promise<number> {
  const d = await db();
  return d.count(store);
}
