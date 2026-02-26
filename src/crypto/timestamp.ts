import type { Checkpoint, TimestampAnchor } from '../types';
import { sha256 } from './hash-chain';

export interface TimestampCommitment {
  checkpointSeq: number;
  commitHash: string;
}

export async function generateCommitment(
  checkpoint: Checkpoint
): Promise<TimestampCommitment> {
  const commitHash = await sha256(checkpoint.signature);
  return {
    checkpointSeq: checkpoint.atSeq,
    commitHash,
  };
}

export function createManualAnchor(
  commitment: TimestampCommitment,
  proof: string
): TimestampAnchor {
  return {
    checkpointSeq: commitment.checkpointSeq,
    commitHash: commitment.commitHash,
    method: 'manual',
    proof,
    createdAt: new Date().toISOString(),
  };
}
