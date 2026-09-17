/**
 * Files on a message — P3-21, phase 3.
 *
 * Ritesh, 11 September: images and PDFs, up to 10 MB.
 *
 * WHERE THEY LIVE
 *
 * In the database, as bytes, exactly as a product brochure does. That is the
 * convention this codebase already has, and it keeps a file wherever the
 * database is -- which for a firm whose client data may not leave India is the
 * question that matters. No second place to back up, and no directory of
 * client documents sitting beside the app.
 *
 * WHAT IS ACCEPTED
 *
 * The extension AND the first bytes have to agree. A Content-Type is whatever
 * the caller says it is, and an extension is whatever they renamed it to, so
 * neither is trusted alone: `payload.exe` renamed `photo.png` is refused
 * because it does not start like a PNG. That is not virus scanning -- the CRM
 * has none, and a PDF can still carry something nasty inside -- it only means
 * what arrives is the kind of file it claims to be.
 *
 * WHO CAN READ ONE
 *
 * Whoever can read the conversation it was sent in, and a reviewer whose books
 * it falls in. The bytes go out with `nosniff` and a filename, never as HTML,
 * so an uploaded file cannot become a page running on the CRM's own origin.
 */

import { all, one, run, audit } from '../db.js';
import { isMember, monitorCanSee, suspensionOf } from './messaging.js';

/** Ritesh, 11 September. */
export const MAX_BYTES = 10 * 1024 * 1024;

/* Extension, the type it is served as, and how the file itself must start. */
const KINDS = [
  { ext: '.pdf', mime: 'application/pdf', label: 'PDF', magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: '.png', mime: 'image/png', label: 'PNG image', magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: '.jpg', mime: 'image/jpeg', label: 'JPEG image', magic: [0xff, 0xd8, 0xff] },
  { ext: '.jpeg', mime: 'image/jpeg', label: 'JPEG image', magic: [0xff, 0xd8, 0xff] },
  { ext: '.gif', mime: 'image/gif', label: 'GIF image', magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: '.webp', mime: 'image/webp', label: 'WebP image', magic: [0x52, 0x49, 0x46, 0x46] },
];

export const ACCEPTED = KINDS.map((k) => k.ext).join(', ');

const startsWith = (bytes, magic) => magic.every((b, i) => bytes[i] === b);

const looksRight = (bytes, kind) => {
  if (!startsWith(bytes, kind.magic)) return false;
  // RIFF is also a WAV or an AVI; the four bytes at 8 say which.
  if (kind.ext === '.webp') return bytes.slice(8, 12).toString('latin1') === 'WEBP';
  return true;
};

export const isImage = (mime) => String(mime ?? '').startsWith('image/');

/** A file, as a message shows it. Never the bytes. */
export const describe = (f) => (f ? {
  id: f.id,
  filename: f.filename,
  mime: f.mime,
  size: f.size,
  is_image: isImage(f.mime),
} : null);

/** Files for a page of messages, keyed by message id. */
export function filesOn(messageIds) {
  const out = new Map();
  if (!messageIds.length) return out;
  for (const f of all(
    `SELECT id, message_id, filename, mime, size FROM message_file
      WHERE message_id IN (${messageIds.map(() => '?').join(',')})`,
    messageIds,
  )) out.set(f.message_id, describe(f));
  return out;
}

/**
 * Take a file, before the message that carries it is written.
 *
 * Two steps rather than one: the bytes arrive as a raw body, and a message has
 * a body of its own to carry as well. The row waits with no message against it
 * until the send names it, and an upload nobody ever sent is swept a day later
 * rather than kept for ever.
 */
export function upload(user, conversationId, bytes, rawName) {
  const convo = conversationId ? one('SELECT * FROM conversation WHERE id = ?', [conversationId]) : null;
  if (!convo || !isMember(conversationId, user.id)) {
    return { ok: false, status: 404, error: 'Conversation not found' };
  }
  if (convo.frozen_at) return { ok: false, status: 409, error: 'This conversation is frozen' };
  if (convo.archived_at) return { ok: false, status: 409, error: 'This channel is archived' };

  const suspended = suspensionOf(user.id);
  if (suspended) return { ok: false, status: 403, error: `Your messaging is suspended: ${suspended.reason}` };

  if (!Buffer.isBuffer(bytes) || !bytes.length) return { ok: false, status: 400, error: 'No file was sent' };
  if (bytes.length > MAX_BYTES) {
    return { ok: false, status: 400, error: `That file is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB` };
  }

  const filename = String(rawName ?? 'file').replace(/[^\w.\- ]+/g, '').trim().slice(0, 120) || 'file';
  const kind = KINDS.find((k) => filename.toLowerCase().endsWith(k.ext));
  if (!kind) {
    return { ok: false, status: 400, error: `${filename} is not a kind of file that can be sent here`, accepted: ACCEPTED };
  }
  if (!looksRight(bytes, kind)) {
    return { ok: false, status: 400, error: `That file is named like a ${kind.label} but does not start like one` };
  }

  /* Uploads nobody sent. Swept here rather than on a timer: this is the only
     place they are made, so it is the only place they can pile up. */
  run(
    "DELETE FROM message_file WHERE message_id IS NULL AND uploaded_by = ? AND created_at < datetime('now', '-1 day')",
    [user.id],
  );

  const id = Number(run(
    `INSERT INTO message_file (conversation_id, uploaded_by, filename, mime, size, bytes)
     VALUES (?,?,?,?,?,?)`,
    [conversationId, user.id, filename, kind.mime, bytes.length, bytes],
  ).lastInsertRowid);

  audit(user.id, 'message_file_uploaded', 'conversation', conversationId, {
    file_id: id, filename, size: bytes.length,
  });
  return { ok: true, file: { id, filename, mime: kind.mime, size: bytes.length, is_image: isImage(kind.mime) } };
}

/**
 * Tie an uploaded file to the message that carries it.
 *
 * Only the person who uploaded it, only into the conversation it was uploaded
 * for, and only once -- so a file id cannot be replayed into a second message,
 * or into somebody else's.
 */
export function attach(fileId, messageId, user, conversationId) {
  const f = one('SELECT * FROM message_file WHERE id = ?', [Number(fileId)]);
  if (!f
    || Number(f.uploaded_by) !== Number(user.id)
    || Number(f.conversation_id) !== Number(conversationId)
    || f.message_id != null) {
    return false;
  }
  run('UPDATE message_file SET message_id = ? WHERE id = ?', [messageId, f.id]);
  return true;
}

/**
 * The bytes, for somebody allowed to have them.
 *
 * A reviewer may read a file in a conversation they may review, and that read
 * is audited exactly as reading the conversation is -- a file is the part of a
 * message most worth knowing somebody opened.
 */
export function bytesFor(reader, fileId) {
  const f = fileId ? one('SELECT * FROM message_file WHERE id = ?', [Number(fileId)]) : null;
  if (!f) return { ok: false, status: 404, error: 'File not found' };

  if (!isMember(f.conversation_id, reader.id)) {
    const reviewing = reader.capabilities?.has('comms.monitor') && monitorCanSee(reader, f.conversation_id);
    if (!reviewing) return { ok: false, status: 404, error: 'File not found' };
    audit(reader.id, 'message_file_reviewed', 'conversation', f.conversation_id, { file_id: f.id });
  }
  return { ok: true, file: f };
}
