// A purely-local index of every fileId this browser has visited or created,
// so the sidebar can list past documents without relying on the cloud tier.
// No signing, no sync — slice 2 will add a signed project manifest. For now
// this is a convenience cache only; the real source of truth is still the URL
// hash and the per-file chains.

const DB_NAME = 'thesis-files';
const DB_VERSION = 1;
const STORE = 'files';

export interface FileRecord {
  fileId: string;
  displayName: string;
  createdAt: string;
  lastOpenedAt: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'fileId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class FileIndex {
  // Insert if new; otherwise refresh lastOpenedAt and optionally displayName.
  async recordVisit(fileId: string, displayName?: string): Promise<FileRecord> {
    const db = await openDB();
    const existing = await new Promise<FileRecord | undefined>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(fileId);
      req.onsuccess = () => res(req.result as FileRecord | undefined);
      req.onerror = () => rej(req.error);
    });
    const now = new Date().toISOString();
    const record: FileRecord = existing
      ? {
          ...existing,
          lastOpenedAt: now,
          displayName: displayName ?? existing.displayName,
        }
      : {
          fileId,
          displayName: displayName ?? fileId,
          createdAt: now,
          lastOpenedAt: now,
        };
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return record;
  }

  async list(): Promise<FileRecord[]> {
    const db = await openDB();
    const result = await new Promise<FileRecord[]>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => res(req.result as FileRecord[]);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return result;
  }

  async rename(fileId: string, displayName: string): Promise<void> {
    const db = await openDB();
    const existing = await new Promise<FileRecord | undefined>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(fileId);
      req.onsuccess = () => res(req.result as FileRecord | undefined);
      req.onerror = () => rej(req.error);
    });
    if (!existing) {
      db.close();
      return;
    }
    const updated: FileRecord = { ...existing, displayName };
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(updated);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }
}

// Lossy display-name → URL-safe slug. Mirrors the constraints applied in main.ts
// when reading from the URL hash.
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'untitled';
}
