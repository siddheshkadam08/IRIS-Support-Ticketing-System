import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type Tenant } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, Card, PageFooter, Spinner } from '../components/ui';
import { absTime } from '../lib/labels';
import WidgetConfig from './WidgetConfig';

/**
 * Tenant configuration — where admin@irisregtech.com works.
 *
 * Editing here changes a live integration with no redeploy on the product's
 * side. That is what makes the zero-code claim literal.
 */
export default function Tenants() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string[]>>({});
  const [created, setCreated] = useState<{ publishable_key: string; client_secret: string; webhook_secret: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['tenants'], queryFn: api.tenants });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      api.updateTenant(id, payload),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenants'] }),
    onError: (e: Error) => setErr(e.message),
  });

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.createTenant(payload),
    onSuccess: (res) => {
      setCreated(res);
      setErr(null);
      setFieldErrs({});
      setAdding(false);
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: (e: Error) => {
      // A rejected create keeps the form open with the operator's input intact
      // and the problem attached to the field that caused it — retyping six
      // fields because one prefix was taken is not an acceptable failure mode.
      setErr(e.message);
      setFieldErrs(e instanceof ApiError ? (e.fields ?? {}) : {});
    },
  });

  if (isLoading) return <Spinner />;

  return (
    <>
      {err ? <Banner kind="err">{err}</Banner> : null}

      {/* Secrets are shown exactly once, at creation. They are stored
          encrypted and never returned by any read endpoint. */}
      {created ? (
        <Banner kind="warn">
          <strong>Copy these now — they will not be shown again.</strong>
          <div className="mono" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.9 }}>
            publishable_key: {created.publishable_key}<br />
            client_secret: {created.client_secret}<br />
            webhook_secret: {created.webhook_secret}
          </div>
          <button className="btn btn-sm btn-ghost" style={{ marginTop: 10 }} onClick={() => setCreated(null)}>
            I've saved them
          </button>
        </Banner>
      ) : null}

      {can('super_admin') ? (
        <div style={{ display: 'flex', marginBottom: 14 }}>
          <div className="spacer" />
          <button className="btn" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Onboard a tenant'}
          </button>
        </div>
      ) : null}

      {adding ? (
        <Card title="Onboard a tenant" style={{ marginBottom: 14 }}>
          <NewTenantForm onSubmit={(p) => create.mutate(p)} pending={create.isPending} errors={fieldErrs} />
        </Card>
      ) : null}

      <div className="grid grid-2">
        {data?.data.map((t) => (
          <TenantCard key={t.id} tenant={t} canEdit={can('super_admin', 'product_admin')}
                      onSave={(payload) => update.mutate({ id: t.id, payload })} />
        ))}
      </div>
      <PageFooter />
    </>
  );
}

function TenantCard({
  tenant,
  canEdit,
  onSave,
}: {
  tenant: Tenant;
  canEdit: boolean;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showWidget, setShowWidget] = useState(false);
  const [mechanism, setMechanism] = useState(tenant.access_mechanism);
  const [callback, setCallback] = useState(tenant.access_callback_url ?? '');
  const [issuer, setIssuer] = useState(tenant.allowed_issuers?.join(', ') ?? '');
  const [jwksUrl, setJwksUrl] = useState(tenant.jwks_url ?? '');
  const ssoReady = Boolean(tenant.jwks_url || tenant.has_jwks_inline) &&
    (tenant.allowed_issuers?.length ?? 0) > 0;
  const colour =
    (tenant.config as { widget?: { primary_color?: string } })?.widget?.primary_color ?? '#94a3b8';

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span className="tenant-dot" style={{ background: colour, width: 12, height: 12 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 650 }}>{tenant.name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {tenant.ticket_count} tickets · {tenant.user_count} staff · prefix {tenant.ref_prefix}
          </div>
        </div>
        {canEdit ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm"
                    onClick={() => { setShowWidget((v) => !v); setEditing(false); }}>
              {showWidget ? 'Close' : 'Widget'}
            </button>
            <button className="btn btn-ghost btn-sm"
                    onClick={() => { setEditing((v) => !v); setShowWidget(false); }}>
              {editing ? 'Cancel' : 'Integration'}
            </button>
          </div>
        ) : null}
      </div>

      <dl className="kv">
        <dt>Publishable key</dt>
        <dd className="mono" style={{ fontSize: 11.5 }}>{tenant.publishable_key}</dd>
        <dt>Client id</dt>
        <dd className="mono" style={{ fontSize: 11.5 }}>{tenant.client_id}</dd>
        <dt>Access</dt>
        <dd>{tenant.access_mechanism === 'callback' ? 'Server callback' : 'Pre-authorised link'}</dd>
        <dt>Callback</dt>
        <dd className="mono truncate" style={{ fontSize: 11 }}>{tenant.access_callback_url ?? '—'}</dd>
        <dt>SSO</dt>
        <dd>
          {ssoReady ? (
            <span title={tenant.allowed_issuers.join(', ')}>
              Configured — {tenant.has_jwks_inline ? 'pinned key' : 'JWKS endpoint'}
            </span>
          ) : (
            <span style={{ color: 'var(--muted)' }}>
              Not configured — dev issuer only
            </span>
          )}
        </dd>
        <dt>Onboarded</dt>
        <dd>{absTime(tenant.created_at)}</dd>
      </dl>

      {editing ? (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <div className="field">
            <label className="label">Access mechanism</label>
            <select className="select" value={mechanism} onChange={(e) => setMechanism(e.target.value)}>
              <option value="callback">Server callback — we notify your endpoint</option>
              <option value="preauth">Pre-authorised link — you mint the capability</option>
              <option value="both">Both</option>
            </select>
            <div className="hint">
              With a pre-authorised link we never hold your signing key, so even a fully compromised
              platform cannot fabricate access into your product.
            </div>
          </div>
          <div className="field">
            <label className="label">Access callback URL</label>
            <input className="input" value={callback} placeholder="https://your-product/iris/access-callback"
                   onChange={(e) => setCallback(e.target.value)} />
          </div>
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
            <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>
              Single sign-on
            </div>
            <div className="hint" style={{ marginBottom: 12 }}>
              So a user who is already signed into the product is not asked to sign in again. The
              product mints a short-lived token for them; we verify it against the product's own
              public keys. We never hold the signing key and never store a password.
            </div>

            <div className="field">
              <label className="label">Token issuer</label>
              <input className="input mono" value={issuer} style={{ fontSize: 12 }}
                     placeholder="https://auth.rfp.example.com"
                     onChange={(e) => setIssuer(e.target.value)} />
              <div className="hint">
                The <code>iss</code> claim in the tokens the product mints — its identity provider.
                Tokens from any other issuer are rejected. Comma-separate to allow more than one.
              </div>
            </div>

            <div className="field">
              <label className="label">JWKS URL</label>
              <input className="input mono" type="url" value={jwksUrl} style={{ fontSize: 12 }}
                     placeholder="https://auth.rfp.example.com/.well-known/jwks.json"
                     onChange={(e) => setJwksUrl(e.target.value)} />
              <div className="hint">
                Where the product publishes the <em>public</em> half of its signing keys. We fetch
                it to check signatures, cache it for 5 minutes, and pick up key rotation on its own.
                Must be <code>https</code>.
              </div>
            </div>
          </div>

          <button
            className="btn"
            onClick={() => {
              onSave({
                access_mechanism: mechanism,
                access_callback_url: callback || null,
                allowed_issuers: issuer.split(',').map((s) => s.trim()).filter(Boolean),
                jwks_url: jwksUrl.trim() || null,
              });
              setEditing(false);
            }}
          >
            Save changes
          </button>
          <div className="hint" style={{ marginTop: 8 }}>
            Takes effect immediately — the integrating product does not redeploy.
          </div>
        </div>
      ) : null}

      {showWidget ? (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <WidgetConfig tenantId={tenant.id} tenantName={tenant.name} />
        </div>
      ) : null}
    </div>
  );
}

/** A field-level error from the server, rendered under the input that caused it. */
function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <div className="hint" style={{ color: 'var(--danger, #b91c1c)', fontWeight: 550 }}>
      {messages.join(' ')}
    </div>
  );
}

function NewTenantForm({
  onSubmit,
  pending,
  errors,
}: {
  onSubmit: (payload: Record<string, unknown>) => void;
  pending: boolean;
  errors: Record<string, string[]>;
}) {
  const [form, setForm] = useState({
    name: '', slug: '', ref_prefix: '', access_mechanism: 'preauth', access_callback_url: '',
  });

  // Auto-derive slug and prefix from the name so the two fields most likely to
  // be typed wrong are usually never typed at all. Both stay editable.
  const setName = (name: string) =>
    setForm((f) => ({
      ...f,
      name,
      slug: f.slug === slugify(f.name) ? slugify(name) : f.slug,
      ref_prefix: f.ref_prefix === prefixOf(f.name) ? prefixOf(name) : f.ref_prefix,
    }));

  const needsCallback = form.access_mechanism !== 'preauth';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...form, access_callback_url: form.access_callback_url.trim() || null });
      }}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 14 }}
    >
      <div className="field">
        <label className="label">Product name</label>
        <input className="input" required value={form.name} placeholder="Carbon"
               onChange={(e) => setName(e.target.value)} />
        <div className="hint">What people call it. Shown in the widget header and in every list here.</div>
        <FieldError messages={errors.name} />
      </div>

      <div className="field">
        <label className="label">Slug</label>
        <input className="input" required pattern="[a-z0-9-]+" minLength={2} maxLength={40}
               value={form.slug} placeholder="carbon"
               onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
        <div className="hint">
          The computer-friendly version of the name — lowercase letters, digits and hyphens only.
          It becomes this tenant's id (<code>prod_carbon</code>) and appears in its keys. Permanent.
        </div>
        <FieldError messages={errors.slug} />
      </div>

      <div className="field">
        <label className="label">Ticket prefix</label>
        <input className="input" required minLength={2} maxLength={8} value={form.ref_prefix}
               placeholder="CARB"
               onChange={(e) => setForm({ ...form, ref_prefix: e.target.value.toUpperCase() })} />
        <div className="hint">
          The front half of every ticket number this tenant produces: <code>CARB-1042</code>.
          Must be unique across tenants, or the same number would mean two different tickets.
        </div>
        <FieldError messages={errors.ref_prefix} />
      </div>

      <div className="field" style={{ gridColumn: '1 / -1' }}>
        <label className="label">Access mechanism</label>
        <select className="select" value={form.access_mechanism}
                onChange={(e) => setForm({ ...form, access_mechanism: e.target.value })}>
          <option value="preauth">Pre-authorised link — the product hands out its own access</option>
          <option value="callback">Server callback — we ask the product to open access</option>
          <option value="both">Both</option>
        </select>
        <div className="hint">
          How a support engineer gets <em>into the product</em> to investigate a ticket. Nobody has
          standing access; access is opened when a ticket is assigned and closed when it is resolved.
          <br />
          <strong>Pre-authorised link</strong> — the product creates a temporary, already-scoped
          link and gives it to us. We never hold a key to the product, so even a fully compromised
          platform cannot let itself in. Nothing to build on your side beyond minting the link.
          <br />
          <strong>Server callback</strong> — we call an endpoint you host and say "open read access
          to invoice 88 for this engineer for two hours", then call again to close it. Gives you a
          live record of every grant, but you must build and host that endpoint.
        </div>
      </div>

      <div className="field" style={{ gridColumn: '1 / -1' }}>
        <label className="label">
          Access callback URL {needsCallback ? '' : '(not used with pre-authorised links)'}
        </label>
        <input className="input" type="url" value={form.access_callback_url}
               required={needsCallback}
               disabled={!needsCallback}
               placeholder="https://carbon.example.com/iris/access-callback"
               onChange={(e) => setForm({ ...form, access_callback_url: e.target.value })} />
        <div className="hint">
          The address on <em>the product's</em> servers that we POST to when access should open or
          close. Must be a full URL including <code>https://</code>. Every call is signed, so the
          product can prove the request came from us. Leave blank unless you chose Server callback.
        </div>
        <FieldError messages={errors.access_callback_url} />
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create tenant'}
        </button>
        <div className="hint" style={{ marginTop: 8 }}>
          Creating a tenant issues its keys once. Everything else — branding, callback URL, access
          mechanism — is editable afterwards without the product redeploying.
        </div>
      </div>
    </form>
  );
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const prefixOf = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
