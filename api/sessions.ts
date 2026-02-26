import { put, list, del, head } from '@vercel/blob';

export const config = { runtime: 'edge' };

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

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return cors();

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');

  try {
    // LIST all sessions
    if (req.method === 'GET' && !sessionId) {
      const { blobs } = await list({ prefix: 'sessions/' });
      const sessions = blobs.map(b => ({
        id: b.pathname.replace('sessions/', '').replace('.json', ''),
        size: b.size,
        updatedAt: b.uploadedAt,
        url: b.url,
      }));
      return json({ sessions });
    }

    // GET a specific session
    if (req.method === 'GET' && sessionId) {
      const { blobs } = await list({ prefix: `sessions/${sessionId}.json` });
      if (blobs.length === 0) {
        return json({ error: 'Session not found' }, 404);
      }
      const resp = await fetch(blobs[0].url);
      const data = await resp.json();
      return json(data);
    }

    // SAVE a session
    if (req.method === 'PUT' && sessionId) {
      const body = await req.text();
      const blob = await put(`sessions/${sessionId}.json`, body, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
      });
      return json({ ok: true, url: blob.url });
    }

    // DELETE a session
    if (req.method === 'DELETE' && sessionId) {
      const { blobs } = await list({ prefix: `sessions/${sessionId}.json` });
      if (blobs.length > 0) {
        await del(blobs[0].url);
      }
      return json({ ok: true });
    }

    return json({ error: 'Bad request' }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
