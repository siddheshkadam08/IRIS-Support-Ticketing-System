import { signWebhook } from '@iris/shared/hmac';
import { decryptSecret } from '@iris/shared/types';
import { withSystemScope } from '../db/with-scope.js';
import { logger } from '../logger.js';

/**
 * The drainer is a background process with no request context, so it has no
 * RLS session scope — and an unscoped read correctly returns ZERO rows. Every
 * query here therefore runs through withSystemScope.
 *
 * This is RLS working as designed: a process that forgets to establish scope
 * sees nothing rather than seeing everything.
 */
const sys = <T>(fn: (tx: import('../db/with-scope.js').Tx) => Promise<T>): Promise<T> =>
  withSystemScope('outbox-drainer', fn);

/**
 * In-process outbox drainer.
 *
 * ⚠️ This is a STAND-IN for the `worker` service, which is not built yet. It
 * lives here so the access-grant cycle is complete and demonstrable today.
 * When `worker` lands, delete this file and consume the same outbox rows from
 * BullMQ — the table, the payloads and the retry policy are unchanged.
 *
 * It is deliberately conservative: one row at a time, short poll, and every
 * attempt written to delivery_log so a failure is visible rather than silent.
 */

/** 1s → 5s → 25s → 2m → 10m, then dead-letter. Matches api-contract §6.4. */
const BACKOFF_SECONDS = [1, 5, 25, 120, 600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const POLL_MS = 1000;
const CALLBACK_TIMEOUT_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface OutboxRow {
  id: string;
  event_id: string;
  product_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  request_id: string | null;
  aggregate_id: string | null;
}

export function startPublisher(): void {
  if (timer) return;
  logger.info('outbox drainer started (stand-in for the worker service)');
  timer = setInterval(() => {
    if (running) return;
    running = true;
    drain()
      .catch((err) => logger.error({ err }, 'outbox drain failed'))
      .finally(() => {
        running = false;
      });
  }, POLL_MS);
  timer.unref();
}

export function stopPublisher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function drain(): Promise<void> {
  const rows = await sys(async (tx) => {
    const { rows } = await tx.query<OutboxRow>(
      `SELECT id, event_id, product_id, event_type, payload, request_id, aggregate_id
         FROM event_outbox
        WHERE published_at IS NULL
          AND event_type IN ('access.grant_requested','access.revoke_requested')
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at ASC
        LIMIT 5`,
    );
    return rows;
  });
  for (const row of rows) await deliver(row);
}

async function deliver(row: OutboxRow): Promise<void> {
  const product = await sys(async (tx) => {
    const { rows } = await tx.query<{
      access_callback_url: string | null;
      webhook_secret_enc: string | null;
      client_secret_enc: string | null;
    }>(
      `SELECT access_callback_url, webhook_secret_enc, client_secret_enc
         FROM product WHERE id = $1`,
      [row.product_id],
    );
    return rows[0] ?? null;
  });

  if (!product?.access_callback_url) {
    // Nothing to deliver to. Mark published so it does not spin forever, and
    // say so — a silently skipped access event would be worse than a failure.
    await sys((tx) => tx.query(`UPDATE event_outbox SET published_at = now() WHERE id = $1`, [row.id]));
    logger.warn(
      { eventId: row.event_id, productId: row.product_id },
      'access event has no callback URL configured — skipped',
    );
    return;
  }

  const grantId = row.aggregate_id;
  const grant = await sys(async (tx) => {
    const { rows } = await tx.query<{ attempt_count: number; product_grant_ref: string | null }>(
      `SELECT attempt_count, product_grant_ref FROM access_grant WHERE id = $1`,
      [grantId],
    );
    return rows[0] ?? null;
  });
  const attempt = (grant?.attempt_count ?? 0) + 1;

  const body = JSON.stringify({
    event_id: row.event_id,
    event: row.event_type,
    api_version: 'v1',
    occurred_at: new Date().toISOString(),
    grant_id: grantId,
    product_grant_ref: grant?.product_grant_ref ?? null,
    data: row.payload,
  });

  const timestamp = Math.floor(Date.now() / 1000);
  let signature: string;
  try {
    // Signing needs the secret itself, which is why it is stored encrypted
    // rather than hashed.
    const secret = decryptSecret(product.webhook_secret_enc ?? product.client_secret_enc ?? '');
    signature = `t=${timestamp},v1=${signWebhook(secret, timestamp, body)}`;
  } catch (err) {
    logger.error({ err, productId: row.product_id }, 'cannot sign access callback — no usable secret');
    await failAttempt(row, grantId, attempt, null, 'no signing secret configured', 0, true);
    return;
  }

  const startedAt = Date.now();
  let statusCode: number | null = null;
  let responseText = '';
  let error: string | null = null;

  try {
    const res = await fetch(product.access_callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IRIS-Signature': signature,
        'X-Request-Id': row.request_id ?? row.event_id,
      },
      body,
      // Never follow redirects: a 302 to an attacker-controlled host would
      // replay our signed payload somewhere we did not intend.
      redirect: 'manual',
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    statusCode = res.status;
    responseText = (await res.text()).slice(0, 2000);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const latency = Date.now() - startedAt;
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;

  await sys((tx) =>
    tx.query(
      `INSERT INTO delivery_log
         (product_id, channel, event_id, target, attempt, status_code, ok, response_body, error, latency_ms)
       VALUES ($1,'access_callback',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.product_id,
        row.event_id,
        product.access_callback_url,
        attempt,
        statusCode,
        ok,
        responseText || null,
        error,
        latency,
      ],
    ),
  );

  if (ok) {
    await succeed(row, grantId, attempt, responseText, latency);
  } else {
    // A 4xx means our payload is wrong — retrying it five times only delays
    // the alert. Fail fast on client errors, retry on 5xx and network errors.
    const isClientError = statusCode !== null && statusCode >= 400 && statusCode < 500;
    await failAttempt(row, grantId, attempt, statusCode, error ?? responseText, latency, isClientError);
  }
}

async function succeed(
  row: OutboxRow,
  grantId: string | null,
  attempt: number,
  responseText: string,
  latency: number,
): Promise<void> {
  let parsed: unknown = null;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = { raw: responseText };
  }
  const productRef = (parsed as { product_grant_ref?: string } | null)?.product_grant_ref ?? null;
  const isGrant = row.event_type === 'access.grant_requested';

  await sys(async (tx) => {
    if (grantId) {
      await tx.query(
        `UPDATE access_grant
            SET state = $2,
                attempt_count = $3,
                ${isGrant ? 'activation_response' : 'revoke_response'} = $4::jsonb,
                product_grant_ref = COALESCE($5, product_grant_ref),
                revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE revoked_at END,
                last_error = NULL
          WHERE id = $1`,
        [grantId, isGrant ? 'granted' : 'revoked', attempt, JSON.stringify(parsed), productRef],
      );
    }
    await tx.query(`UPDATE event_outbox SET published_at = now() WHERE id = $1`, [row.id]);
  });
  logger.info(
    { eventId: row.event_id, grantId, attempt, latency },
    isGrant ? 'access grant confirmed by product' : 'access revoke confirmed by product',
  );
}

async function failAttempt(
  row: OutboxRow,
  grantId: string | null,
  attempt: number,
  statusCode: number | null,
  message: string,
  latency: number,
  failFast = false,
): Promise<void> {
  const exhausted = failFast || attempt >= MAX_ATTEMPTS;
  const isRevoke = row.event_type === 'access.revoke_requested';

  if (grantId) {
    await sys((tx) =>
      tx.query(
        `UPDATE access_grant
            SET attempt_count = $2,
                last_error = $3,
                state = CASE WHEN $4 THEN $5 ELSE state END
          WHERE id = $1`,
        [
          grantId,
          attempt,
          `${statusCode ?? 'network'}: ${message}`.slice(0, 500),
          exhausted,
          isRevoke ? 'revoke_failed' : 'grant_failed',
        ],
      ),
    );
  }

  if (exhausted) {
    // Dead-letter. A dead-lettered REVOKE is a security incident, not a
    // delivery warning — the portal renders it red at the top of the ticket.
    await sys((tx) => tx.query(`UPDATE event_outbox SET published_at = now() WHERE id = $1`, [row.id]));
    logger[isRevoke ? 'error' : 'warn'](
      { eventId: row.event_id, grantId, attempt, statusCode, message },
      isRevoke
        ? 'ACCESS REVOKE FAILED after all retries — dead-lettered. Access may outlive the ticket.'
        : 'access grant failed after all retries — dead-lettered',
    );
  } else {
    const delay = BACKOFF_SECONDS[attempt - 1] ?? 600;
    await sys((tx) =>
      tx.query(
        `UPDATE event_outbox SET next_attempt_at = now() + ($2 || ' seconds')::interval WHERE id = $1`,
        [row.id, delay],
      ),
    );
    logger.warn(
      { eventId: row.event_id, attempt, statusCode, retryInSeconds: delay },
      'access callback failed — will retry',
    );
  }
}
