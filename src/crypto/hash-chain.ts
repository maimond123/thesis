import type { AuthoringEvent } from '../types';

// ─── Utilities ─────────────────────────────────────────────────────

export function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function canonicalJsonStringify(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = obj[key];
  }
  return JSON.stringify(sorted);
}

// ─── Hashing ───────────────────────────────────────────────────────

export async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return bufferToHex(hashBuffer);
}

export async function computeEventHash(
  event: Omit<AuthoringEvent, 'hash'>
): Promise<string> {
  const payload = canonicalJsonStringify({
    seq: event.seq,
    authorThumbprint: event.authorThumbprint,
    timestamp: event.timestamp,
    type: event.type,
    from: event.from,
    to: event.to,
    inserted: event.inserted,
    deleted: event.deleted,
    cursorAfter: event.cursorAfter,
    prevHash: event.prevHash,
  });
  return sha256(payload);
}

export async function computeGenesisHash(
  metadata: Record<string, unknown>
): Promise<string> {
  const payload = canonicalJsonStringify(metadata);
  return sha256(payload);
}

// Deterministic per-author chain genesis. Any peer can derive any author's
// genesis from just (fileId, authorThumbprint) — no coordination required.
export async function deriveChainGenesis(fileId: string, authorThumbprint: string): Promise<string> {
  return sha256(canonicalJsonStringify({
    kind: 'thesis-chain-genesis-v1',
    fileId,
    authorThumbprint,
  }));
}

// ─── Validation ────────────────────────────────────────────────────

export interface ChainValidationResult {
  valid: boolean;
  brokenAt: number | null;   // seq where chain first breaks, or null
  errors: string[];
}

export async function validateChain(
  events: AuthoringEvent[],
  genesisHash: string
): Promise<ChainValidationResult> {
  const errors: string[] = [];
  let brokenAt: number | null = null;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Check seq
    if (event.seq !== i) {
      errors.push(`Event ${i}: seq is ${event.seq}, expected ${i}`);
      if (brokenAt === null) brokenAt = i;
    }

    // Check prevHash linkage
    const expectedPrevHash = i === 0 ? genesisHash : events[i - 1].hash;
    if (event.prevHash !== expectedPrevHash) {
      errors.push(`Event ${i}: prevHash mismatch`);
      if (brokenAt === null) brokenAt = i;
    }

    // Recompute hash
    const { hash: _hash, ...rest } = event;
    const recomputed = await computeEventHash(rest);
    if (recomputed !== event.hash) {
      errors.push(`Event ${i}: hash mismatch (expected ${recomputed}, got ${event.hash})`);
      if (brokenAt === null) brokenAt = i;
    }
  }

  return {
    valid: errors.length === 0,
    brokenAt,
    errors,
  };
}
