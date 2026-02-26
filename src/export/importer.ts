import type { ProofFile } from '../types';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export function parseProofFile(json: string): ProofFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ImportError('Invalid JSON');
  }

  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new ImportError(`Unsupported version: ${obj.version}`);
  }
  if (!obj.session || typeof obj.session !== 'object') {
    throw new ImportError('Missing session metadata');
  }
  if (!Array.isArray(obj.events)) {
    throw new ImportError('Missing events array');
  }
  if (!Array.isArray(obj.checkpoints)) {
    throw new ImportError('Missing checkpoints array');
  }
  if (typeof obj.finalDocument !== 'string') {
    throw new ImportError('Missing finalDocument');
  }
  if (typeof obj.finalSignature !== 'string') {
    throw new ImportError('Missing finalSignature');
  }

  return data as ProofFile;
}

export async function importFromFile(file: File): Promise<ProofFile> {
  const text = await file.text();
  return parseProofFile(text);
}
