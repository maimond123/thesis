import { put, list, del } from '@vercel/blob';

// Use the Node runtime so @vercel/blob's undici-based transport works. The
// Edge runtime doesn't support node:stream / node:net which undici needs.
export const config = { runtime: 'nodejs' };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// Versioned, append-only blob layout. Every PUT writes a NEW immutable blob —
// previous snapshots are never overwritten or modified, so accidental deletes
// or bad writes can't destroy history. Paths look like:
//
//   sessions/{sessionId}/{timestamp}-{rand}.json
//
// GET (with id) returns the LATEST version. LIST returns one row per session
// (de-duped by sessionId, latest version's metadata).

interface BlobLike {
  pathname: string;
  url: string;
  size: number;
  uploadedAt: Date | string;
}

function parseVersionTs(pathname: string): number {
  // sessions/{id}/{ts}-{rand}.json
  const file = pathname.split('/').pop() ?? '';
  const ts = parseInt(file.split('-')[0], 10);
  return Number.isFinite(ts) ? ts : 0;
}

function pickLatest(blobs: BlobLike[]): BlobLike | null {
  if (blobs.length === 0) return null;
  return [...blobs].sort((a, b) => parseVersionTs(b.pathname) - parseVersionTs(a.pathname))[0];
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return cors();

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');

  try {
    // LIST all sessions (one row per sessionId, summarised by latest version)
    if (req.method === 'GET' && !sessionId) {
      const { blobs } = await list({ prefix: 'sessions/' });
      const bySession = new Map<string, BlobLike & { id: string; version: number; versionCount: number }>();
      for (const b of blobs) {
        const parts = b.pathname.split('/');
        if (parts.length < 3) continue; // skip non-versioned legacy blobs
        const id = parts[1];
        const ts = parseVersionTs(b.pathname);
        const existing = bySession.get(id);
        if (!existing) {
          bySession.set(id, { ...b, id, version: ts, versionCount: 1 });
        } else {
          existing.versionCount += 1;
          if (ts > existing.version) {
            existing.pathname = b.pathname;
            existing.url = b.url;
            existing.size = b.size;
            existing.uploadedAt = b.uploadedAt;
            existing.version = ts;
          }
        }
      }
      const sessions = [...bySession.values()].map((s) => ({
        id: s.id,
        size: s.size,
        updatedAt: s.uploadedAt,
        url: s.url,
        versionCount: s.versionCount,
      }));
      return json({ sessions });
    }

    // GET a specific session — latest version
    if (req.method === 'GET' && sessionId) {
      const { blobs } = await list({ prefix: `sessions/${sessionId}/` });
      const latest = pickLatest(blobs);
      if (!latest) return json({ error: 'Session not found' }, 404);
      const resp = await fetch(latest.url);
      const data = await resp.json();
      return json(data);
    }

    // SAVE a session — append a NEW versioned blob; never overwrite.
    if (req.method === 'PUT' && sessionId) {
      const body = await req.text();
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const blob = await put(`sessions/${sessionId}/${ts}-${rand}.json`, body, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
      });
      return json({ ok: true, url: blob.url, version: ts });
    }

    // DELETE all versions of a session
    if (req.method === 'DELETE' && sessionId) {
      const { blobs } = await list({ prefix: `sessions/${sessionId}/` });
      let deleted = 0;
      for (const b of blobs) {
        await del(b.url);
        deleted += 1;
      }
      return json({ ok: true, deleted });
    }

    return json({ error: 'Bad request' }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
