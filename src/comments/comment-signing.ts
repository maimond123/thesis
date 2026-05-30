import type { Comment } from './types';
import { canonicalJsonStringify } from '../crypto/hash-chain';
import { verifySignature } from '../crypto/signing';

// The canonical-JSON shape every comment signature is computed over. id is
// NOT signed — it's a client-generated UUID and could collide on its own
// without weakening tamper-evidence (the body+author+thread+parent+time tuple
// is what authenticates the message). authorHandle is display metadata and
// also excluded; the authorThumbprint is the authoritative identity.
//
// Pin the field set explicitly: drifting this shape across versions would
// silently break signature verification for any pre-drift comment.
export interface SignableCommentPayload {
  authorThumbprint: string;
  threadId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
}

export function commentSigningPayload(c: Comment): string {
  const payload: SignableCommentPayload = {
    authorThumbprint: c.authorThumbprint,
    threadId: c.threadId,
    parentId: c.parentId,
    body: c.body,
    createdAt: c.createdAt,
  };
  return canonicalJsonStringify(payload as unknown as Record<string, unknown>);
}

// Sign a comment payload. The caller (CommentStore) supplies the signer —
// usually IdentityStore.signWithSelf — so this module stays Y.Doc and IDB
// free and easy to test.
export async function signComment(
  c: Comment,
  signer: (data: string) => Promise<string>,
): Promise<string> {
  return signer(commentSigningPayload(c));
}

// Verify a comment's signature against the author's public key from the
// roster. Returns false on any failure; does not throw on tampered input.
export async function verifyComment(c: Comment, publicKey: JsonWebKey): Promise<boolean> {
  try {
    return await verifySignature(publicKey, c.signature, commentSigningPayload(c));
  } catch {
    return false;
  }
}
