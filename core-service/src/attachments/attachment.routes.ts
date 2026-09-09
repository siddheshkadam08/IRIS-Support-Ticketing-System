import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, newId, notFound } from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { resolveCaller } from '../http/context.js';
import { assertUploadAllowed, storage } from '../storage/index.js';
import { assertImageContentValid } from '../storage/image.js';
import { writeAudit } from '../audit/index.js';
import { emitEvent } from '../events/outbox.js';

/**
 * A link request names attachments the caller already uploaded.
 *
 * Bounded at 20: the widget's own form cannot produce more, and an unbounded
 * array here is an unbounded transaction and an unbounded number of audit rows
 * and outbox events for one request.
 */
const LinkBody = z.object({
  attachment_ids: z.array(z.string().min(1).max(64)).min(1).max(20),
});

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

    /**
     * ⚠️ Phase 19 Step 1. The declared type is now a CHECKED claim.
     *
     * `assertUploadAllowed` above reads the content type out of the multipart
     * header, which the client wrote. This reads the bytes. Until now nothing
     * ever compared the two, so `Content-Type: image/png` carrying arbitrary
     * data was accepted and stored — harmless while nothing decoded it, and
     * not harmless at all once Screenshot AI posts those bytes to a billed
     * external provider.
     *
     * Runs at UPLOAD rather than at analysis time on purpose: it is the only
     * point where the bad file can be refused before it is stored, and a
     * validator that ran later would leave IRIS holding blobs it already knew
     * were lies. It is a no-op for every non-image type, so PDFs, CSVs, ZIPs
     * and Office documents are completely unaffected.
     */
    assertImageContentValid(file.mimetype, buffer);

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

  /**
   * ── POST /v1/tickets/:id/attachments ─────────────────────────────────
   *
   * Attach previously-uploaded files to a ticket.
   *
   * ⚠️ WHY THIS ENDPOINT EXISTS AT ALL, AND WHY THAT IS THE HARD PART.
   *
   * An attachment is uploaded BEFORE the ticket exists — the widget uploads
   * each file as the customer picks it, then creates the ticket, then calls
   * this. So an attachment row spends time with `ticket_id IS NULL`, owned by
   * a product but by no ticket, and this is the operation that closes that gap.
   *
   * ⚠️ THE OWNERSHIP CHECK (Phase 19 Step 1). This previously matched on
   * `id = ANY($ids) AND ticket_id IS NULL` and nothing else.
   *
   * `attachment_isolation` restricts a raiser to attachments on their OWN
   * tickets — but that clause only bites once `ticket_id` is set. While it is
   * NULL the policy's raiser arm passes unconditionally, so every unlinked
   * attachment in a product was visible, and therefore linkable, by every
   * raiser in that product. One customer could attach another customer's
   * pending upload to their own ticket and then read it back through the
   * ticket. Ids are ULIDs so this was never practically enumerable, but
   * "hard to guess" is not the property this needs: Screenshot AI is about to
   * treat "this attachment came from this ticket's raiser" as a fact, and it
   * was not one.
   *
   * The rule is derived from the schema rather than invented: `uploaded_by`
   * already records the raiser reference at upload time, and it is NULL for a
   * product-credential upload. So a raiser must match it, and a product
   * credential — which owns everything in its own tenant already — keeps the
   * behaviour it has. No new authorization concept is introduced.
   *
   * ⚠️ EVERY REFUSAL IS A NOT-FOUND, and they are indistinguishable. Foreign
   * product, foreign uploader, already linked and does-not-exist all return
   * the same shape, because separating them tells a prober which attachment
   * ids exist and who owns them.
   */
  app.post<{ Params: { id: string } }>('/v1/tickets/:id/attachments', async (req) => {
    const caller = await resolveCaller(req);
    const body = LinkBody.parse(req.body);
    // A repeated id would otherwise produce two audit rows and two events for
    // one attachment, and break the row-count check below.
    const ids = [...new Set(body.attachment_ids)];

    return withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM ticket WHERE id = $1 OR upper(reference) = upper($1) LIMIT 1`,
        [req.params.id],
      );
      const ticket = rows[0];
      if (!ticket) throw notFound();

      /**
       * Read the candidates FIRST, under RLS, so every decision below is made
       * against what the database actually holds rather than against the
       * request. A row outside the caller's product is invisible here, so it
       * fails the count check and never reaches the ownership test — product
       * isolation stays entirely with RLS, exactly as it was.
       */
      const { rows: candidates } = await tx.query<{
        id: string;
        ticket_id: string | null;
        uploaded_by: string | null;
        content_type: string;
        size_bytes: string;
      }>(
        `SELECT id, ticket_id, uploaded_by, content_type, size_bytes
           FROM attachment WHERE id = ANY($1)`,
        [ids],
      );

      if (candidates.length !== ids.length) {
        throw notFound('No such attachment is available to link.');
      }

      for (const a of candidates) {
        // Already attached — to this ticket or any other. Re-linking would
        // move a file between tickets, which is not what this endpoint means.
        if (a.ticket_id !== null) {
          throw notFound('No such attachment is available to link.');
        }
        /**
         * The ownership rule. Only a raiser is constrained: `uploaded_by` is
         * their reference, and it is NULL for a product-credential upload,
         * so requiring equality for role 'product' would break the server-side
         * integration path that legitimately uploads on a customer's behalf.
         */
        if (caller.scope.role === 'raiser' && a.uploaded_by !== caller.scope.raiserRef) {
          throw notFound('No such attachment is available to link.');
        }
      }

      /**
       * `AND ticket_id IS NULL` is repeated here as a race guard, not as a
       * restatement. Two concurrent link requests naming the same attachment
       * both pass the loop above; only one can satisfy this predicate, and the
       * loser's row count comes up short and rolls the whole transaction back.
       * Without it the second request would report success having linked
       * nothing.
       */
      const updated = await tx.query(
        `UPDATE attachment SET ticket_id = $1 WHERE id = ANY($2) AND ticket_id IS NULL`,
        [ticket.id, ids],
      );
      if ((updated.rowCount ?? 0) !== ids.length) {
        throw notFound('No such attachment is available to link.');
      }

      for (const a of candidates) {
        /**
         * Audit, in the SAME transaction as the link. If anything below throws
         * — including the row-count guard above on a concurrent request — the
         * link and its audit roll back together, so the trail can never claim
         * an attachment was linked when it was not.
         *
         * ⚠️ NO BYTES, NO BASE64, NO FILENAME. `content_type` and `size_bytes`
         * are metadata IRIS measured itself. The filename is customer-supplied
         * text that regularly names an account, a company or an invoice; it is
         * already recorded once by `attachment.uploaded`, and repeating it here
         * would spread it for no diagnostic gain.
         */
        await writeAudit(tx, caller.scope, {
          action: 'attachment.linked',
          entityType: 'attachment',
          entityId: a.id,
          productId: caller.product.id,
          before: { ticket_id: null },
          after: {
            ticket_id: ticket.id,
            content_type: a.content_type,
            size_bytes: Number(a.size_bytes),
          },
          sourceIp: req.ip,
        });

        /**
         * ⚠️ THE EVENT SCREENSHOT AI WILL EVENTUALLY CONSUME — Phase 19 Step 1.
         *
         * WHY IT IS NOT `ticket.created`. The widget uploads, then creates the
         * ticket, then links. `ticket.created` is emitted inside the CREATE
         * transaction, which commits before this request is even sent, so a job
         * dispatched from it would look for attachments that are not yet
         * attached and usually find none. That is a race no retry policy fixes,
         * because the job would succeed — at finding nothing.
         *
         * Emitting here makes the ordering structural: the event cannot exist
         * unless the row it describes is already linked, in the same
         * transaction, with the same commit.
         *
         * ⚠️ ONE EVENT PER ATTACHMENT, NOT PER BATCH. `ai_execution` keys
         * idempotency on UNIQUE(event_id, feature), so a batch event would give
         * three screenshots one execution row, one retry budget and one
         * outcome — one unreadable image would fail the other two. Per
         * attachment matches the granularity the ledger already has.
         *
         * ⚠️ NOTHING DISPATCHES THIS YET, AND THAT IS CORRECT. The AI
         * dispatcher reads AI_EVENT_FEATURES and the webhook publisher filters
         * to `access.*`; this type is in neither, so rows accumulate visibly in
         * `event_outbox` and are consumed by nothing. Step 2 adds the mapping.
         *
         * The payload names the two ids and the two facts a consumer needs to
         * decide eligibility. No filename, no raiser reference, no product
         * tenant id — `product_id` is carried by the outbox column itself and
         * is passed explicitly so the row can never be written with a NULL the
         * dispatcher would skip.
         */
        await emitEvent(
          tx,
          caller.scope,
          'ticket.attachment_linked',
          {
            ticket_id: ticket.id,
            attachment_id: a.id,
            content_type: a.content_type,
            size_bytes: Number(a.size_bytes),
          },
          'ticket',
          ticket.id,
          caller.product.id,
        );
      }

      return { linked: candidates.length };
    });
  });
}
