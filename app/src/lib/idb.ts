// Minimal IndexedDB wrapper for the local-first store.
// Stores: bridges cache, inspection drafts, sync queue, settings.
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'emergency-bridge-app';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        d.createObjectStore('bridges', { keyPath: 'asset_id' });
        d.createObjectStore('districts', { keyPath: 'id' });
        d.createObjectStore('drafts', { keyPath: 'client_inspection_id' });
        d.createObjectStore('syncQueue', { keyPath: 'id' });
        d.createObjectStore('settings', { keyPath: 'key' });
        d.createObjectStore('meta', { keyPath: 'key' });
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
