import type { AuthoringEvent, Checkpoint, TimestampAnchor, SessionMetadata } from '../types';

const DB_NAME = 'thesis-autosave';
const DB_VERSION = 1;

interface SavedSession {
  metadata: SessionMetadata;
  events: AuthoringEvent[];
  checkpoints: Checkpoint[];
  anchors: TimestampAnchor[];
  document: string;
  // Note: no private key stored here. Signing uses the persistent IdentityStore.
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('session', 'readonly');
    const req = tx.objectStore('session').get(key);
    req.onsuccess = () => { db.close(); resolve(req.result as T | undefined); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// ─── Public API ────────────────────────────────────────────────────

// Sessions are namespaced by fileId so two documents in the same browser
// don't overwrite each other in IndexedDB.
function activeKey(fileId: string): string {
  return `active:${fileId}`;
}

export async function saveSession(
  metadata: SessionMetadata,
  events: AuthoringEvent[],
  checkpoints: Checkpoint[],
  anchors: TimestampAnchor[],
  document: string,
): Promise<void> {
  const saved: SavedSession = { metadata, events, checkpoints, anchors, document };
  await put(activeKey(metadata.fileId), saved);
}

export async function loadSession(fileId: string): Promise<SavedSession | null> {
  const saved = await get<SavedSession>(activeKey(fileId));
  return saved ?? null;
}

export async function clearSession(fileId: string): Promise<void> {
  // Targeted delete — don't clear() the whole store, that would wipe other files.
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').delete(activeKey(fileId));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export type { SavedSession };
