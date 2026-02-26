// ─── Utilities ─────────────────────────────────────────────────────

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ─── Key Management ────────────────────────────────────────────────

const ALGO: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGO: EcdsaParams = { name: 'ECDSA', hash: { name: 'SHA-256' } };

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALGO, true, ['sign', 'verify']);
}

export async function exportPublicKey(keyPair: CryptoKeyPair): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', keyPair.publicKey);
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ALGO, false, ['verify']);
}

// ─── Signing ───────────────────────────────────────────────────────

export async function signData(
  privateKey: CryptoKey,
  data: string
): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const signature = await crypto.subtle.sign(SIGN_ALGO, privateKey, encoded);
  return bufferToBase64Url(signature);
}

// ─── Verification ──────────────────────────────────────────────────

export async function verifySignature(
  publicKeyJwk: JsonWebKey,
  signature: string,
  data: string
): Promise<boolean> {
  const publicKey = await importPublicKey(publicKeyJwk);
  const sigBuffer = base64UrlToBuffer(signature);
  const dataBuffer = new TextEncoder().encode(data);
  return crypto.subtle.verify(SIGN_ALGO, publicKey, sigBuffer, dataBuffer);
}
