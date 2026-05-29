import type { ProofFile, AuthoringEvent, PublicIdentitySnapshot } from '../types';
import {
  validateChain, sha256, canonicalJsonStringify, deriveChainGenesis,
} from '../crypto/hash-chain';
import { verifySignature } from '../crypto/signing';

// ─── Result types ──────────────────────────────────────────────────

export interface CheckResult {
  passed: boolean;
  message: string;
  details?: string;
}

export interface PatternAnalysis {
  averageSpeed: number;
  medianDelay: number;
  delayStdDev: number;
  correctionRatio: number;
  longPauses: number;
  appearsHuman: boolean;
  explanation: string;
}

export interface VerificationResult {
  valid: boolean;
  checks: {
    genesisHash: CheckResult;
    hashChain: CheckResult;
    checkpointSignatures: CheckResult;
    documentConsistency: CheckResult;
    finalSignature: CheckResult;
    humanPatterns: PatternAnalysis;
    roster: CheckResult;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function groupByAuthor(events: AuthoringEvent[]): Map<string, AuthoringEvent[]> {
  const map = new Map<string, AuthoringEvent[]>();
  for (const ev of events) {
    const arr = map.get(ev.authorThumbprint) ?? [];
    arr.push(ev);
    map.set(ev.authorThumbprint, arr);
  }
  // Each chain must be ordered by its own `seq`.
  for (const [, arr] of map) arr.sort((a, b) => a.seq - b.seq);
  return map;
}

function findAuthor(authors: PublicIdentitySnapshot[] | undefined, thumbprint: string): PublicIdentitySnapshot | undefined {
  return authors?.find((a) => a.thumbprint === thumbprint);
}

// ─── Verification ──────────────────────────────────────────────────

export async function verifyProof(proof: ProofFile): Promise<VerificationResult> {
  const genesisCheck = await verifyGenesisHash(proof);
  const chainCheck = await verifyHashChainsMultiAuthor(proof);
  const checkpointCheck = await verifyCheckpoints(proof);
  const docCheck = await verifyDocumentConsistency(proof);
  const finalSigCheck = await verifyFinalSignature(proof);
  const rosterCheck = verifyRoster(proof);
  const humanPatterns = analyzeHumanPatterns(proof.events);

  const valid =
    genesisCheck.passed &&
    chainCheck.passed &&
    checkpointCheck.passed &&
    docCheck.passed &&
    finalSigCheck.passed &&
    rosterCheck.passed;

  return {
    valid,
    checks: {
      genesisHash: genesisCheck,
      hashChain: chainCheck,
      checkpointSignatures: checkpointCheck,
      documentConsistency: docCheck,
      finalSignature: finalSigCheck,
      humanPatterns,
      roster: rosterCheck,
    },
  };
}

// ─── Genesis hash ──────────────────────────────────────────────────

async function verifyGenesisHash(proof: ProofFile): Promise<CheckResult> {
  // Local author's chain genesis is derived from (fileId, localAuthorThumbprint).
  const fileId = proof.session.fileId;
  const localThumb = proof.session.localAuthorThumbprint;
  if (!fileId || !localThumb) {
    return { passed: false, message: 'Proof missing fileId or localAuthorThumbprint' };
  }
  const computed = await deriveChainGenesis(fileId, localThumb);
  if (computed === proof.session.genesisHash) {
    return { passed: true, message: 'Genesis hash is valid' };
  }
  return {
    passed: false,
    message: 'Genesis hash mismatch',
    details: `Expected ${computed}, got ${proof.session.genesisHash}`,
  };
}

// ─── Hash-chain integrity, per-author ──────────────────────────────

async function verifyHashChainsMultiAuthor(proof: ProofFile): Promise<CheckResult> {
  if (proof.events.length === 0) {
    return { passed: true, message: 'No events to verify (empty session)' };
  }
  const fileId = proof.session.fileId;
  if (!fileId) {
    return { passed: false, message: 'Proof missing fileId — cannot derive per-author geneses' };
  }

  const byAuthor = groupByAuthor(proof.events);
  const errors: string[] = [];
  let totalEvents = 0;

  for (const [thumbprint, events] of byAuthor) {
    const genesis = await deriveChainGenesis(fileId, thumbprint);
    const result = await validateChain(events, genesis);
    if (!result.valid) {
      errors.push(`Author ${thumbprint.slice(0, 8)}…: ${result.errors.slice(0, 3).join(' | ')}`);
    }
    totalEvents += events.length;
  }

  if (errors.length === 0) {
    return {
      passed: true,
      message: `Hash chains intact (${byAuthor.size} author${byAuthor.size === 1 ? '' : 's'}, ${totalEvents} events total)`,
    };
  }
  return {
    passed: false,
    message: `Chain broken on ${errors.length} author chain(s)`,
    details: errors.join('\n'),
  };
}

// ─── Checkpoints ───────────────────────────────────────────────────

async function verifyCheckpoints(proof: ProofFile): Promise<CheckResult> {
  if (proof.checkpoints.length === 0) {
    return { passed: true, message: 'No checkpoints to verify' };
  }

  // For slice 1 only the local author signs checkpoints. Look up their public
  // key from the roster (or fall back to session.publicKey).
  const localThumb = proof.session.localAuthorThumbprint;
  const localAuthor = findAuthor(proof.session.authors, localThumb);
  const publicKey = localAuthor?.publicKey ?? proof.session.publicKey;
  if (!publicKey) {
    return { passed: false, message: 'No public key found for local author' };
  }

  // Build a map from seq → event for the local chain only (checkpoints reference seq).
  const localEvents = proof.events.filter((e) => e.authorThumbprint === localThumb);
  const bySeq = new Map<number, AuthoringEvent>();
  for (const e of localEvents) bySeq.set(e.seq, e);

  const errors: string[] = [];
  for (let i = 0; i < proof.checkpoints.length; i++) {
    const cp = proof.checkpoints[i];
    const event = bySeq.get(cp.atSeq);
    if (!event || event.hash !== cp.eventHash) {
      errors.push(`Checkpoint ${i}: eventHash doesn't match local-chain event at seq ${cp.atSeq}`);
      continue;
    }
    const payload = canonicalJsonStringify({
      atSeq: cp.atSeq,
      eventHash: cp.eventHash,
      documentHash: cp.documentHash,
      wallClock: cp.wallClock,
    });
    const valid = await verifySignature(publicKey, cp.signature, payload);
    if (!valid) errors.push(`Checkpoint ${i}: invalid signature`);
  }

  if (errors.length === 0) {
    return { passed: true, message: `All ${proof.checkpoints.length} checkpoint signatures valid` };
  }
  return {
    passed: false,
    message: `${errors.length} checkpoint(s) failed verification`,
    details: errors.join('\n'),
  };
}

// ─── Document consistency ─────────────────────────────────────────

async function verifyDocumentConsistency(proof: ProofFile): Promise<CheckResult> {
  // In multi-author mode the doc is the result of a CRDT merge, so we can't
  // simply replay events in timestamp order and expect a byte-perfect match.
  // For slice 1 we verify two weaker properties:
  //   (a) For single-author proofs only, the linear replay matches finalDocument
  //   (b) The last checkpoint's documentHash matches sha256(finalDocument)
  const byAuthor = groupByAuthor(proof.events);
  const isSingleAuthor = byAuthor.size <= 1;

  if (isSingleAuthor) {
    let doc = '';
    for (const event of proof.events) {
      if (event.inserted === '' && event.deleted === '') continue;
      doc = doc.slice(0, event.from) + event.inserted + doc.slice(event.from + event.deleted.length);
    }
    if (doc === proof.finalDocument) {
      return { passed: true, message: 'Replayed document matches finalDocument' };
    }
  }

  // Fall back to last-checkpoint document-hash check.
  const docHash = await sha256(proof.finalDocument);
  const lastCp = proof.checkpoints[proof.checkpoints.length - 1];
  if (lastCp && lastCp.documentHash === docHash) {
    return {
      passed: true,
      message: 'finalDocument hash matches last checkpoint',
    };
  }
  if (isSingleAuthor) {
    return {
      passed: false,
      message: 'Document reconstruction mismatch',
      details: `Replayed length differs from finalDocument and last-checkpoint hash also differs.`,
    };
  }
  // Multi-author proof, no matching checkpoint hash:
  return {
    passed: false,
    message: 'Multi-author proof: cannot verify document — last checkpoint documentHash does not match finalDocument',
  };
}

// ─── Final signature ───────────────────────────────────────────────

async function verifyFinalSignature(proof: ProofFile): Promise<CheckResult> {
  const localEvents = proof.events.filter((e) => e.authorThumbprint === proof.session.localAuthorThumbprint);
  const sortedLocal = localEvents.sort((a, b) => a.seq - b.seq);
  const lastHash = sortedLocal.length > 0
    ? sortedLocal[sortedLocal.length - 1].hash
    : proof.session.genesisHash;

  const finalDocHash = await sha256(proof.finalDocument);

  const payload = canonicalJsonStringify({
    sessionId: proof.session.sessionId,
    genesisHash: proof.session.genesisHash,
    lastEventHash: lastHash,
    finalDocumentHash: finalDocHash,
    endTime: proof.session.endTime,
  });

  const localAuthor = findAuthor(proof.session.authors, proof.session.localAuthorThumbprint);
  const publicKey = localAuthor?.publicKey ?? proof.session.publicKey;
  const valid = await verifySignature(publicKey, proof.finalSignature, payload);
  if (valid) return { passed: true, message: 'Final session signature is valid' };
  return { passed: false, message: 'Final session signature is invalid' };
}

// ─── Roster integrity ─────────────────────────────────────────────

function verifyRoster(proof: ProofFile): CheckResult {
  const roster = proof.session.authors;
  if (!roster || roster.length === 0) {
    return { passed: false, message: 'Proof has no authors in the roster' };
  }
  const knownThumbs = new Set(roster.map((a) => a.thumbprint));
  const missing = new Set<string>();
  for (const ev of proof.events) {
    if (!knownThumbs.has(ev.authorThumbprint)) missing.add(ev.authorThumbprint);
  }
  if (missing.size > 0) {
    return {
      passed: false,
      message: `${missing.size} event author(s) missing from roster`,
      details: [...missing].slice(0, 5).map((t) => t.slice(0, 12)).join(', '),
    };
  }
  return {
    passed: true,
    message: `Roster has ${roster.length} author${roster.length === 1 ? '' : 's'}; every event attributable`,
  };
}

// ─── Human pattern analysis ───────────────────────────────────────

function analyzeHumanPatterns(events: AuthoringEvent[]): PatternAnalysis {
  if (events.length < 2) {
    return {
      averageSpeed: 0,
      medianDelay: 0,
      delayStdDev: 0,
      correctionRatio: 0,
      longPauses: 0,
      appearsHuman: false,
      explanation: 'Too few events to analyze',
    };
  }

  const delays: number[] = [];
  for (let i = 1; i < events.length; i++) {
    delays.push(events[i].timestamp - events[i - 1].timestamp);
  }
  const sorted = [...delays].sort((a, b) => a - b);
  const medianDelay = sorted[Math.floor(sorted.length / 2)];
  const meanDelay = delays.reduce((s, d) => s + d, 0) / delays.length;
  const variance = delays.reduce((s, d) => s + (d - meanDelay) ** 2, 0) / delays.length;
  const delayStdDev = Math.sqrt(variance);
  const totalTime = events[events.length - 1].timestamp - events[0].timestamp;
  const averageSpeed = totalTime > 0 ? (events.length / totalTime) * 60_000 : 0;
  const deleteEvents = events.filter((e) => e.type.startsWith('delete') || e.type === 'undo');
  const correctionRatio = deleteEvents.length / events.length;
  const longPauses = delays.filter((d) => d > 2000).length;
  const hasVariance = delayStdDev > 50;
  const hasCorrections = correctionRatio > 0.05;
  const hasPauses = longPauses > 0;
  const noBulkPaste = !events.some((e) => e.inserted.length > 200 && e.type === 'input.paste');
  const appearsHuman = hasVariance && (hasCorrections || hasPauses) && noBulkPaste;
  const reasons: string[] = [];
  if (hasVariance) reasons.push('variable typing speed');
  if (hasCorrections) reasons.push(`${(correctionRatio * 100).toFixed(1)}% corrections`);
  if (hasPauses) reasons.push(`${longPauses} thinking pauses`);
  if (!noBulkPaste) reasons.push('WARNING: large paste operations detected');
  return {
    averageSpeed: Math.round(averageSpeed),
    medianDelay: Math.round(medianDelay),
    delayStdDev: Math.round(delayStdDev),
    correctionRatio: Math.round(correctionRatio * 1000) / 1000,
    longPauses,
    appearsHuman,
    explanation: appearsHuman
      ? `Appears human: ${reasons.join(', ')}`
      : `Inconclusive: ${reasons.join(', ')}`,
  };
}
