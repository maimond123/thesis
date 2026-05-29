import { canonicalJsonStringify, sha256 } from '../crypto/hash-chain';
import { generateSigningKeyPair, signData } from '../crypto/signing';

const DB_NAME = 'thesis-identity';
const DB_VERSION = 1;
const ALGO: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };

export interface SelfIdentity {
  handle: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  thumbprint: string;
  createdAt: string;
  // ISO timestamp of the last time the user successfully downloaded an identity
  // backup. Null/undefined means they have never backed up — the UI nags them
  // until they do, since losing browser storage with no backup means the chain
  // becomes unrecoverable.
  backedUpAt?: string | null;
}

export interface PublicIdentity {
  handle: string;
  publicKey: JsonWebKey;
  thumbprint: string;
  createdAt: string;
}

export interface IdentityBundle {
  kind: 'thesis-identity';
  version: 1;
  public: PublicIdentity;
  private?: JsonWebKey;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('self')) db.createObjectStore('self');
      if (!db.objectStoreNames.contains('coAuthors')) db.createObjectStore('coAuthors');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result as T | undefined); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result as T[]); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// RFC 7638 JWK thumbprint: SHA-256 of canonical JSON of required EC members.
export async function computeThumbprint(publicKey: JsonWebKey): Promise<string> {
  const required: Record<string, unknown> = {
    crv: publicKey.crv,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
  };
  return sha256(canonicalJsonStringify(required));
}

export function shortThumb(thumbprint: string): string {
  return `${thumbprint.slice(0, 6)}…${thumbprint.slice(-4)}`;
}

export class IdentityStore {
  private self: SelfIdentity | null = null;
  private selfPrivateKey: CryptoKey | null = null;

  async loadSelf(): Promise<SelfIdentity | null> {
    const stored = await idbGet<SelfIdentity>('self', 'me');
    if (!stored) return null;
    this.self = stored;
    this.selfPrivateKey = await crypto.subtle.importKey(
      'jwk', stored.privateKey, ALGO, true, ['sign'],
    );
    return stored;
  }

  async createSelf(handle: string): Promise<SelfIdentity> {
    const keyPair = await generateSigningKeyPair();
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const thumbprint = await computeThumbprint(publicJwk);
    const self: SelfIdentity = {
      handle,
      publicKey: publicJwk,
      privateKey: privateJwk,
      thumbprint,
      createdAt: new Date().toISOString(),
    };
    await idbPut('self', 'me', self);
    this.self = self;
    this.selfPrivateKey = keyPair.privateKey;
    return self;
  }

  getSelf(): SelfIdentity {
    if (!this.self) throw new Error('Identity not initialized');
    return this.self;
  }

  getSelfPublic(): PublicIdentity {
    const s = this.getSelf();
    return { handle: s.handle, publicKey: s.publicKey, thumbprint: s.thumbprint, createdAt: s.createdAt };
  }

  async signWithSelf(data: string): Promise<string> {
    if (!this.selfPrivateKey) throw new Error('Identity not initialized');
    return signData(this.selfPrivateKey, data);
  }

  async addCoAuthor(bundle: IdentityBundle): Promise<PublicIdentity> {
    if (bundle.kind !== 'thesis-identity') throw new Error('Not a thesis identity bundle');
    const pub = bundle.public;
    if (!pub || !pub.publicKey || !pub.thumbprint || !pub.handle) {
      throw new Error('Bundle missing required fields');
    }
    const expected = await computeThumbprint(pub.publicKey);
    if (expected !== pub.thumbprint) throw new Error('Bundle thumbprint mismatch (tampered or corrupt)');
    await idbPut('coAuthors', pub.thumbprint, pub);
    return pub;
  }

  async listCoAuthors(): Promise<PublicIdentity[]> {
    return idbGetAll<PublicIdentity>('coAuthors');
  }

  exportPublicBundle(): IdentityBundle {
    return {
      kind: 'thesis-identity',
      version: 1,
      public: this.getSelfPublic(),
    };
  }

  exportBackupBundle(): IdentityBundle {
    const self = this.getSelf();
    return {
      kind: 'thesis-identity',
      version: 1,
      public: this.getSelfPublic(),
      private: self.privateKey,
    };
  }

  // Persist the fact that the user has just downloaded a backup so we can
  // stop nagging them. Stored alongside the identity record itself.
  async markBackedUp(): Promise<void> {
    const self = this.getSelf();
    self.backedUpAt = new Date().toISOString();
    await idbPut('self', 'me', self);
    this.self = self;
    this.backupListeners.forEach((fn) => fn());
  }

  isBackedUp(): boolean {
    return !!this.self?.backedUpAt;
  }

  private backupListeners: Set<() => void> = new Set();
  onBackupStateChange(fn: () => void): () => void {
    this.backupListeners.add(fn);
    return () => this.backupListeners.delete(fn);
  }

  async restoreFromBackup(bundle: IdentityBundle): Promise<SelfIdentity> {
    if (bundle.kind !== 'thesis-identity') throw new Error('Not a thesis identity bundle');
    if (!bundle.private) throw new Error('Backup bundle missing private key');
    const expected = await computeThumbprint(bundle.public.publicKey);
    if (expected !== bundle.public.thumbprint) throw new Error('Bundle thumbprint mismatch');
    const self: SelfIdentity = {
      handle: bundle.public.handle,
      publicKey: bundle.public.publicKey,
      privateKey: bundle.private,
      thumbprint: bundle.public.thumbprint,
      createdAt: bundle.public.createdAt,
    };
    await idbPut('self', 'me', self);
    this.self = self;
    this.selfPrivateKey = await crypto.subtle.importKey(
      'jwk', self.privateKey, ALGO, true, ['sign'],
    );
    return self;
  }
}
