/**
 * Phase 12 feasibility probe — measured BEFORE building anything.
 *
 *   npx tsx scripts/rerank-probe.ts
 *
 * ⚠️ THE QUESTION THIS ANSWERS. Phase 11's whole search costs p50 488ms /
 * p95 1093ms. Phase 5 measured the same Azure deployment (gpt-4.1) generating a
 * ~40-word summary at p50 3125ms / p95 5437ms. If reranking costs that, it
 * cannot go on a synchronous widget path at all, and Phase 12 would have to be
 * an offline or opt-in capability instead.
 *
 * A reranking call is shaped very differently from a summary: the INPUT is
 * larger (10 candidates) but the OUTPUT is tiny (a list of integers), and
 * generation time is dominated by output tokens. This measures whether that
 * difference is enough, using the real deployment and a realistic payload —
 * rather than assuming either way.
 *
 * It calls Azure directly, deliberately: it is a feasibility measurement of the
 * PROVIDER, taken before the service path exists.
 */

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
) as Record<string, string | undefined>;

function need(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

const ENDPOINT = need('AZURE_OPENAI_ENDPOINT').replace(/\/$/, '');
const DEPLOYMENT = need('AZURE_OPENAI_DEPLOYMENT');
const VERSION = env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview';
const KEY = need('AZURE_OPENAI_API_KEY');

/** Ten realistic candidates, the shape Phase 11 actually produces. */
const CANDIDATES = [
  ['article', 'How to reset your password', 'If you cannot sign in, use the Forgot password link on the sign-in page. A reset email arrives within a few minutes; check your spam folder if it does not.'],
  ['article', 'Account locked after failed sign-in attempts', 'After five consecutive failed sign-in attempts the account is locked for 30 minutes. An administrator can unlock it immediately from the Users page.'],
  ['ticket', 'Password reset email never arrives', 'Customer reported that reset emails were not delivered. Resolution: the address was on the bounce suppression list; removed it and the email was delivered.'],
  ['article', 'Adding a new user to your organisation', 'Organisation administrators can invite new users from Settings, Users, Invite. The invitee receives an email with a link valid for seven days.'],
  ['article', 'Why my invoice is not showing', 'Invoices appear once the billing period closes. If an invoice is missing more than 24 hours after the period end, contact support with the billing reference.'],
  ['ticket', 'Cannot sign in to the portal', 'User could not sign in after an SSO change. Resolution: their identity provider mapping used the old email domain; updated the mapping and access was restored.'],
  ['article', 'The application is slow to load', 'Slow loading is usually a large saved filter. Clear the filter, or reduce the date range, and reload the page.'],
  ['article', 'Duplicate records after an import', 'Duplicates occur when an import file is uploaded twice. Use the Deduplicate tool from the Import history page to merge them.'],
  ['article', 'Timeouts when saving large forms', 'Forms over 500 rows may time out. Save in smaller batches, or use the bulk import instead.'],
  ['article', 'Scheduling a recurring report', 'Open the report, choose Schedule, and pick a frequency. Scheduled reports are emailed as CSV attachments.'],
] as const;

function buildPrompt(n: number) {
  const system =
    'You rank search results. You are given a user QUESTION and a numbered list of CANDIDATE documents. ' +
    'Return the candidate numbers ordered from most to least relevant to the question. ' +
    'Rank ONLY the numbers supplied. Never invent a number. Never add commentary.';
  const list = CANDIDATES.slice(0, n)
    .map(([kind, title, excerpt], i) => `[${i + 1}] (${kind}) ${title}\n${excerpt}`)
    .join('\n\n');
  const user = `QUESTION:\nI forgot my login details and cannot get in\n\nCANDIDATES:\n${list}`;
  return { system, user };
}

const SCHEMA = {
  type: 'object',
  properties: {
    ranking: { type: 'array', items: { type: 'integer' } },
  },
  required: ['ranking'],
  additionalProperties: false,
};

async function once(n: number) {
  const { system, user } = buildPrompt(n);
  const t0 = Date.now();
  const res = await fetch(
    `${ENDPOINT}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${VERSION}`,
    {
      method: 'POST',
      headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'reranking', strict: true, schema: SCHEMA },
        },
      }),
    },
  );
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, ok: false, ranking: [] as number[], tokens: 0 };
  const body = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const raw = body.choices?.[0]?.message?.content ?? '';
  if (!raw) {
    // An empty content field with a 200 is Azure refusing to generate — a
    // content filter, or a finish_reason the caller must handle. Worth
    // surfacing rather than crashing the probe.
    console.log(`      empty content, finish_reason=${JSON.stringify((body as any).choices?.[0]?.finish_reason)}`);
    return { ms, ok: false, ranking: [] as number[], tokens: 0, out: 0 };
  }
  const parsed = JSON.parse(raw) as { ranking: number[] };
  return {
    ms,
    ok: true,
    ranking: parsed.ranking,
    tokens: body.usage?.prompt_tokens ?? 0,
    out: body.usage?.completion_tokens ?? 0,
  };
}

async function main() {
  console.log('\nPhase 12 feasibility — reranking latency against the real deployment\n');
  console.log(`deployment: ${DEPLOYMENT}   api-version: ${VERSION}\n`);
  await once(10); // warm the connection

  for (const n of [5, 10, 15]) {
    const runs = [];
    for (let i = 0; i < 8; i++) runs.push(await once(n));
    const ok = runs.filter((r) => r.ok);
    const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
    const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
    console.log(
      `  n=${String(n).padStart(2)}  ok ${ok.length}/${runs.length}  ` +
        `p50 ${String(p(0.5)).padStart(5)}ms  p95 ${String(p(0.95)).padStart(5)}ms  ` +
        `max ${String(p(1)).padStart(5)}ms  in ${ok[0]?.tokens ?? 0} tok  out ${ok[0]?.out ?? 0} tok`,
    );
    if (n === 10) console.log(`        ranking returned: [${ok[0]?.ranking.join(', ')}]`);
  }
  console.log('');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
