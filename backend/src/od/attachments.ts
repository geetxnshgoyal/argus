import { createHash } from 'node:crypto';
import { appendAudit } from '../audit/audit.ts';
import type { AppContext } from '../context.ts';
import type { Role } from '../db/schema.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../platform/ids.ts';

/** Proof for an OD request: a photo or PDF of the event letter (ADR-0027 amendment). */

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const MAX_ATTACHMENTS = 3;

type Kind = 'image/jpeg' | 'image/png' | 'application/pdf';

/** The file's real type from its first bytes; the name and the phone's claim are not trusted. */
export function sniff(data: Buffer): Kind | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const EXT: Record<Kind, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

function safeName(name: string, kind: Kind): string {
  const base = name.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} ._-]/gu, '_').trim().slice(0, 100) || 'proof';
  return `${base}.${EXT[kind]}`;
}

export async function addAttachment(ctx: AppContext, studentId: string, requestId: string, input: { filename: string; data: string }, ip: string) {
  const data = Buffer.from(input.data, 'base64');
  if (data.length === 0) throw new ApiError(400, 'validation_failed', 'The file is empty.');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'file_too_large', 'Files can be up to 3 MB. Take a photo of the letter instead, or use a smaller PDF.');
  const kind = sniff(data);
  if (!kind) throw new ApiError(415, 'unsupported_file', 'Attach a photo (JPEG or PNG) or a PDF.');
  return ctx.db.transaction().execute(async (tx) => {
    const r = await tx.selectFrom('od_requests').select(['student_id', 'status']).where('id', '=', requestId).forUpdate().executeTakeFirst();
    if (!r || r.student_id !== studentId) throw new ApiError(404, 'not_found', 'Request not found.');
    if (r.status !== 'pending_cm' && r.status !== 'pending_ops') throw new ApiError(409, 'already_decided', 'This request has already been decided.');
    const count = await tx.selectFrom('od_attachments').select((eb) => eb.fn.countAll<string>().as('n')).where('od_request_id', '=', requestId).executeTakeFirst();
    if (Number(count?.n ?? 0) >= MAX_ATTACHMENTS) throw new ApiError(409, 'too_many_files', `Up to ${MAX_ATTACHMENTS} files per request.`);
    const id = uuidv7(ctx.now());
    const sha256 = createHash('sha256').update(data).digest('hex');
    const filename = safeName(input.filename, kind);
    await tx.insertInto('od_attachments').values({ id, od_request_id: requestId, filename, content_type: kind, size: data.length, sha256, data }).execute();
    await appendAudit(tx, { actorId: studentId, action: 'od.attach', entityType: 'od_request', entityId: requestId, after: { attachment_id: id, filename, content_type: kind, size: data.length, sha256 }, ip }, new Date(ctx.now()));
    return { id, filename, content_type: kind, size: data.length };
  });
}

export async function removeAttachment(ctx: AppContext, studentId: string, requestId: string, attachmentId: string, ip: string) {
  await ctx.db.transaction().execute(async (tx) => {
    const r = await tx.selectFrom('od_requests').select(['student_id', 'status']).where('id', '=', requestId).executeTakeFirst();
    if (!r || r.student_id !== studentId) throw new ApiError(404, 'not_found', 'Request not found.');
    if (r.status !== 'pending_cm' && r.status !== 'pending_ops') throw new ApiError(409, 'already_decided', 'This request has already been decided.');
    const del = await tx.deleteFrom('od_attachments').where('id', '=', attachmentId).where('od_request_id', '=', requestId).executeTakeFirst();
    if (del.numDeletedRows === 0n) throw new ApiError(404, 'not_found', 'File not found.');
    await appendAudit(tx, { actorId: studentId, action: 'od.detach', entityType: 'od_request', entityId: requestId, after: { attachment_id: attachmentId }, ip }, new Date(ctx.now()));
  });
  return { ok: true as const };
}

/** The file itself: the requesting student, community managers, Acad Ops and admins. Staff views are audited. */
export async function getAttachment(ctx: AppContext, viewer: { id: string; role: Role }, requestId: string, attachmentId: string, ip: string) {
  const row = await ctx.db
    .selectFrom('od_attachments as a')
    .innerJoin('od_requests as r', 'r.id', 'a.od_request_id')
    .select(['a.filename', 'a.content_type', 'a.data', 'r.student_id'])
    .where('a.id', '=', attachmentId)
    .where('a.od_request_id', '=', requestId)
    .executeTakeFirst();
  const staff = viewer.role === 'community_manager' || viewer.role === 'acadops' || viewer.role === 'admin';
  if (!row || (!staff && row.student_id !== viewer.id)) throw new ApiError(404, 'not_found', 'File not found.');
  if (staff) {
    await ctx.db.transaction().execute((tx) => appendAudit(tx, { actorId: viewer.id, action: 'od.view_attachment', entityType: 'od_request', entityId: requestId, after: { attachment_id: attachmentId }, ip }, new Date(ctx.now())));
  }
  return row;
}
