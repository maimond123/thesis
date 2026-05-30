import { canonicalJsonStringify } from '../crypto/hash-chain';
import { verifySignature } from '../crypto/signing';
import type { Comment } from './types';

// The fields that are covered by a comment's signature. `id` and `authorHandle`
// are intentionally excluded — both are client-generated display metadata; the
// thumbprint + signature are what verify authorship.
export interface SignedCommentFields {
  authorThumbprint: string;
  threadId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
}

// One source of truth for the canonical payload used by both signer and verifier.
// Any future field that should be tamper-evident must be added here in both
// places — otherwise a verifier built against an older payload version will
// accept tampered comments on the new field.
export function commentSigningPayload(fields: SignedCommentFields): string {
  return canonicalJsonStringify({
    authorThumbprint: fields.authorThumbprint,
    threadId: fields.threadId,
    parentId: fields.parentId,
    body: fields.body,
    createdAt: fields.createdAt,
  });
}

// signComment takes a signer callback rather than a CryptoKey so the caller
// (typically CommentStore) can delegate signing to the IdentityStore's
// in-memory key without exposing the CryptoKey across module boundaries.
export async function signComment(
  fields: SignedCommentFields,
  signer: (data: string) => Promise<string>,
): Promise<string> {
  return signer(commentSigningPayload(fields));
}

export async function verifyComment(
  comment: Comment,
  publicKey: JsonWebKey,
): Promise<boolean> {
  const payload = commentSigningPayload({
    authorThumbprint: comment.authorThumbprint,
    threadId: comment.threadId,
    parentId: comment.parentId,
    body: comment.body,
    createdAt: comment.createdAt,
  });
  return verifySignature(publicKey, comment.signature, payload);
}
