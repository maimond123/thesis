import type { AuthoringEvent, Checkpoint, TimestampAnchor, SessionMetadata } from '../types';

const DB_NAME = 'thesis-autosave';
const DB_VERSION = 1;

interface SavedSession {
  metadata: SessionMetadata;
  events: AuthoringEvent[];
  checkpoints: Checkpoint[];
  anchors: TimestampAnchor[];
  document: string;
  privateKeyJwk: JsonWebKey;
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

async function clear(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ─── Public API ────────────────────────────────────────────────────

export async function saveSession(
  metadata: SessionMetadata,
  events: AuthoringEvent[],
  checkpoints: Checkpoint[],
  anchors: TimestampAnchor[],
  document: string,
  privateKeyJwk: JsonWebKey,
): Promise<void> {
  const saved: SavedSession = { metadata, events, checkpoints, anchors, document, privateKeyJwk };
  await put('active', saved);
}

export async function loadSession(): Promise<SavedSession | null> {
  const saved = await get<SavedSession>('active');
  return saved ?? null;
}

export async function clearSession(): Promise<void> {
  await clear();
}

export type { SavedSession };
