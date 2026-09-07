import { newId, type Severity, type TicketDTO, type TicketStatus } from '@iris/shared/types';
import type { ScopeContext, Tx } from '../db/with-scope.js';
import { nextReference } from '../products/product.repo.js';

export interface CreateTicketInput {
  productId: string;
  productTenantId: string;
  raisedByRef: string;
  raiserIdentity: { name: string | null; email: string | null };
  identityAssurance: 'sso' | 'email_verified' | 'anonymous';
  subject: string | null;
  description: string;
  category: string | null;
  severity: Severity | null;
  conversationId: string | null;
  metadata: Record<string, unknown>;
}

interface TicketRow {
  id: string;
  reference: string;
  status: TicketStatus;
  product_tenant_id: string;
  subject: string | null;
  description: string;
  category: string | null;
  severity: Severity | null;
  classification_source: TicketDTO['classification_source'];
  summary: string | null;
  raised_by_ref: string;
  raiser_identity: { name?: string | null; email?: string | null };
  identity_assurance: TicketDTO['identity_assurance'];
  rating: number | null;
  rating_comment: string | null;
  raised_at: Date;
  first_response_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  assignee_id: string | null;
  assignee_name: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toDTO(r: TicketRow): TicketDTO {
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    product_tenant_id: r.product_tenant_id,
    subject: r.subject,
    description: r.description,
    category: r.category,
    severity: r.severity,
    classification_source: r.classification_source,
    summary: r.summary,
    raised_by: {
      ref: r.raised_by_ref,
      name: r.raiser_identity?.name ?? null,
      email: r.raiser_identity?.email ?? null,
    },
    identity_assurance: r.identity_assurance,
    rating: r.rating,
    rating_comment: r.rating_comment,
    raised_at: r.raised_at.toISOString(),
    first_response_at: iso(r.first_response_at),
    resolved_at: iso(r.resolved_at),
    closed_at: iso(r.closed_at),
    assignee: r.assignee_id
      ? { id: r.assignee_id, display_name: r.assignee_name ?? 'Support' }
      : null,
  };
}

const SELECT_TICKET = `
  SELECT t.id, t.reference, t.status, t.product_tenant_id, t.subject, t.description,
         t.category, t.severity, t.classification_source, t.summary,
         t.raised_by_ref, t.raiser_identity, t.identity_assurance,
         t.rating, t.rating_comment,
         t.raised_at, t.first_response_at, t.resolved_at, t.closed_at,
         t.assignee_id, su.display_name AS assignee_name
    FROM ticket t
    LEFT JOIN support_user su ON su.id = t.assignee_id`;

export async function insertTicket(tx: Tx, input: CreateTicketInput): Promise<TicketDTO> {
  const id = newId('tkt');
  const reference = await nextReference(tx, input.productId);

  await tx.query(
    `INSERT INTO ticket
       (id, product_id, reference, product_tenant_id, raised_by_ref, raiser_identity,
        identity_assurance, subject, description, category, severity,
        classification_source, conversation_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      input.productId,
      reference,
      input.productTenantId,
      input.raisedByRef,
      JSON.stringify({ ...input.raiserIdentity, product_tenant_id: input.productTenantId }),
      input.identityAssurance,
      input.subject,
      input.description,
      input.category,
      input.severity,
      // If the product supplied category/severity they are authoritative and
      // AI must not override them.
      input.category || input.severity ? 'product' : 'unclassified',
      input.conversationId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const { rows } = await tx.query<TicketRow>(`${SELECT_TICKET} WHERE t.id = $1`, [id]);
  return toDTO(rows[0]!);
}

/** Accepts either the platform id (tkt_…) or the human reference (CARB-1042). */
export async function findTicket(tx: Tx, idOrRef: string): Promise<TicketDTO | null> {
  const { rows } = await tx.query<TicketRow>(
    `${SELECT_TICKET} WHERE t.id = $1 OR upper(t.reference) = upper($1) LIMIT 1`,
    [idOrRef],
  );
  return rows[0] ? toDTO(rows[0]) : null;
}

export interface ListFilters {
  status?: TicketStatus[];
  category?: string[];
  severity?: Severity[];
  productTenantId?: string;
  raisedBy?: string;
  limit: number;
  cursor?: string | null;
}

export async function listTickets(
  tx: Tx,
  f: ListFilters,
): Promise<{ data: TicketDTO[]; next_cursor: string | null; has_more: boolean }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (f.status?.length) add('t.status = ANY(?)', f.status);
  if (f.category?.length) add('t.category = ANY(?)', f.category);
  if (f.severity?.length) add('t.severity = ANY(?)', f.severity);
  if (f.productTenantId) add('t.product_tenant_id = ?', f.productTenantId);
  if (f.raisedBy) add('t.raised_by_ref = ?', f.raisedBy);
  // Cursor is the raised_at of the last row — ULIDs and timestamps both sort,
  // and offset pagination drifts when rows insert mid-scan.
  if (f.cursor) add('t.raised_at < ?', new Date(f.cursor));

  params.push(f.limit + 1);
  const sql = `${SELECT_TICKET}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.raised_at DESC
    LIMIT $${params.length}`;

  const { rows } = await tx.query<TicketRow>(sql, params);
  const hasMore = rows.length > f.limit;
  const page = hasMore ? rows.slice(0, f.limit) : rows;

  return {
    data: page.map(toDTO),
    next_cursor: hasMore ? page[page.length - 1]!.raised_at.toISOString() : null,
    has_more: hasMore,
  };
}

export async function updateStatus(
  tx: Tx,
  ticketId: string,
  next: TicketStatus,
  stamp: Record<string, string | null>,
): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [ticketId, next];
  for (const [col, value] of Object.entries(stamp)) {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  await tx.query(`UPDATE ticket SET ${sets.join(', ')} WHERE id = $1`, params);
}

export async function insertComment(
  tx: Tx,
  ctx: ScopeContext,
  args: {
    productId: string;
    ticketId: string;
    authorType: 'raiser' | 'assignee' | 'system';
    authorRef: string | null;
    authorName: string | null;
    body: string;
    isInternal?: boolean;
  },
): Promise<{ id: string; created_at: string }> {
  const id = newId('cmt');
  const { rows } = await tx.query<{ created_at: Date }>(
    `INSERT INTO comment
       (id, product_id, ticket_id, author_type, author_ref, author_name, body, is_internal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING created_at`,
    [
      id,
      args.productId,
      args.ticketId,
      args.authorType,
      args.authorRef,
      args.authorName,
      args.body,
      args.isInternal ?? false,
    ],
  );

  // first_response_at is the FIRST NON-INTERNAL comment by a support user.
  // Locked definition — ADR-006. Anything looser makes every TAT number arguable.
  if (args.authorType === 'assignee' && !args.isInternal) {
    await tx.query(
      `UPDATE ticket SET first_response_at = coalesce(first_response_at, now())
        WHERE id = $1`,
      [args.ticketId],
    );
  }

  return { id, created_at: rows[0]!.created_at.toISOString() };
}

export async function listComments(tx: Tx, ticketId: string) {
  const { rows } = await tx.query<{
    id: string;
    author_type: 'raiser' | 'assignee' | 'system';
    author_name: string | null;
    body: string;
    created_at: Date;
  }>(
    // RLS already excludes is_internal for product/raiser roles; the explicit
    // predicate is the readable second layer, not the primary defence.
    `SELECT id, author_type, author_name, body, created_at
       FROM comment
      WHERE ticket_id = $1 AND is_internal = false
      ORDER BY created_at ASC`,
    [ticketId],
  );
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

export async function listAttachments(tx: Tx, ticketId: string) {
  const { rows } = await tx.query<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: string;
    created_at: Date;
  }>(
    `SELECT id, filename, content_type, size_bytes, created_at
       FROM attachment WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [ticketId],
  );
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    content_type: r.content_type,
    size_bytes: Number(r.size_bytes),
    created_at: r.created_at.toISOString(),
  }));
}

export async function setRating(
  tx: Tx,
  ticketId: string,
  rating: number,
  comment: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE ticket SET rating = $2, rating_comment = $3, updated_at = now() WHERE id = $1`,
    [ticketId, rating, comment],
  );
}
