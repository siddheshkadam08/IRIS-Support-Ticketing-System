import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KB_BODY_MAX,
  KB_CATEGORY_MAX,
  KB_STATUSES,
  KB_TITLE_MAX,
  allowedKbTransitions,
  canEditKbArticle,
  canPublishKb,
} from '@iris/shared/kb';
import { ApiError, api, type KbArticleAdminDTO, type KbArticleStatus } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, Card, Empty, PageFooter, Spinner, TenantChip } from '../components/ui';
import { relTime } from '../lib/labels';

/**
 * Knowledge base authoring — Phase 18.
 *
 * ⚠️ EVERY RULE THIS PAGE APPLIES COMES FROM `@iris/shared/kb`.
 *
 * Which transitions to offer, who may publish, who may edit what: all three are
 * imported, not restated. That is the whole reason the matrix is shared data.
 * A locally-written `if (role === 'manager')` here would work today and drift
 * the first time the server's rule changed, and the drift shows up as a button
 * that 403s or, worse, one that is missing for someone who is allowed.
 *
 * ⚠️ THE GATING HERE IS CONVENIENCE. THE SERVER IS THE CONTROL.
 *
 * Hiding the publish button from an agent saves them a pointless click. It is
 * not what stops an agent publishing — `assertCanTransitionKb` does that, and
 * it runs whether or not this file exists. Same contract as the AI Governance
 * nav item.
 *
 * ⚠️ WHY THE INDEX COLUMN IS NOT DECORATION.
 *
 * Publishing makes an article findable by text search instantly, because
 * `search_tsv` is a generated column. It does NOT put it in the vector index:
 * that waits for the worker's sweep, which runs every five minutes and is off
 * by default. Without this column a manager publishes, sees the article in
 * search, and reasonably concludes the AI can use it — while one of the three
 * retrieval strategies has never seen it. The column is the only place that
 * gap is visible.
 */

const STATUS_LABEL: Record<KbArticleStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
};

/** What each transition is called when it is the ACTION rather than the state. */
const TRANSITION_LABEL: Record<KbArticleStatus, string> = {
  published: 'Publish',
  draft: 'Unpublish',
  archived: 'Archive',
};

/** From archived, moving to draft is a restore rather than an unpublish. */
function transitionLabel(from: KbArticleStatus, to: KbArticleStatus): string {
  if (from === 'archived' && to === 'draft') return 'Restore to draft';
  return TRANSITION_LABEL[to];
}

const INDEX_LABEL: Record<string, { text: string; tone: string; hint: string }> = {
  indexed: {
    text: 'Indexed',
    tone: '#15803d',
    hint: 'Embedded and reachable by all three retrieval strategies, including AI answers.',
  },
  pending: {
    text: 'Pending',
    tone: '#b45309',
    hint:
      'Live in text search now. Not yet embedded, so vector search and AI answers cannot reach it ' +
      'until the next embedding sweep runs.',
  },
  failed: {
    text: 'Failed',
    tone: '#b91c1c',
    hint:
      'Embedding failed permanently for this exact text and will not be retried until the text changes. ' +
      'Text search still works.',
  },
};

export default function KnowledgeBase() {
  const { me, tenantColor } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const qs = params.toString();
  const { data, isLoading } = useQuery({
    queryKey: ['kb', qs],
    queryFn: () => api.kbArticles(qs ? `${qs}&limit=25` : 'limit=25'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['kb'] });
    void qc.invalidateQueries({ queryKey: ['kb-article'] });
  };

  const transition = useMutation({
    mutationFn: ({ id, status }: { id: string; status: KbArticleStatus }) => api.kbSetStatus(id, status),
    onSuccess: () => {
      setErr(null);
      refresh();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // A filter change invalidates the current page: staying on offset 60 after
    // narrowing to one status shows an empty list that looks like no results.
    next.delete('offset');
    setParams(next);
  };

  const offset = Number(params.get('offset') ?? 0);
  const page = (delta: number) => {
    const next = new URLSearchParams(params);
    const target = Math.max(0, offset + delta);
    if (target === 0) next.delete('offset');
    else next.set('offset', String(target));
    setParams(next);
  };

  const tenants = me?.tenants ?? [];

  return (
    <>
      {err ? <Banner kind="err">{err}</Banner> : null}

      <div className="filters">
        <select className="select" value={params.get('product_id') ?? ''} onChange={(e) => set('product_id', e.target.value)}>
          <option value="">All my tenants</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <select className="select" value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          {KB_STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <input
          className="input"
          placeholder="Search titles and body…"
          defaultValue={params.get('q') ?? ''}
          onBlur={(e) => set('q', e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') set('q', (e.target as HTMLInputElement).value.trim());
          }}
        />
        {qs ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams())}>
            Clear
          </button>
        ) : null}
        <div className="spacer" />
        <button
          className="btn"
          onClick={() => {
            setCreating((v) => !v);
            setEditing(null);
          }}
        >
          {creating ? 'Cancel' : 'New article'}
        </button>
      </div>

      {creating ? (
        <Card title="New article" style={{ marginBottom: 14 }}>
          {/* Every staff role may author. The gate is on publication, and the
              form says so rather than leaving an agent to discover it later. */}
          <Banner kind="info">
            New articles are saved as drafts. A draft is invisible to customers and to AI answers
            until {canPublishKb(me?.role ?? '') ? 'you publish it' : 'a manager publishes it'}.
          </Banner>
          <ArticleForm
            tenants={tenants}
            defaultProductId={params.get('product_id') ?? tenants[0]?.id ?? ''}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              refresh();
            }}
            onError={setErr}
          />
        </Card>
      ) : null}

      {editing ? (
        <ArticleEditor
          id={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
          onError={setErr}
        />
      ) : null}

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <Empty title="No articles match">
          {qs ? 'Try clearing the filters.' : 'Create the first article for this tenant.'}
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Tenant</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>AI index</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ padding: 0, textAlign: 'left', fontWeight: 600 }}
                        onClick={() => {
                          setEditing(a.id);
                          setCreating(false);
                        }}
                      >
                        {a.title}
                      </button>
                    </td>
                    <td>
                      <TenantChip
                        name={tenants.find((t) => t.id === a.product_id)?.name ?? a.product_id}
                        color={tenantColor?.(a.product_id)}
                      />
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{a.category ?? '—'}</td>
                    <td>
                      <span className={`pill pill-${a.status === 'published' ? 'resolved' : a.status === 'archived' ? 'closed' : 'open'}`}>
                        {STATUS_LABEL[a.status]}
                      </span>
                    </td>
                    <td><IndexBadge article={a} /></td>
                    <td style={{ color: 'var(--muted)' }}>{relTime(a.updated_at)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <TransitionButtons
                        article={a}
                        role={me?.role ?? ''}
                        pending={transition.isPending}
                        onGo={(status) => transition.mutate({ id: a.id, status })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {offset + 1}–{offset + data.data.length} of {data.total}
            </span>
            <div className="spacer" />
            <button className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => page(-25)}>
              Previous
            </button>
            <button className="btn btn-ghost btn-sm" disabled={!data.has_more} onClick={() => page(25)}>
              Next
            </button>
          </div>
        </>
      )}

      <PageFooter />
    </>
  );
}

/**
 * The controls offered are exactly `allowedKbTransitions`, filtered by whether
 * this role may transition at all.
 *
 * ⚠️ NOTHING HERE LISTS THE TRANSITIONS ITSELF. That is why an archived article
 * shows "Restore to draft" and no publish button: the matrix says archived
 * reaches only draft, and this renders whatever it is given.
 */
function TransitionButtons({
  article,
  role,
  pending,
  onGo,
}: {
  article: KbArticleAdminDTO;
  role: string;
  pending: boolean;
  onGo: (status: KbArticleStatus) => void;
}) {
  if (!canPublishKb(role)) {
    return <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Manager approval</span>;
  }
  return (
    <span className="btn-row">
      {allowedKbTransitions(article.status).map((to) => (
        <button
          key={to}
          className={`btn btn-sm ${to === 'archived' ? 'btn-ghost' : ''}`}
          disabled={pending}
          onClick={() => onGo(to)}
        >
          {transitionLabel(article.status, to)}
        </button>
      ))}
    </span>
  );
}

/**
 * ⚠️ A DASH IS A REAL ANSWER HERE, not missing data.
 *
 * A draft or an archived article is not in the corpus at all, so it has no
 * index state — showing "Pending" would promise something that will never
 * happen while it is in that state.
 */
function IndexBadge({ article }: { article: KbArticleAdminDTO }) {
  if (article.index_state === null) {
    return (
      <span style={{ color: 'var(--muted)' }} title="Not in the AI corpus: only published articles are.">
        —
      </span>
    );
  }
  const meta = INDEX_LABEL[article.index_state]!;
  return (
    <span style={{ color: meta.tone, fontWeight: 600, fontSize: 12 }} title={meta.hint}>
      {meta.text}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────

function ArticleEditor({
  id,
  onClose,
  onSaved,
  onError,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { me } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['kb-article', id], queryFn: () => api.kbArticle(id) });

  if (isLoading || !data) return <Card title="Article"><Spinner /></Card>;

  const editable = canEditKbArticle(me?.role ?? '', data.status);

  return (
    <Card title={data.title} style={{ marginBottom: 14 }}>
      {!editable ? (
        <Banner kind="info">
          {data.status === 'archived'
            ? 'An archived article cannot be edited. Restore it to draft first, so its text is reviewed before it returns to the knowledge base and to AI answers.'
            : 'Editing a published article requires a manager, product admin or super admin.'}
        </Banner>
      ) : null}

      {data.index_state === 'failed' && data.embedding_error ? (
        <Banner kind="warn">
          Embedding failed for this text ({data.embedding_error}). Text search still finds this
          article; AI answers cannot cite it. Editing the text queues it for another attempt.
        </Banner>
      ) : null}

      <ArticleForm
        article={data}
        readOnly={!editable}
        onCancel={onClose}
        onSaved={() => {
          onSaved();
          onClose();
        }}
        onError={onError}
      />
    </Card>
  );
}

/**
 * One form for create and edit.
 *
 * ⚠️ IT SHOWS EXACTLY THE THREE FIELDS THE SERVER ACCEPTS: title, body,
 * category. There is no status control and no visibility toggle, because
 * `PATCH /admin/api/kb/articles/:id` rejects both — `status` because the
 * lifecycle has its own endpoint with its own role check, and `is_public`
 * because it is not writable at the database at all. A field the server refuses
 * is worse than a missing one: it looks like it saved.
 */
function ArticleForm({
  article,
  tenants,
  defaultProductId,
  readOnly,
  onCancel,
  onSaved,
  onError,
}: {
  article?: KbArticleAdminDTO;
  tenants?: Array<{ id: string; name: string }>;
  defaultProductId?: string;
  readOnly?: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [productId, setProductId] = useState(defaultProductId ?? '');
  const [title, setTitle] = useState(article?.title ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [category, setCategory] = useState(article?.category ?? '');
  const [fieldErrs, setFieldErrs] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: () =>
      article
        ? api.kbUpdate(article.id, { title, body, category: category.trim() || null })
        : api.kbCreate({ product_id: productId, title, body, category: category.trim() || null }),
    onSuccess: () => {
      setFieldErrs({});
      onSaved();
    },
    onError: (e: Error) => {
      // Keep the operator's text on screen. Retyping an article because a title
      // was two characters too long is not an acceptable failure mode.
      onError(e.message);
      setFieldErrs(e instanceof ApiError ? (e.fields ?? {}) : {});
    },
  });

  const complete = title.trim().length > 0 && body.trim().length > 0 && (article || productId);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {!article && tenants ? (
        <div className="field">
          <label className="label">Tenant</label>
          <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="field">
        <label className="label">Title</label>
        <input
          className="input"
          value={title}
          maxLength={KB_TITLE_MAX}
          disabled={readOnly}
          onChange={(e) => setTitle(e.target.value)}
        />
        {fieldErrs.title ? <div className="hint" style={{ color: '#b91c1c' }}>{fieldErrs.title[0]}</div> : null}
      </div>

      <div className="field">
        <label className="label">Category</label>
        <input
          className="input"
          value={category}
          maxLength={KB_CATEGORY_MAX}
          disabled={readOnly}
          placeholder="Optional, e.g. reports"
          onChange={(e) => setCategory(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="label">Body</label>
        <textarea
          className="input"
          rows={14}
          value={body}
          maxLength={KB_BODY_MAX}
          disabled={readOnly}
          onChange={(e) => setBody(e.target.value)}
          style={{ fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical' }}
        />
        <div className="hint">
          {body.length.toLocaleString()} / {KB_BODY_MAX.toLocaleString()} characters. This text is what
          AI answers quote, so write it as the answer you would want a customer to read.
        </div>
      </div>

      <div className="btn-row">
        <button className="btn" disabled={readOnly || !complete || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : article ? 'Save changes' : 'Create draft'}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
