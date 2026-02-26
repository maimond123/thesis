import type { ProofFile, AuthoringEvent } from '../types';
import {
  validateChain, computeGenesisHash, sha256,
  canonicalJsonStringify,
} from '../crypto/hash-chain';
import { verifySignature } from '../crypto/signing';

// ─── Result types ──────────────────────────────────────────────────

export interface CheckResult {
  passed: boolean;
  message: string;
  details?: string;
}

export interface PatternAnalysis {
  averageSpeed: number;        // events per minute
  medianDelay: number;         // ms between events
  delayStdDev: number;
  correctionRatio: number;     // delete events / total
  longPauses: number;          // pauses > 2s
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
  };
}

// ─── Verification ──────────────────────────────────────────────────

export async function verifyProof(proof: ProofFile): Promise<VerificationResult> {
  const genesisCheck = await verifyGenesisHash(proof);
  const chainCheck = await verifyHashChain(proof);
  const checkpointCheck = await verifyCheckpoints(proof);
  const docCheck = await verifyDocumentConsistency(proof);
  const finalSigCheck = await verifyFinalSignature(proof);
  const humanPatterns = analyzeHumanPatterns(proof.events);

  const valid =
    genesisCheck.passed &&
    chainCheck.passed &&
    checkpointCheck.passed &&
    docCheck.passed &&
    finalSigCheck.passed;

  return {
    valid,
    checks: {
      genesisHash: genesisCheck,
      hashChain: chainCheck,
      checkpointSignatures: checkpointCheck,
      documentConsistency: docCheck,
      finalSignature: finalSigCheck,
      humanPatterns,
    },
  };
}

// ─── Individual checks ─────────────────────────────────────────────

async function verifyGenesisHash(proof: ProofFile): Promise<CheckResult> {
  const meta: Record<string, unknown> = {
    sessionId: proof.session.sessionId,
    startTime: proof.session.startTime,
    perfTimeOrigin: proof.session.perfTimeOrigin,
    publicKey: proof.session.publicKey,
    appVersion: proof.session.appVersion,
  };
  const computed = await computeGenesisHash(meta);

  if (computed === proof.session.genesisHash) {
    return { passed: true, message: 'Genesis hash is valid' };
  }
  return {
    passed: false,
    message: 'Genesis hash mismatch',
    details: `Expected ${computed}, got ${proof.session.genesisHash}`,
  };
}

async function verifyHashChain(proof: ProofFile): Promise<CheckResult> {
  if (proof.events.length === 0) {
    return { passed: true, message: 'No events to verify (empty session)' };
  }

  const result = await validateChain(proof.events, proof.session.genesisHash);
  if (result.valid) {
    return {
      passed: true,
      message: `Hash chain intact (${proof.events.length} events)`,
    };
  }
  return {
    passed: false,
    message: `Chain broken at event ${result.brokenAt}`,
    details: result.errors.join('\n'),
  };
}

async function verifyCheckpoints(proof: ProofFile): Promise<CheckResult> {
  if (proof.checkpoints.length === 0) {
    return { passed: true, message: 'No checkpoints to verify' };
  }

  const errors: string[] = [];
  for (let i = 0; i < proof.checkpoints.length; i++) {
    const cp = proof.checkpoints[i];

    // Verify event hash linkage
    const event = proof.events[cp.atSeq];
    if (!event || event.hash !== cp.eventHash) {
      errors.push(`Checkpoint ${i}: eventHash doesn't match event at seq ${cp.atSeq}`);
      continue;
    }

    // Verify signature
    const payload = canonicalJsonStringify({
      atSeq: cp.atSeq,
      eventHash: cp.eventHash,
      documentHash: cp.documentHash,
      wallClock: cp.wallClock,
    });

    const valid = await verifySignature(
      proof.session.publicKey,
      cp.signature,
      payload
    );
    if (!valid) {
      errors.push(`Checkpoint ${i}: invalid signature`);
    }
  }

  if (errors.length === 0) {
    return {
      passed: true,
      message: `All ${proof.checkpoints.length} checkpoint signatures valid`,
    };
  }
  return {
    passed: false,
    message: `${errors.length} checkpoint(s) failed verification`,
    details: errors.join('\n'),
  };
}

async function verifyDocumentConsistency(proof: ProofFile): Promise<CheckResult> {
  // Replay events to reconstruct document
  let doc = '';
  for (const event of proof.events) {
    if (event.inserted === '' && event.deleted === '') continue;
    const before = doc.slice(0, event.from);
    const after = doc.slice(event.from + event.deleted.length);
    doc = before + event.inserted + after;
  }

  if (doc === proof.finalDocument) {
    return { passed: true, message: 'Replayed document matches finalDocument' };
  }

  // Also check hash of finalDocument against last checkpoint
  const docHash = await sha256(proof.finalDocument);
  const lastCheckpoint = proof.checkpoints[proof.checkpoints.length - 1];
  const hashMatch = lastCheckpoint && lastCheckpoint.documentHash === docHash;

  return {
    passed: false,
    message: 'Document reconstruction mismatch',
    details: `Replayed length: ${doc.length}, finalDocument length: ${proof.finalDocument.length}. ` +
      `Hash check: ${hashMatch ? 'matches last checkpoint' : 'does not match'}`,
  };
}

async function verifyFinalSignature(proof: ProofFile): Promise<CheckResult> {
  const lastHash = proof.events.length > 0
    ? proof.events[proof.events.length - 1].hash
    : proof.session.genesisHash;

  const finalDocHash = await sha256(proof.finalDocument);

  const payload = canonicalJsonStringify({
    sessionId: proof.session.sessionId,
    genesisHash: proof.session.genesisHash,
    lastEventHash: lastHash,
    finalDocumentHash: finalDocHash,
    endTime: proof.session.endTime,
  });

  const valid = await verifySignature(
    proof.session.publicKey,
    proof.finalSignature,
    payload
  );

  if (valid) {
    return { passed: true, message: 'Final session signature is valid' };
  }
  return { passed: false, message: 'Final session signature is invalid' };
}

// ─── Human pattern analysis ────────────────────────────────────────

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

  // Compute inter-event delays
  const delays: number[] = [];
  for (let i = 1; i < events.length; i++) {
    delays.push(events[i].timestamp - events[i - 1].timestamp);
  }

  const sorted = [...delays].sort((a, b) => a - b);
  const medianDelay = sorted[Math.floor(sorted.length / 2)];
  const meanDelay = delays.reduce((s, d) => s + d, 0) / delays.length;
  const variance = delays.reduce((s, d) => s + (d - meanDelay) ** 2, 0) / delays.length;
  const delayStdDev = Math.sqrt(variance);

  // Events per minute
  const totalTime = events[events.length - 1].timestamp - events[0].timestamp;
  const averageSpeed = totalTime > 0 ? (events.length / totalTime) * 60_000 : 0;

  // Correction ratio
  const deleteEvents = events.filter(e => e.type.startsWith('delete') || e.type === 'undo');
  const correctionRatio = deleteEvents.length / events.length;

  // Long pauses
  const longPauses = delays.filter(d => d > 2000).length;

  // Heuristic: human typing has high variance, corrections, and pauses
  const hasVariance = delayStdDev > 50;
  const hasCorrections = correctionRatio > 0.05;
  const hasPauses = longPauses > 0;
  const noBulkPaste = !events.some(e => e.inserted.length > 200 && e.type === 'input.paste');

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
