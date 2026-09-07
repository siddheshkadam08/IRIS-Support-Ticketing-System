import type { FastifyInstance } from 'fastify';
import { AppError, newId, notFound } from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { resolveCaller } from '../http/context.js';
import { assertUploadAllowed, storage } from '../storage/index.js';
import { writeAudit } from '../audit/index.js';

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/attachments (multipart) ───────────────────────────────────
  app.post('/v1/attachments', async (req, reply) => {
    const caller = await resolveCaller(req);
    const file = await req.file();
    if (!file) throw new AppError('invalid_request', 'No file supplied.');

    const buffer = await file.toBuffer();
    // Server-side validation is the enforcement; the widget's client-side
    // check is only fast feedback.
    assertUploadAllowed(file.mimetype, buffer.byteLength);

    const blobKey = await storage.put(caller.product.id, file.filename, file.mimetype, buffer);
    const id = newId('att');

    await withScope(caller.scope, async (tx) => {
      await tx.query(
        `INSERT INTO attachment
           (id, product_id, blob_key, filename, content_type, size_bytes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          caller.product.id,
          blobKey,
          file.filename,
          file.mimetype,
          buffer.byteLength,
          caller.scope.raiserRef ?? null,
        ],
      );
      await writeAudit(tx, caller.scope, {
        action: 'attachment.uploaded',
        entityType: 'attachment',
        entityId: id,
        after: { filename: file.filename, size_bytes: buffer.byteLength },
        sourceIp: req.ip,
      });
    });

    return reply.status(201).send({
      id,
      filename: file.filename,
      content_type: file.mimetype,
      size_bytes: buffer.byteLength,
    });
  });

  // ── GET /v1/attachments/:id/content ────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/attachments/:id/content', async (req, reply) => {
    const caller = await resolveCaller(req);

    const row = await withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<{
        blob_key: string;
        filename: string;
        content_type: string;
      }>(`SELECT blob_key, filename, content_type FROM attachment WHERE id = $1`, [req.params.id]);
      return rows[0] ?? null;
    });
    if (!row) throw notFound('No such attachment.');

    const data = await storage.get(row.blob_key);

    // NEVER rendered inline. An SVG or HTML attachment displayed inline in an
    // authenticated session is stored XSS — see docs/HLD.md §16.3. The
    // allowlist blocks those types on upload; these headers are the second layer.
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(row.filename)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(data);
  });

  // Attach an uploaded file to a ticket after creation.
  app.post<{ Params: { id: string } }>('/v1/tickets/:id/attachments', async (req) => {
    const caller = await resolveCaller(req);
    const body = req.body as { attachment_ids?: string[] };
    const ids = body?.attachment_ids ?? [];
    if (!ids.length) return { linked: 0 };

    const linked = await withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM ticket WHERE id = $1 OR upper(reference) = upper($1) LIMIT 1`,
        [req.params.id],
      );
      const ticket = rows[0];
      if (!ticket) throw notFound();

      const res = await tx.query(
        `UPDATE attachment SET ticket_id = $1 WHERE id = ANY($2) AND ticket_id IS NULL`,
        [ticket.id, ids],
      );
      return res.rowCount ?? 0;
    });

    return { linked };
  });
}
