import type { AuthoringEvent, Checkpoint, TimestampAnchor, SessionMetadata } from '../types';

interface CloudSession {
  metadata: SessionMetadata;
  events: AuthoringEvent[];
  checkpoints: Checkpoint[];
  anchors: TimestampAnchor[];
  document: string;
  savedAt: string;
}

interface SessionListItem {
  id: string;
  size: number;
  updatedAt: string;
}

const API_BASE = '/api/sessions';

export async function cloudSave(
  metadata: SessionMetadata,
  events: AuthoringEvent[],
  checkpoints: Checkpoint[],
  anchors: TimestampAnchor[],
  document: string,
): Promise<void> {
  const data: CloudSession = {
    metadata,
    events,
    checkpoints,
    anchors,
    document,
    savedAt: new Date().toISOString(),
  };

  const resp = await fetch(`${API_BASE}?id=${metadata.sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!resp.ok) {
    throw new Error(`Cloud save failed: ${resp.status}`);
  }
}

export async function cloudLoad(sessionId: string): Promise<CloudSession | null> {
  const resp = await fetch(`${API_BASE}?id=${sessionId}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Cloud load failed: ${resp.status}`);
  return resp.json();
}

export async function cloudList(): Promise<SessionListItem[]> {
  const resp = await fetch(API_BASE);
  if (!resp.ok) throw new Error(`Cloud list failed: ${resp.status}`);
  const data = await resp.json();
  return data.sessions;
}

export async function cloudDelete(sessionId: string): Promise<void> {
  const resp = await fetch(`${API_BASE}?id=${sessionId}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error(`Cloud delete failed: ${resp.status}`);
}

export type { CloudSession, SessionListItem };
