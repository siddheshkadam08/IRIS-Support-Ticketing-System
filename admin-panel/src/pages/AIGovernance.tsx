import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { GovernanceResponse } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Card, Empty, PageFooter, Spinner } from '../components/ui';

/**
 * Phase 17 — AI Governance.
 *
 * ⚠️ THE PAGE'S JOB IS TO STOP A NUMBER BEING READ AS SOMETHING IT IS NOT.
 *
 * Every figure here is an operational count over a stated population. None of
 * them says whether the AI was right, because nothing in IRIS knows that: there
 * is no labelled ground truth. A page that showed "93.6%" without saying what
 * the 93.6% is would be read as an accuracy score within a day, so the
 * population arithmetic comes FIRST, above every metric, and each panel names
 * its own denominator.
 *
 * ⚠️ PHASE 21 ADDED CORRECTIONS, AND THEY ARE STILL NOT AN ACCURACY SCORE.
 * Phase 20 gave IRIS a workflow through which an authorized human corrects a
 * classification, so corrections can now be counted — but a correction records
 * a human decision, not a verdict on the model, and the classification it
 * replaced may fall outside the window entirely. The panel therefore publishes
 * counts and one share measured against the deterministic priority engine, and
 * no share measured against the AI.
 *
 * ⚠️ THE VOCABULARY RULE. Terms that ASSERT a property the data cannot support
 * — accuracy, precision, calibrated, reliability, quality score — may not appear
 * as a heading, label, column header or KPI. They may appear inside an element
 * marked `data-governance-disclaimer`, which by construction is DENYING the
 * property. The first version of this rule was a blanket page scan, and it would
 * have failed on the very sentences that make this page honest.
 */

const DAY = 86_400_000;

const RANGES = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const;

/** Governance measures these and says so; anything else is a 400, not a zero. */
const FEATURES = [
  { value: '', label: 'All governed features' },
  { value: 'classification', label: 'Classification' },
  { value: 'summary', label: 'Summary' },
] as const;

const n = (v: number) => v.toLocaleString();
const ms = (v: number | null) => (v === null ? '—' : `${n(v)} ms`);
const orNotRecorded = (v: string | null) => (v === null || v === '' ? 'not recorded' : v);

/** Disclaimer prose. Marked so tests can tell a denial from a claim. */
function Disclaimer({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-governance-disclaimer=""
      style={{ fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.6, marginTop: 8 }}
    >
      {children}
    </div>
  );
}

/** A metric's population and sample size, shown with the metric, never apart. */
function Denominator({ population, count }: { population: string; count: number }) {
  return (
    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }} className="mono">
      {population} · n={n(count)}
    </div>
  );
}

function Figure({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub ? <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>{sub}</div> : null}
    </div>
  );
}

function Bars({ rows, max }: { rows: Array<{ key: string; n: number }>; max: number }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 60px', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 12 }}>{r.key}</div>
          <div style={{ background: 'var(--line, #e2e8f0)', height: 8, borderRadius: 4 }}>
            <div
              style={{
                width: max > 0 ? `${Math.max(2, (r.n / max) * 100)}%` : '0%',
                background: 'var(--accent, #4f46e5)',
                height: 8,
                borderRadius: 4,
              }}
            />
          </div>
          <div className="mono" style={{ fontSize: 11.5, textAlign: 'right' }}>{n(r.n)}</div>
        </div>
      ))}
    </div>
  );
}

export default function AIGovernance() {
  const { me } = useAuth();
  const [days, setDays] = useState<number>(30);
  const [feature, setFeature] = useState('');
  const [productId, setProductId] = useState('');

  const to = new Date();
  const from = new Date(to.getTime() - days * DAY);
  const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (feature) qs.set('feature', feature);
  if (productId) qs.set('product_id', productId);

  const { data, isLoading, error } = useQuery<GovernanceResponse>({
    queryKey: ['ai-governance', qs.toString()],
    queryFn: () => api.aiGovernance(qs.toString()),
  });

  if (isLoading) return <Spinner />;
  if (error || !data) {
    return <Empty title="Governance figures are unavailable">{String((error as Error)?.message ?? '')}</Empty>;
  }

  const p = data.population;
  const isSuper = me?.role === 'super_admin';

  return (
    <>
      <div className="filters">
        <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>{r.label}</option>
          ))}
        </select>
        <select className="select" value={feature} onChange={(e) => setFeature(e.target.value)}>
          {FEATURES.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">{isSuper ? 'All tenants' : 'All my tenants'}</option>
          {(me?.tenants ?? []).map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {/* ── 1. What is being measured. FIRST, deliberately. ─────────────── */}
      <Card title="What is being measured">
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <strong>{n(p.scoped)}</strong> executions in scope
          {p.excluded_from_corpus.map((x) => (
            <span key={x.reason}>
              {' → '}
              <strong>{n(x.n)}</strong> excluded (
              {x.reason === 'feature_not_governed' ? 'not a governed feature' : 'test fixtures'})
            </span>
          ))}
          {' → '}<strong>{n(p.corpus)}</strong> measurable
          {' → '}<strong>{n(p.replays)}</strong> replay{p.replays === 1 ? '' : 's'}
          {' → '}<strong>{n(p.headline)}</strong> used for every figure below
        </div>

        {!p.identity_holds ? (
          <div className="banner banner-err" style={{ marginTop: 10 }}>
            The population arithmetic does not add up. Treat every figure on this page as
            unverified and report this.
          </div>
        ) : null}

        <Disclaimer>
          These are operational counts. They do not measure whether the AI was right —
          IRIS has no ground truth to check against. No accuracy metric exists.
        </Disclaimer>

        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>
            What these figures cannot tell you ({data.caveats.length})
          </summary>
          <ul data-governance-disclaimer="" style={{ fontSize: 12, lineHeight: 1.7, marginTop: 8 }}>
            {data.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      </Card>

      {p.headline === 0 ? (
        <Empty title="No AI executions in this window">
          Nothing ran in the selected period and scope, so there are no figures to show.
        </Empty>
      ) : (
        <>
          {/* ── 2. Executions ────────────────────────────────────────────── */}
          <div className="cards" style={{ marginTop: 14 }}>
            <Figure value={n(data.executions.n)} label="Executions" sub="population: headline" />
            <Figure value={n(data.executions.succeeded)} label="Succeeded" />
            <Figure value={n(data.executions.failed)} label="Failed" />
            <Figure
              value={
                data.executions.rate_suppressed
                  ? '—'
                  : `${((data.executions.success_rate ?? 0) * 100).toFixed(1)}%`
              }
              label="Completed without error"
              sub={
                data.executions.rate_suppressed
                  ? `withheld — only ${n(data.executions.success_rate_n)} completed`
                  : `n=${n(data.executions.success_rate_n)}`
              }
            />
          </div>
          <Card style={{ marginTop: 14 }}>
            <Disclaimer>
              A succeeded execution means the pipeline finished and IRIS accepted the output.
              It does not mean the output was correct.
            </Disclaimer>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr><th>Feature</th><th>Executions</th><th>Succeeded</th><th>Failed</th><th>Running</th></tr>
                </thead>
                <tbody>
                  {data.by_feature.rows.map((f) => (
                    <tr key={f.feature}>
                      <td style={{ fontWeight: 600 }}>{f.feature}</td>
                      <td className="mono">{n(f.n)}</td>
                      <td className="mono">{n(f.succeeded)}</td>
                      <td className="mono">{n(f.failed)}</td>
                      <td className="mono">{n(f.running)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── 3. Latency — three different measurements ────────────────── */}
          <Card title="Latency — three different measurements" style={{ marginTop: 14 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Measurement</th><th>p50</th><th>p95</th><th>p99</th><th>Population</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>Provider execution</strong>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>time inside the provider call</div>
                    </td>
                    <td className="mono">{ms(data.latency.provider.p50)}</td>
                    <td className="mono">{ms(data.latency.provider.p95)}</td>
                    <td className="mono">{ms(data.latency.provider.p99)}</td>
                    <td><Denominator population={data.latency.provider.population} count={data.latency.provider.n} /></td>
                  </tr>
                  <tr>
                    <td><strong>Wall clock</strong>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>creation to completion, retries and backoff included</div>
                    </td>
                    <td className="mono">{ms(data.latency.wall_clock.p50)}</td>
                    <td className="mono">{ms(data.latency.wall_clock.p95)}</td>
                    <td className="mono">{ms(data.latency.wall_clock.p99)}</td>
                    <td><Denominator population={data.latency.wall_clock.population} count={data.latency.wall_clock.n} /></td>
                  </tr>
                  <tr>
                    <td><strong>Queue delay</strong>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>outbox event to execution start</div>
                    </td>
                    <td className="mono">{ms(data.latency.queue_delay.p50)}</td>
                    <td className="mono">{ms(data.latency.queue_delay.p95)}</td>
                    <td className="mono">{ms(data.latency.queue_delay.p99)}</td>
                    <td><Denominator population={data.latency.queue_delay.population} count={data.latency.queue_delay.n} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Disclaimer>
              These measure three different things and must not be compared or combined.
              None of them is what a person waits for — no figure here covers the browser,
              the gateway or the queue wait together.
              {data.latency.queue_delay.n < p.headline ? (
                <>
                  {' '}Queue delay covers {n(data.latency.queue_delay.n)} of {n(p.headline)} executions;
                  the rest have no matching outbox event and remain in every other figure.
                </>
              ) : null}
            </Disclaimer>
          </Card>

          {/* ── 4. Failures ──────────────────────────────────────────────── */}
          <Card title="Failures by category" style={{ marginTop: 14 }}>
            {data.failures.rows.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No failures in this window.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Category</th><th>Code</th><th>Count</th></tr>
                  </thead>
                  <tbody>
                    {data.failures.rows.map((f) => (
                      <tr key={`${f.category}-${f.error_code}`}>
                        <td style={{ fontWeight: 600 }}>{f.label}</td>
                        <td className="mono" style={{ fontSize: 11.5 }}>{orNotRecorded(f.error_code)}</td>
                        <td className="mono">{n(f.n)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Denominator population={data.failures.population} count={data.failures.n} />
            <Disclaimer>
              An unrecognised code stays visible under “Unclassified” with its raw value
              rather than being folded into a category the data does not support. The
              provider's own message is never shown here — it is stored and never exposed.
            </Disclaimer>
          </Card>

          {/* ── 5. Attempts ──────────────────────────────────────────────── */}
          <Card title="Attempts per execution" style={{ marginTop: 14 }}>
            <Bars
              rows={data.attempts.rows.map((a) => ({ key: `attempt ${a.attempt}`, n: a.n }))}
              max={Math.max(1, ...data.attempts.rows.map((a) => a.n))}
            />
            <Denominator population={data.attempts.population} count={data.attempts.n} />
            <Disclaimer>
              Attempts say how many tries an execution took. One row is kept per execution
              and updated in place, so only the terminal reason survives — why an individual
              attempt failed is not recoverable from this data.
            </Disclaimer>
          </Card>

          {/* ── 6. Confidence ────────────────────────────────────────────── */}
          <Card title="Model confidence signal" style={{ marginTop: 14 }}>
            {data.confidence.n === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                No execution in this window reported a confidence.
              </div>
            ) : (
              <Bars
                rows={data.confidence.buckets.map((b) => ({ key: b.label, n: b.n }))}
                max={Math.max(1, ...data.confidence.buckets.map((b) => b.n))}
              />
            )}
            <Denominator population={data.confidence.population} count={data.confidence.n} />
            <Disclaimer>
              Uncalibrated model signal — not a probability that the output is correct. It is
              the weakest of four numbers the model reported about itself, and nothing has
              ever checked those numbers against an outcome.
              {data.confidence.features_without_confidence.length > 0 ? (
                <> {data.confidence.features_without_confidence.join(' and ')} does not produce
                a confidence, so it is absent here rather than scoring zero.</>
              ) : null}
            </Disclaimer>
          </Card>

          {/* ── 7. Routing ───────────────────────────────────────────────── */}
          <Card title="Routing decisions — made by IRIS, not by the model" style={{ marginTop: 14 }}>
            {data.routing.rows.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No routing decisions in this window.</div>
            ) : (
              <Bars rows={data.routing.rows} max={Math.max(1, ...data.routing.rows.map((r) => r.n))} />
            )}
            <Denominator population={data.routing.population} count={data.routing.n} />
            <Disclaimer>
              IRIS decides routing from its own thresholds using the model's numbers. The
              model does not choose. Unattended auto-routing is disabled by configuration,
              so that outcome is expected to be absent or near-zero.
            </Disclaimer>
          </Card>

          {/* ── 8. Provenance ────────────────────────────────────────────── */}
          <Card title="What actually ran" style={{ marginTop: 14 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Provider</th><th>Model</th><th>Model version</th><th>Prompt version</th><th>Executions</th></tr>
                </thead>
                <tbody>
                  {data.inventory.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{orNotRecorded(r.provider)}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{orNotRecorded(r.model)}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{orNotRecorded(r.model_version)}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{orNotRecorded(r.prompt_version)}</td>
                      <td className="mono">{n(r.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Denominator population={data.inventory.population} count={data.inventory.n} />
            <Disclaimer>
              “not recorded” means the platform never captured that value for those
              executions. It is left blank rather than filled in with a version that was
              never observed.
            </Disclaimer>
          </Card>

          {/* ── 9. Copilot — separate source, separate denominator ───────── */}
          <Card title="Copilot — a separate source and denominator" style={{ marginTop: 14 }}>
            <div className="cards">
              <Figure value={n(data.copilot.invocations)} label="Draft requests" sub="from the audit trail" />
              <Figure value={ms(data.copilot.total_ms.p50)} label="End-to-end p50" sub={`n=${n(data.copilot.total_ms.n)}`} />
              <Figure value={ms(data.copilot.generation_ms.p50)} label="Generation p50" sub={`n=${n(data.copilot.generation_ms.n)}`} />
              <Figure value={ms(data.copilot.retrieval_ms.p50)} label="Retrieval p50" sub={`n=${n(data.copilot.retrieval_ms.n)}`} />
            </div>
            {data.copilot.outcomes.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <Bars rows={data.copilot.outcomes} max={Math.max(1, ...data.copilot.outcomes.map((o) => o.n))} />
              </div>
            ) : null}
            <Disclaimer>
              Copilot drafts are ephemeral by design. What an agent did with a draft — edited
              it, discarded it, sent it — is not recorded anywhere, so no figure here can
              describe it. These counts come from the audit trail and are never added to the
              execution counts above.
              {data.copilot.total_ms.n < data.copilot.invocations ? (
                <> Timings exist for {n(data.copilot.total_ms.n)} of {n(data.copilot.invocations)} invocations;
                earlier ones predate timing capture.</>
              ) : null}
            </Disclaimer>
          </Card>

          {/* ── 10. Human classification corrections — Phase 21 ──────────── */}
          <Corrections data={data} />

          {/* ── 11. Replays ──────────────────────────────────────────────── */}
          <Card title="Replays — excluded from the figures above" style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13 }}>
              <strong>{n(data.replays.n)}</strong> replayed execution{data.replays.n === 1 ? '' : 's'} in this window.
            </div>
            {data.replays.rows.length > 0 ? (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>Feature</th><th>Original error code</th><th>Count</th></tr></thead>
                  <tbody>
                    {data.replays.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.feature}</td>
                        <td className="mono" style={{ fontSize: 11.5 }}>{orNotRecorded(r.original_error_code)}</td>
                        <td className="mono">{n(r.n)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <Denominator population={data.replays.population} count={data.replays.n} />
            <Disclaimer>
              An operator re-running a failed execution creates a second execution for the
              same piece of work. Counting both would inflate the totals and make a rate
              describe re-runs rather than tickets, so replays are reported here instead.
            </Disclaimer>
          </Card>

          {/* ── 11. Fallback and by-product ──────────────────────────────── */}
          <Card title="Fallback" style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13 }}>
              <strong>{n(data.fallback.occurrences)}</strong> occurrence
              {data.fallback.occurrences === 1 ? '' : 's'}
            </div>
            <Disclaimer>
              Reported as a count, never a percentage. With numbers this small a rate would
              swing wildly on a single event and imply a precision that is not there.
            </Disclaimer>
          </Card>

          {data.by_product.rows.length > 1 || isSuper ? (
            <Card title="By tenant" style={{ marginTop: 14 }}>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Tenant</th><th>Executions</th><th>Succeeded</th><th>Failed</th></tr></thead>
                  <tbody>
                    {data.by_product.rows.map((r) => (
                      <tr key={r.product_id}>
                        <td className="mono" style={{ fontSize: 11.5 }}>{r.product_id}</td>
                        <td className="mono">{n(r.n)}</td>
                        <td className="mono">{n(r.succeeded)}</td>
                        <td className="mono">{n(r.failed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Denominator population={data.by_product.population} count={p.headline} />
            </Card>
          ) : null}
        </>
      )}

      <Card style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }} className="mono">
          {data.meta.governance_version} · window {data.window.from} → {data.window.to} ·
          generated {data.meta.generated_at} · {data.meta.query_ms} ms
        </div>
        <Disclaimer>
          Not measurable from this platform's data, and therefore absent by design:{' '}
          {data.unmeasurable.join(', ')}. Nothing on this page estimates them.
        </Disclaimer>
      </Card>

      <PageFooter />
    </>
  );
}

/**
 * Phase 21 — human classification corrections.
 *
 * ⚠️ FOUR STATES, AND THE POINT OF THE PANEL IS THAT THEY LOOK DIFFERENT.
 *
 *   not applicable  the feature filter names something other than classification
 *   none            no corrections in the window
 *   insufficient    corrections exist, too few eligible for a share
 *   sufficient      the share is shown
 *
 * The first three render NO percentage glyph at all. A greyed-out "0%" would be
 * read as a measured zero within a day, and a measured zero is precisely what
 * this panel does not have. The same reasoning is why the not-applicable state
 * withholds the counts instead of showing zeros under a Summary filter.
 *
 * ⚠️ THE COPY IS INLINE, NOT IMPORTED FROM SHARED TYPES, and that is forced
 * rather than chosen. A VALUE import from `@iris/shared/types` drags `ids.ts`
 * and `crypto.ts` — both `node:crypto` — into the browser bundle and the Vite
 * build fails outright. Every other panel on this page writes its prose inline
 * for the same reason; the canonical sentence still reaches the reader through
 * the generated caveats, which are rendered above and are built from
 * CORRECTION_DISCLAIMER on the server.
 *
 * ⚠️ NOTHING FROM THE AUDIT PAYLOAD IS RENDERED. No category or severity value,
 * no ticket id, no reviewer, no customer text — only counts and the prior
 * classification source, which is a fixed vocabulary rather than tenant data.
 */
function Corrections({ data }: { data: GovernanceResponse }) {
  const c = data.corrections;
  const title = 'Human classification corrections';

  if (!c.applies_to_filter) {
    return (
      <Card title={title} style={{ marginTop: 14 }}>
        <div style={{ fontSize: 13 }}>
          Not reported under this feature filter — corrections exist for classification only.
        </div>
        <Disclaimer>
          The counts are withheld rather than shown as zero. A zero here would read as
          &ldquo;no corrections happened&rdquo;, which is a different statement from
          &ldquo;this filter does not measure corrections&rdquo;. Choose Classification, or
          all governed features, to see them.
        </Disclaimer>
      </Card>
    );
  }

  if (c.events === 0) {
    return (
      <Card title={title} style={{ marginTop: 14 }}>
        <div style={{ fontSize: 13 }}>
          No classification corrections were recorded in this window.
        </div>
        <Denominator population={c.population} count={0} />
        <Disclaimer>
          A correction records that an authorized human changed the classification. It does
          not establish that the AI was wrong. This is a count of zero events, not a finding
          about the AI. These counts come from the audit trail and are never added to the
          execution counts above.
        </Disclaimer>
      </Card>
    );
  }

  const plural = (v: number, one: string, many: string) => (v === 1 ? one : many);

  return (
    <Card title={title} style={{ marginTop: 14 }}>
      <div className="cards">
        <Figure value={n(c.events)} label="Correction events" sub="one per human decision" />
        <Figure
          value={n(c.tickets)}
          label="Tickets corrected"
          sub={
            c.tickets_corrected_more_than_once > 0
              ? `${n(c.tickets_corrected_more_than_once)} corrected more than once`
              : 'each corrected once'
          }
        />
        <Figure value={n(c.category_changes)} label="Category changes" sub="events, not tickets" />
        <Figure value={n(c.severity_changes)} label="Severity changes" sub="events, not tickets" />
      </div>
      <Denominator population={c.population} count={c.events} />

      {/* ── Severity overrides. The one share this panel publishes. ─────── */}
      <div style={{ marginTop: 14, fontSize: 13 }}>
        <strong>{n(c.severity_overrides)}</strong>{' '}
        severity {plural(c.severity_overrides, 'override', 'overrides')} — a reviewer stored a
        severity the priority engine did not derive
        {c.sample === 'sufficient' && c.severity_override_rate !== null ? (
          <>
            {' '}
            · <strong>{(c.severity_override_rate * 100).toFixed(1)}%</strong> of{' '}
            {n(c.override_eligible)} eligible{' '}
            {plural(c.override_eligible, 'correction', 'corrections')}
          </>
        ) : null}
      </div>

      {c.sample === 'insufficient' ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
          Share withheld — only {n(c.override_eligible)} eligible{' '}
          {plural(c.override_eligible, 'correction', 'corrections')}. The count above is shown
          instead; the caveats say how many a share needs.
        </div>
      ) : null}

      {c.sample === 'none' ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
          No share can be formed — no correction in this window had a derived severity to
          override, which needs stored AI factors for the engine to run.
        </div>
      ) : null}

      <Denominator population="corrections+engine_ran" count={c.override_eligible} />

      {/* ── Prior classification source ─────────────────────────────────── */}
      {c.prior_source.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8 }}>
            Prior classification source
          </div>
          <Bars rows={c.prior_source} max={Math.max(1, ...c.prior_source.map((s) => s.n))} />
        </div>
      ) : null}

      {c.events_without_ticket > 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--danger, #b91c1c)', marginTop: 10 }}>
          {n(c.events_without_ticket)} correction{' '}
          {plural(c.events_without_ticket, 'event carries', 'events carry')} no ticket
          reference, so the ticket count is lower than the events behind it. Please report this.
        </div>
      ) : null}

      <Disclaimer>
        A correction records that an authorized human changed the classification. It does not
        establish that the AI was wrong. A reviewer may be applying product knowledge the model
        never had, or reclassifying after the customer clarified; the audit trail records the
        change, not the reason for it. These counts come from the audit trail and are never added to
        the execution counts above.
        {c.events !== c.tickets ? (
          <>
            {' '}
            {n(c.events)} corrections were made across {n(c.tickets)}{' '}
            {plural(c.tickets, 'ticket', 'tickets')}, so correction counts and ticket counts
            are not interchangeable.
          </>
        ) : null}{' '}
        A single correction can change both category and severity, so those two counts overlap.
        The severity override share compares a reviewer against the deterministic priority
        engine, never against the AI — no share of corrections against AI output is published,
        because the classification a correction replaced may fall outside this window.
      </Disclaimer>
    </Card>
  );
}
