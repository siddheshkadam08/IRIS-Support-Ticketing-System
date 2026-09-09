import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { requestSignatureHeader } from '@iris/shared/hmac';
import { newId } from '@iris/shared/types';
import { buildServer } from '../server.js';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { withScope, withSystemScope, type Tx } from '../db/with-scope.js';
import { compositeConfidence } from './classification.rules.js';

/**
 * `ai_execution.confidence` semantics — finding G-1.
 *
 * The column was NULL in all 12,787 rows, and not because the value did not
 * exist. `features.py` deliberately returns `confidence=None` for every
 * feature — "the weakest-link composite is computed by CORE… reporting one here
 * too would be a second source of truth" — and Core stored that null while
 * writing the real composite one level down, into `result.decision`.
 *
 * The contract these tests pin:
 *
 *   classification -> Core's weakest-link composite (the MINIMUM of the four
 *                     field confidences the model reported)
 *   summary, noop  -> NULL, because neither produces a comparable scalar
 *
 * ⚠️ AND IT IS NOT A PROBABILITY OF CORRECTNESS. It is the model's own
 * uncalibrated signal — the reason `auto_route_p1 = 1.01` disables unattended
 * routing. These tests assert the number, never a meaning it cannot carry.
 *
 *   npm run infra:up && npm run migrate && npm run seed
 *   npx vitest run core-service/src/internal/confidence-semantics.test.ts
 */

const PRODUCT = 'prod_carbon';
let app: Awaited<ReturnType<typeof buildServer>>;
const created: string[] = [];

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystemScope('p17-conf', fn);
const asProduct = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withScope({ productScope: [PRODUCT], role: 'none', requestId: 'p17-conf' }, fn);

function signed(path: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  return {
    'content-type': 'application/json',
    'x-iris-service-id': 'worker',
    'x-iris-timestamp': String(timestamp),
    'x-iris-nonce': nonce,
    'x-iris-signature': requestSignatureHeader(config.AI_WORKER_HMAC_SECRET, {
      method: 'POST',
      path,
      timestamp,
      nonce,
      body: Buffer.from(body, 'utf8'),
    }),
  };
}

const postSigned = (eventId: string, kind: 'input' | 'result', body: unknown) => {
  const path = `/internal/ai/jobs/${eventId}/${kind}`;
  const serialised = JSON.stringify(body);
  return app.inject({ method: 'POST', url: path, headers: signed(path, serialised), payload: serialised });
};

const postResult = (eventId: string, body: unknown) => postSigned(eventId, 'result', body);

/**
 * Claim the execution before completing it.
 *
 * `/input` is what creates the `running` row; posting a result for an
 * unclaimed execution is a 404, which is the pipeline refusing to invent one.
 * The first version of this suite skipped it and every assertion failed on a
 * null row — the right failure, and the reason the helper exists.
 */
async function claimFirst(job: { eventId: string; ticketId: string; jobId: string }, feature: string) {
  const res = await postSigned(job.eventId, 'input', claim(job, feature));
  if (res.statusCode !== 200) throw new Error(`claim failed: ${res.statusCode} ${res.body}`);
}

/** A ticket plus the outbox event the pipeline resolves identity from. */
async function makeJob(): Promise<{ eventId: string; ticketId: string; jobId: string }> {
  const ticketId = `tkt_p17c_${Math.random().toString(36).slice(2, 12)}`;
  const eventId = newId('evt');
  await asProduct(async (tx) => {
    await tx.query(
      `INSERT INTO ticket (id, product_id, reference, product_tenant_id, raised_by_ref,
                           subject, description, status)
       VALUES ($1,$2,$3,'acme-corp','p17c','Export fails','The export fails after a minute.','open')`,
      [ticketId, PRODUCT, `P17C-${ticketId.slice(-6).toUpperCase()}`],
    );
    await tx.query(
      `INSERT INTO event_outbox (event_id, product_id, aggregate, aggregate_id, event_type, payload, request_id)
       VALUES ($1,$2,'ticket',$3,'ticket.created','{}'::jsonb,$4)`,
      [eventId, PRODUCT, ticketId, `req_${eventId}`],
    );
  });
  created.push(ticketId);
  return { eventId, ticketId, jobId: newId('aij') };
}

/** A valid classification payload with chosen field confidences. */
const classificationResult = (c: {
  category: number;
  issueType: number;
  impact: number;
  factor: number;
}) => ({
  feature: 'classification',
  status: 'succeeded',
  data: {
    category: 'reports',
    category_confidence: c.category,
    category_runner_up: null,
    category_runner_up_confidence: null,
    issue_type: 'Bug',
    issue_type_confidence: c.issueType,
    impact: 'Multiple Users',
    impact_confidence: c.impact,
    sentiment: 'neutral',
    keywords_tags: ['export'],
    rationale: 'The customer reports an export failure.',
    priority_factors: {
      security_or_data_loss: false,
      system_down: false,
      hours_until_deadline: null,
      regulatory_impact: false,
      workaround_available: false,
      cosmetic_only: false,
      priority_factor_confidence: c.factor,
    },
  },
  provider: 'azure',
  model: 'azure/gpt-4.1',
  model_version: '2024-12-01-preview',
  prompt_version: 'classification-v1',
  latency_ms: 1234,
  fallback_used: false,
});

const readExecution = (eventId: string, feature: string) =>
  sys(async (tx) => {
    const { rows } = await tx.query<{
      confidence: string | null;
      result: Record<string, unknown> | null;
      model_version: string | null;
      status: string;
    }>(`SELECT confidence, result, model_version, status FROM ai_execution WHERE event_id = $1 AND feature = $2`, [
      eventId,
      feature,
    ]);
    return rows[0] ?? null;
  });

const claim = (j: { eventId: string; ticketId: string; jobId: string }, feature: string) => ({
  job_id: j.jobId,
  feature,
  attempt: 1,
  correlation_id: `req_${j.eventId}`,
  claimed_product_id: PRODUCT,
  claimed_ticket_id: j.ticketId,
});

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  for (const id of created) {
    await sys((tx) => tx.query(`DELETE FROM ai_execution WHERE ticket_id = $1`, [id]).catch(() => undefined));
    await sys((tx) => tx.query(`DELETE FROM event_outbox WHERE aggregate_id = $1`, [id]));
    await sys((tx) => tx.query(`DELETE FROM ticket WHERE id = $1`, [id]));
  }
  await app.close();
  await closePool();
});

describe('⚠️ classification writes CORE’s composite, not the model’s null', () => {
  it('stores the weakest link of the four field confidences', async () => {
    const job = await makeJob();
    const fields = { category: 0.91, issueType: 0.77, impact: 0.84, factor: 0.95 };

    await claimFirst(job, 'classification');
    const res = await postResult(job.eventId, {
      ...claim(job, 'classification'),
      // ⚠️ The AI service sends NO scalar confidence — mirrored here exactly.
      result: classificationResult(fields),
    });
    expect(res.statusCode).toBe(200);

    const row = await readExecution(job.eventId, 'classification');
    expect(row, 'the execution must exist or this proves nothing').not.toBeNull();
    expect(row!.status).toBe('succeeded');

    // The MINIMUM — 0.77 — not an average, not the category confidence.
    const expected = compositeConfidence({
      category_confidence: fields.category,
      issue_type_confidence: fields.issueType,
      impact_confidence: fields.impact,
      priority_factor_confidence: fields.factor,
    });
    expect(expected).toBe(0.77);
    expect(Number(row!.confidence)).toBeCloseTo(expected, 6);
  });

  it('⚠️ the column AGREES with result.decision — one value, two places', async () => {
    const job = await makeJob();
    await claimFirst(job, 'classification');
    await postResult(job.eventId, {
      ...claim(job, 'classification'),
      result: classificationResult({ category: 0.6, issueType: 0.9, impact: 0.9, factor: 0.9 }),
    });

    const row = await readExecution(job.eventId, 'classification');
    const inResult = (row!.result as { decision?: { composite_confidence?: number } }).decision
      ?.composite_confidence;
    expect(inResult, 'the decision payload must carry it too').toBeDefined();
    expect(Number(row!.confidence)).toBeCloseTo(inResult!, 6);
  });

  it('is a plain number in [0,1] and carries no claim about correctness', async () => {
    const job = await makeJob();
    await claimFirst(job, 'classification');
    await postResult(job.eventId, {
      ...claim(job, 'classification'),
      result: classificationResult({ category: 1, issueType: 1, impact: 1, factor: 1 }),
    });
    const row = await readExecution(job.eventId, 'classification');
    const v = Number(row!.confidence);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    // 1.0 means the model said so, not that the answer is right. Nothing in
    // the row asserts otherwise — there is no accuracy or correctness field.
    expect(Object.keys(row!.result ?? {})).not.toContain('accuracy');
    expect(Object.keys(row!.result ?? {})).not.toContain('is_correct');
  });
});

describe('⚠️ features with no comparable scalar stay NULL', () => {
  it('summary records NULL rather than an invented number', async () => {
    const job = await makeJob();
    await claimFirst(job, 'summary');
    const res = await postResult(job.eventId, {
      ...claim(job, 'summary'),
      result: {
        feature: 'summary',
        status: 'succeeded',
        data: { summary: 'The customer cannot export the quarterly report and needs it today.' },
        provider: 'azure',
        model: 'azure/gpt-4.1',
        prompt_version: 'summary-v1',
        latency_ms: 800,
        fallback_used: false,
      },
    });
    expect(res.statusCode).toBe(200);

    const row = await readExecution(job.eventId, 'summary');
    expect(row!.status, 'the positive half: the summary must have succeeded').toBe('succeeded');
    expect(row!.confidence, 'summary has no scalar confidence to report').toBeNull();
  });

  it('a FAILED classification records NULL — no decision was reached', async () => {
    const job = await makeJob();
    await claimFirst(job, 'classification');
    await postResult(job.eventId, {
      ...claim(job, 'classification'),
      result: {
        feature: 'classification',
        status: 'failed',
        data: {},
        error: { kind: 'permanent', code: 'provider_content_filter', message: 'refused' },
      },
    });
    const row = await readExecution(job.eventId, 'classification');
    expect(row!.status).toBe('failed');
    expect(row!.confidence).toBeNull();
  });
});

describe('⚠️ no historical value is fabricated', () => {
  it('a rejected classification stores neither a result nor a confidence', async () => {
    const job = await makeJob();
    await claimFirst(job, 'classification');
    await postResult(job.eventId, {
      ...claim(job, 'classification'),
      result: {
        ...classificationResult({ category: 0.9, issueType: 0.9, impact: 0.9, factor: 0.9 }),
        // A category outside the product taxonomy: the validator rejects it.
        data: {
          ...classificationResult({ category: 0.9, issueType: 0.9, impact: 0.9, factor: 0.9 }).data,
          category: 'CATEGORY_THAT_DOES_NOT_EXIST',
        },
      },
    });
    const row = await readExecution(job.eventId, 'classification');
    expect(row!.status).toBe('failed');
    expect(row!.result, 'untrusted output must not be persisted').toBeNull();
    expect(row!.confidence, 'and no confidence may be invented for it').toBeNull();
  });
});

describe('G-7 — model_version', () => {
  it('records whatever version the service reported', async () => {
    const job = await makeJob();
    await claimFirst(job, 'classification');
    await postResult(job.eventId, {
      ...claim(job, 'classification'),
      result: classificationResult({ category: 0.8, issueType: 0.8, impact: 0.8, factor: 0.8 }),
    });
    const row = await readExecution(job.eventId, 'classification');
    // The Azure API version — the only version identifier the platform can
    // observe. Not the model weights version, which Azure does not expose.
    expect(row!.model_version).toBe('2024-12-01-preview');
  });
});
