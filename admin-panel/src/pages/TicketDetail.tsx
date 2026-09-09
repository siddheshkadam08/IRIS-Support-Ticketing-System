import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type AssigneeSuggestion,
  type CopilotDraft,
  type Delivery,
  type Grant,
  type SimilarTicket,
  type TicketDetail as TDetail,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, Card, Empty, PageFooter, Pill, Spinner, TenantChip } from '../components/ui';
import { ACTION_LABEL, absTime, relTime } from '../lib/labels';

/**
 * The highest-value screen in the portal.
 *
 * One timeline merges state transitions, comments, internal notes and — the
 * part nothing else shows — access grant/revoke events with the integrating
 * product's ACTUAL response bodies and latencies. That is what makes the
 * access cycle auditable rather than asserted.
 */
export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me, can, tenantColor } = useAuth();
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /**
   * Phase 15 — Copilot.
   *
   * `aiDraft` is the exact text Copilot last put in the box. Comparing it to
   * `reply` is how we know whether the agent has edited since, which is what
   * makes "regenerate" ask before it destroys their work.
   *
   * ⚠️ THE DRAFT LIVES ONLY HERE. Nothing is stored server-side, so there is no
   * draft to send later, from another tab, or after discarding. Discarding is
   * clearing this state. What reaches the customer is `reply` — whatever the
   * human has in the box when they press Send.
   */
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const [aiInfo, setAiInfo] = useState<CopilotDraft | null>(null);

  const { data: ticket, isLoading } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api.ticket(id!),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  });

  const { data: users } = useQuery({ queryKey: ['users'], queryFn: api.users });

  /**
   * Phase 14 — historical tickets resembling this one.
   *
   * Deliberately NOT on `refetchInterval` like the ticket itself: the history
   * does not change while someone reads it, and each call costs a real
   * embedding request. Failure is silent by design — this is a supporting
   * panel, and a support user must never be blocked from working a ticket
   * because an optional lookup could not reach the provider.
   */
  const { data: similar, isLoading: similarLoading } = useQuery({
    queryKey: ['ticket-similar', id],
    queryFn: () => api.similarTickets(id!),
    enabled: Boolean(id),
    retry: false,
    staleTime: 60_000,
  });

  /**
   * Phase 16 — Suggested Assignees.
   *
   * ⚠️ Only fetched for roles the endpoint accepts. An agent may assign only
   * themselves, and RLS hides other staff from them, so asking would produce a
   * 403 and a console error for a panel they cannot use.
   *
   * Same caching and silent-failure posture as Similar Tickets: it is a
   * supporting panel, and nobody should be blocked from working a ticket
   * because an optional lookup failed.
   */
  const canSeeSuggestions =
    me?.role === 'manager' || me?.role === 'product_admin' || me?.role === 'super_admin';

  const { data: suggested, isLoading: suggestedLoading } = useQuery({
    queryKey: ['ticket-suggested-assignees', id],
    queryFn: () => api.suggestedAssignees(id!),
    enabled: Boolean(id) && canSeeSuggestions,
    retry: false,
    staleTime: 60_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['ticket', id] });
    void qc.invalidateQueries({ queryKey: ['tickets'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const assign = useMutation({
    mutationFn: (userId: string) => api.assign(id!, userId),
    onSuccess: invalidate,
    onError: (e: Error) => setErr(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => api.setStatus(id!, status),
    onSuccess: invalidate,
    onError: (e: Error) => setErr(e.message),
  });
  /**
   * Generating a draft creates NO comment and changes nothing about the
   * ticket. It fills the reply box, and the agent takes it from there.
   */
  const copilot = useMutation({
    mutationFn: () => api.copilotDraft(id!),
    onSuccess: (res) => {
      setAiInfo(res);
      if (res.draft) {
        setReply(res.draft);
        setAiDraft(res.draft);
      } else {
        setAiDraft(null);
      }
    },
    onError: (e: Error) => setErr(e.message),
  });

  /** Has the agent changed the draft since Copilot wrote it? */
  const edited = aiDraft !== null && reply !== aiDraft;

  const runCopilot = () => {
    /**
     * ⚠️ NEVER SILENTLY DISCARD THE AGENT'S WORK. Regenerating over text they
     * have written or edited requires them to say so.
     */
    const wouldOverwrite = reply.trim().length > 0 && (aiDraft === null || edited);
    if (wouldOverwrite && !window.confirm('Replace what you have written with a new AI draft?')) {
      return;
    }
    setErr(null);
    copilot.mutate();
  };

  const discardDraft = () => {
    // Local only. There is nothing on the server to discard.
    setReply('');
    setAiDraft(null);
    setAiInfo(null);
  };

  const comment = useMutation({
    mutationFn: () => api.comment(id!, reply, internal),
    onSuccess: () => {
      setReply('');
      setInternal(false);
      setAiDraft(null);
      setAiInfo(null);
      invalidate();
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (isLoading) return <Spinner />;
  if (!ticket) return <Empty title="Ticket not found">It may belong to a tenant you cannot see.</Empty>;

  const failedRevoke = ticket.grants.find((g) => g.state === 'revoke_failed');
  const nextStatuses = allowedNext(ticket.status);

  /**
   * The AI summary, if one has been generated.
   *
   * Read defensively and shown only when it is a non-empty string: the field
   * is written by the AI pipeline and a ticket may predate the capability,
   * have a summary still in flight, or have had its summary execution fail.
   * All three are ordinary states that should render as "no summary", never as
   * a broken panel or a provider error shown to an agent.
   */
  const aiSummary: string | null = (() => {
    const raw = (ticket as { summary?: unknown } | undefined)?.summary;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
  })();

  /**
   * Composite confidence, if this ticket was classified by AI.
   *
   * Read defensively: ai_classification is jsonb written by the AI pipeline
   * and a row may predate the current shape, so anything unexpected simply
   * shows no percentage rather than breaking the page.
   */
  const aiConfidence: number | null = (() => {
    const raw = (ticket as { ai_classification?: unknown } | undefined)?.ai_classification;
    if (!raw || typeof raw !== 'object') return null;
    const decision = (raw as { decision?: unknown }).decision;
    if (!decision || typeof decision !== 'object') return null;
    const value = (decision as { composite_confidence?: unknown }).composite_confidence;
    return typeof value === 'number' && value >= 0 && value <= 1 ? value : null;
  })();

  return (
    <>
      {/* A dead-lettered revoke means access may outlive the ticket. It is a
          security incident, so it goes first and it is red. */}
      {failedRevoke ? (
        <Banner kind="err">
          <strong>Access revoke failed.</strong> The integrating product did not confirm revocation
          after all retries, so access may still be live on their side. Grant{' '}
          <span className="mono">{failedRevoke.id}</span> — {failedRevoke.last_error}
        </Banner>
      ) : null}

      {err ? <Banner kind="err">{err}</Banner> : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => nav(-1)}>← Back</button>
        <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{ticket.reference}</span>
        <Pill kind="status" value={ticket.status} />
        {ticket.severity ? <Pill kind="severity" value={ticket.severity} /> : null}
        <TenantChip name={ticket.tenant?.name ?? null} color={tenantColor(ticket.tenant?.id ?? null)} />
      </div>

      <div className="detail-grid">
        <div>
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 6 }}>
              {ticket.subject || 'Support request'}
            </div>

            {/*
              The AI summary sits ABOVE the description and is visibly labelled
              and visually distinct. Both parts matter: an agent scanning for
              the gist should hit it first, and nobody should ever be unsure
              which text the customer actually wrote. It never replaces the
              description — the customer's own words are always shown in full
              directly below.

              `undefined` (older ticket, or summary still running) renders
              nothing rather than an error: an absent enrichment is a normal
              state, not a fault.
            */}
            {aiSummary ? (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.55,
                  marginBottom: 12,
                  padding: '8px 10px',
                  borderLeft: '3px solid var(--accent, #2563EB)',
                  background: 'var(--surface-muted, rgba(37,99,235,0.05))',
                  borderRadius: 4,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    marginBottom: 3,
                  }}
                >
                  AI summary
                </div>
                {aiSummary}
              </div>
            ) : null}

            <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {ticket.description}
            </div>
          </Card>

          {/* When an agent has no grant, say why rather than showing an empty
              panel that reads like a bug. */}
          {!ticket.access.has_platform_grant ? (
            <Banner kind="warn">
              <strong>Details hidden — no active access grant.</strong> {ticket.access.reason}
              {' '}Support users hold zero standing access to ticket data; assignment grants it and
              resolving revokes it.
            </Banner>
          ) : null}

          <Card title="Activity" style={{ marginBottom: 14 }}>
            <Timeline ticket={ticket} />
          </Card>

          {ticket.access.has_platform_grant ? (
            <Card title="Reply">
              <textarea
                className="textarea"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={internal ? 'Internal note — never sent to the customer' : 'Reply to the customer…'}
              />
              {/*
                ⚠️ COPILOT FILLS THIS BOX. IT DOES NOT SEND.
                The Send button below is the same one that existed before this
                feature, and it posts whatever the agent has in the textarea —
                so the customer receives the human's text, never the model's,
                unless the human left it unchanged and chose to send it.
              */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-ghost"
                  disabled={copilot.isPending || internal}
                  onClick={runCopilot}
                  title={internal ? 'Copilot drafts customer replies, not internal notes' : undefined}
                >
                  {copilot.isPending ? 'Drafting…' : aiDraft ? 'Regenerate' : 'Draft with AI'}
                </button>
                {aiInfo ? (
                  <button className="btn btn-ghost" onClick={discardDraft} disabled={copilot.isPending}>
                    Discard draft
                  </button>
                ) : null}
              </div>

              {aiInfo ? <CopilotNote info={aiInfo} edited={edited} /> : null}

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                  Internal note
                </label>
                <div className="spacer" />
                <button
                  className="btn"
                  disabled={!reply.trim() || comment.isPending}
                  onClick={() => comment.mutate()}
                >
                  {comment.isPending ? 'Sending…' : internal ? 'Add note' : 'Send reply'}
                </button>
              </div>
              {internal ? (
                <div className="hint">
                  Internal notes are filtered out of every product-facing response at the database,
                  not just in this UI.
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div>
          <Card title="Details" style={{ marginBottom: 14 }}>
            <dl className="kv">
              <dt>Raised by</dt>
              <dd>{ticket.raised_by.name ?? ticket.raised_by.ref}</dd>
              <dt>Raised</dt>
              <dd title={absTime(ticket.raised_at)}>{relTime(ticket.raised_at)}</dd>
              <dt>Category</dt>
              <dd>
                {ticket.category ?? '—'}{' '}
                {/*
                  Where the classification came from, and how sure the model
                  was. Shown together on purpose: an agent deciding whether to
                  trust a category needs both, and "AI said reports" without a
                  confidence invites more trust than it has earned.
                */}
                {ticket.classification_source === 'ai_auto' ? (
                  <span className="tag" title="Classified by AI with high confidence">
                    AI
                  </span>
                ) : ticket.classification_source === 'ai_uncertain' ? (
                  <span className="tag" title="Classified by AI, but not confidently — please review">
                    AI · review
                  </span>
                ) : ticket.classification_source === 'product' ? (
                  <span className="tag" title="Supplied by the product, not by AI">
                    product
                  </span>
                ) : null}
                {aiConfidence !== null ? (
                  <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
                    {Math.round(aiConfidence * 100)}%
                  </span>
                ) : null}
              </dd>
              <dt>Assignee</dt>
              <dd>{ticket.assignee?.display_name ?? <span style={{ color: 'var(--muted)' }}>Unassigned</span>}</dd>
              {ticket.rating ? (<><dt>Rating</dt><dd>{'★'.repeat(ticket.rating)}</dd></>) : null}
            </dl>
          </Card>

          <Card title="Assignment" style={{ marginBottom: 14 }}>
            {can('super_admin', 'product_admin', 'manager') ? (
              <select
                className="select"
                value={ticket.assignee?.id ?? ''}
                onChange={(e) => e.target.value && assign.mutate(e.target.value)}
              >
                <option value="">Assign to…</option>
                {users?.data
                  .filter((u) => u.role !== 'super_admin')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name} ({u.open_tickets} open)
                    </option>
                  ))}
              </select>
            ) : ticket.assignee?.id === me?.id ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Assigned to you.</div>
            ) : (
              <button
                className="btn"
                style={{ width: '100%' }}
                disabled={assign.isPending}
                onClick={() => me && assign.mutate(me.id)}
              >
                {assign.isPending ? 'Assigning…' : 'Assign to me'}
              </button>
            )}
            <div className="hint">
              Assignment issues a just-in-time access grant on both layers. Resolving revokes them.
            </div>
          </Card>

          {nextStatuses.length ? (
            <Card title="Move to" style={{ marginBottom: 14 }}>
              <div className="btn-row">
                {nextStatuses.map((s) => (
                  <button
                    key={s.value}
                    className="btn btn-ghost btn-sm"
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </Card>
          ) : null}

          <Card title={`Access grants (${ticket.grants.length})`} style={{ marginBottom: 14 }}>
            {ticket.grants.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                None yet. Grants are issued on assignment.
              </div>
            ) : (
              ticket.grants.map((g) => <GrantCard key={g.id} grant={g} deliveries={ticket.deliveries} />)
            )}
          </Card>

          {canSeeSuggestions ? (
            <Card title="Suggested assignees">
              {suggestedLoading ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Looking for evidence…</div>
              ) : !suggested || suggested.suggestions.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {suggested?.caveats[0] ?? 'No staff are scoped to this product.'}
                </div>
              ) : (
                <>
                  {suggested.suggestions.map((s) => (
                    <SuggestionCard key={s.support_user_id} item={s} />
                  ))}
                  {/*
                    ⚠️ Says what the list IS and who decides. These are people
                    with relevant history, ordered by that history — not a
                    ranking of who is better at their job.
                  */}
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.4 }}>
                    Suggested assignees, with the evidence behind each. The
                    assignment decision is yours.
                    <div style={{ marginTop: 4 }}>
                      These are evidence-based suggestions, not measured agent
                      performance rankings.
                    </div>
                    {suggested.caveats.map((c) => (
                      <div key={c} style={{ marginTop: 4 }}>
                        {c}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>
          ) : null}

          <Card title="Similar tickets">
            {similarLoading ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Looking for precedents…</div>
            ) : !similar || similar.items.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                No resolved tickets to compare against yet.
              </div>
            ) : (
              <>
                {similar.items.map((t) => (
                  <SimilarCard key={t.reference} item={t} onOpen={() => nav(`/tickets?q=${t.reference}`)} />
                ))}
                {/*
                  ⚠️ Says what the list IS. These are past tickets that read
                  alike, not a recommendation — a similar ticket's fix may be
                  wrong for this one, and the reader has to decide that.
                */}
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.4 }}>
                  Past tickets that resemble this one. Similarity is a retrieval
                  score, not a verdict — check before reusing a resolution.
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
      <PageFooter />
    </>
  );
}

/**
 * What Copilot produced, and what it rested on.
 *
 * Deliberately plain and slightly discouraging: the agent is about to put this
 * in front of a customer, so the panel says where it came from, flags when it
 * cites nothing, and never implies the text is approved.
 */
function CopilotNote({ info, edited }: { info: CopilotDraft; edited: boolean }) {
  const muted = { fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 } as const;

  if (!info.draft) {
    const why =
      info.outcome === 'no_evidence'
        ? 'No related articles or past tickets were found, so there was nothing to ground a draft in.'
        : 'The draft could not be generated just now.';
    return (
      <div style={{ ...muted, marginTop: 8 }}>
        {why} Please write the reply yourself.
      </div>
    );
  }

  const cited = new Set(info.citations);
  return (
    <div style={{ ...muted, marginTop: 8 }}>
      <div style={{ marginBottom: 4 }}>
        AI draft — <strong>review and edit before sending</strong>.
        {edited ? ' You have edited it.' : ''}
      </div>
      {info.insufficient ? (
        <div style={{ marginBottom: 4 }}>
          ⚠️ This draft cites no source. Check every factual claim in it.
        </div>
      ) : null}
      {info.sources.length > 0 ? (
        <div>
          Based on:
          <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
            {info.sources.map((s) => (
              <li key={s.source_number} style={{ opacity: cited.has(s.source_number) ? 1 : 0.55 }}>
                {s.title}
                <span style={{ opacity: 0.75 }}>
                  {' '}
                  · {s.kind === 'kb_article' ? 'help article' : 'past ticket'}
                  {cited.has(s.source_number) ? ' · cited' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One suggested assignee — Phase 16.
 *
 * ⚠️ SHOWS EVIDENCE, NOT A VERDICT. There is no score, no percentage and no
 * confidence, because none exists: the ordering is three counts compared
 * lexicographically. The strongest thing this card may say is what the person
 * has previously handled.
 *
 * ⚠️ NO ASSIGN BUTTON. Clicking a suggestion must never assign anyone —
 * assignment stays the existing control above, which carries its own
 * authorization. Keeping this panel strictly read-only means a misread
 * suggestion cannot become an action.
 */
function SuggestionCard({ item }: { item: AssigneeSuggestion }) {
  // Deliberately verbal, never numeric. "strong" describes the EVIDENCE.
  const strength: Record<AssigneeSuggestion['evidence_strength'], string> = {
    strong: 'Strong evidence',
    moderate: 'Moderate evidence',
    limited: 'Limited evidence',
    none: 'No relevant historical evidence',
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--line)',
        paddingTop: 8,
        marginTop: 8,
        fontSize: 12.5,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>
          {item.rank}. {item.display_name}
        </strong>
        <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{item.role}</span>
      </div>

      <div style={{ marginTop: 2 }}>{item.summary}</div>

      <div style={{ color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
        {/*
          ⚠️ THE TWO NUMBERS MEAN DIFFERENT THINGS, and showing only the first
          overstated the second.

            evidence strength — HOW MUCH evidence there is (a count)
            best similarity   — HOW RELEVANT the closest piece of it is

          Measured: an unmatchable ticket still returns the five nearest
          historical tickets, so a candidate who handled them reads as "Strong
          evidence" at similarities of 0.19-0.21. There is deliberately no
          similarity floor (Phase 14 measured that any absolute threshold
          encodes the seed data), so the number is shown instead and the reader
          judges — the same choice the Similar Tickets panel makes.

          ⚠️ It is NOT a confidence score and must never be labelled one.
        */}
        <div>
          {strength[item.evidence_strength]}
          {item.factors.similar_tickets.best_similarity !== null ? (
            <>
              {' · '}
              <span title="How closely the nearest historical ticket resembles this one. A retrieval score, not a confidence.">
                Best similarity: {item.factors.similar_tickets.best_similarity.toFixed(2)}
              </span>
            </>
          ) : null}
        </div>
        <div>{item.factors.category_experience.label}
          {item.factors.category_experience.category
            ? ` in ${item.factors.category_experience.category}`
            : ''}
        </div>
        <div>{item.factors.active_tickets.label}</div>
      </div>

      {item.evidence.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          <span style={{ color: 'var(--muted)' }}>Evidence: </span>
          {/*
            Each reference carries its own similarity, so a row at 0.19 is
            visibly weaker than one at 0.79 without the reader opening it.
          */}
          {item.evidence.map((e, i) => (
            <span key={e.reference}>
              {i > 0 ? ', ' : ''}
              <span title={e.title}>{e.reference}</span>
              <span style={{ color: 'var(--muted)' }}> ({e.similarity.toFixed(2)})</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One historical ticket.
 *
 * Shows only what the support user needs to judge it: reference, subject,
 * status, similarity, what happened and when. No internal ids, no product or
 * tenant identifiers, no internal comments.
 */
function SimilarCard({ item, onOpen }: { item: SimilarTicket; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '8px 10px', marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{item.reference}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {Math.round(item.similarity * 100)}% match
        </span>
      </div>
      <div style={{ fontSize: 12.5, margin: '2px 0 4px' }}>{item.title}</div>
      {item.resolution ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>
          {item.resolution.length > 150 ? `${item.resolution.slice(0, 149)}…` : item.resolution}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', fontStyle: 'italic' }}>
          No public resolution recorded.
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        {item.status}
        {item.resolved_at ? ` · ${absTime(item.resolved_at)}` : ''}
      </div>
    </button>
  );
}

function GrantCard({ grant, deliveries }: { grant: Grant; deliveries: Delivery[] }) {
  const failed = grant.state.endsWith('_failed');
  const response = grant.revoke_response ?? grant.activation_response;
  const attempts = deliveries.filter((d) => d.channel === 'access_callback');

  return (
    <div className={`grant-row ${failed ? 'failed' : ''}`}>
      <div className="grant-head">
        <span className="grant-layer">
          {grant.layer === 'platform' ? 'T1 · platform' : 'T2 · product'}
        </span>
        <Pill kind="grant" value={grant.state} />
      </div>
      <div style={{ color: 'var(--muted)', marginBottom: 4 }}>
        {grant.mechanism === 'rls'
          ? 'Enforced by row-level security — no network call'
          : `Relayed via ${grant.mechanism.replace('_', ' ')}`}
      </div>
      <div style={{ fontSize: 12 }}>
        {grant.support_user_name ?? grant.support_user_id} · granted {relTime(grant.granted_at)}
        {grant.revoked_at ? ` · revoked ${relTime(grant.revoked_at)}` : ''}
      </div>
      {grant.product_grant_ref ? (
        <div style={{ fontSize: 11.5, marginTop: 4 }}>
          Product reference <span className="mono">{grant.product_grant_ref}</span>
        </div>
      ) : null}
      {grant.last_error ? (
        <div style={{ fontSize: 11.5, marginTop: 5, color: 'var(--danger)' }}>{grant.last_error}</div>
      ) : null}
      {/* The product's own words, verbatim — this is the audit evidence. */}
      {response ? <pre className="resp">{JSON.stringify(response)}</pre> : null}
      {grant.layer === 'product' && attempts.length ? (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
          {attempts.length} delivery attempt{attempts.length === 1 ? '' : 's'} ·{' '}
          last {attempts[attempts.length - 1]!.status_code ?? 'network error'} in{' '}
          {attempts[attempts.length - 1]!.latency_ms}ms
        </div>
      ) : null}
    </div>
  );
}

/** Merges comments and audit events into one chronological story. */
function Timeline({ ticket }: { ticket: TDetail }) {
  type Item = { at: string; kind: 'comment' | 'event'; node: React.ReactNode; tone?: string };
  const items: Item[] = [];

  for (const c of ticket.comments) {
    items.push({
      at: c.created_at,
      kind: 'comment',
      tone: 'comment',
      node: (
        <div className={c.is_internal ? 'note-internal' : undefined}>
          <div className="tl-head">
            <span className="tl-title">{c.author_name ?? (c.author_type === 'raiser' ? 'Customer' : 'Support')}</span>
            <span className="tl-time">{relTime(c.created_at)}</span>
          </div>
          <div className="tl-body">{c.body}</div>
        </div>
      ),
    });
  }

  for (const h of ticket.history) {
    const isAccess = h.type.startsWith('access.');
    items.push({
      at: h.at,
      kind: 'event',
      tone: h.type === 'access.revoked' ? 'access' : isAccess ? 'access' : undefined,
      node: (
        <>
          <div className="tl-head">
            <span className="tl-title">{ACTION_LABEL[h.type] ?? h.type}</span>
            <span className="tl-time" title={absTime(h.at)}>{relTime(h.at)}</span>
          </div>
          {h.after ? (
            <div className="tl-body" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {summarise(h.type, h.after)}
            </div>
          ) : null}
        </>
      ),
    });
  }

  items.sort((a, b) => a.at.localeCompare(b.at));
  if (!items.length) return <Empty title="No activity yet" />;

  return (
    <div className="timeline">
      {items.map((it, i) => (
        <div className="tl-item" key={i}>
          <div className={`tl-dot ${it.tone ?? ''}`} />
          {it.node}
        </div>
      ))}
    </div>
  );
}

function summarise(type: string, after: unknown): string {
  const a = after as Record<string, unknown>;
  if (type === 'ticket.status_changed') return `→ ${String(a.status)}`;
  if (type === 'ticket.assigned') return `→ ${String(a.assignee ?? '')}`;
  if (type === 'access.granted') {
    return `${(a.layers as string[] | undefined)?.join(' + ') ?? ''} via ${String(a.mechanism ?? '')}`;
  }
  if (type === 'access.revoked') return `${String(a.grants_revoked ?? 0)} grant(s) revoked · ${String(a.reason ?? '')}`;
  return '';
}

function allowedNext(status: string): Array<{ value: string; label: string }> {
  const map: Record<string, Array<{ value: string; label: string }>> = {
    assigned: [
      { value: 'in_progress', label: 'Start work' },
      { value: 'resolved', label: 'Resolve' },
    ],
    in_progress: [
      { value: 'waiting_on_raiser', label: 'Put on hold' },
      { value: 'resolved', label: 'Resolve' },
    ],
    waiting_on_raiser: [
      { value: 'in_progress', label: 'Resume' },
      { value: 'resolved', label: 'Resolve' },
    ],
    resolved: [
      { value: 'closed', label: 'Close' },
      { value: 'open', label: 'Reopen' },
    ],
    closed: [{ value: 'open', label: 'Reopen' }],
    open: [{ value: 'closed', label: 'Close' }],
  };
  return map[status] ?? [];
}
