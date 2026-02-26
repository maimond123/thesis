import type { ProofFile } from '../types';

export function serializeProof(proof: ProofFile): string {
  return JSON.stringify(proof, null, 2);
}

export function downloadProof(proof: ProofFile, filename?: string): void {
  const json = serializeProof(proof);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `proof-${proof.session.sessionId.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
