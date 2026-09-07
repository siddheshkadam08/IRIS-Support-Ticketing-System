import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, Card, Empty, PageFooter, Pill, Spinner, TenantChip, initials } from '../components/ui';
import { ROLE_DESCRIPTION, ROLE_LABEL, relTime } from '../lib/labels';

/**
 * Team management, and where tenant scoping is actually visible: every user
 * shows the tenants they may work, and a super admin can change them.
 */
export default function Agents() {
  const { me, can, tenantName, tenantColor } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: api.users });
  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: api.tenants });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] });

  const updateScopes = useMutation({
    mutationFn: ({ id, scopes }: { id: string; scopes: string[] }) => api.updateUser(id, { scopes }),
    onSuccess: () => { setOk('Tenant access updated.'); invalidate(); },
    onError: (e: Error) => setErr(e.message),
  });

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.createUser(payload),
    onSuccess: () => { setAdding(false); setOk('User created. They must change their password on first sign-in.'); invalidate(); },
    onError: (e: Error) => setErr(e.message),
  });

  if (isLoading) return <Spinner />;

  return (
    <>
      {err ? <Banner kind="err">{err}</Banner> : null}
      {ok ? <Banner kind="ok">{ok}</Banner> : null}

      {can('super_admin', 'product_admin') ? (
        <div style={{ display: 'flex', marginBottom: 14 }}>
          <div className="spacer" />
          <button className="btn" onClick={() => { setAdding((v) => !v); setErr(null); }}>
            {adding ? 'Cancel' : 'Add user'}
          </button>
        </div>
      ) : null}

      {adding ? (
        <Card title="New user" style={{ marginBottom: 14 }}>
          <NewUserForm
            tenants={tenants?.data ?? []}
            canMakeSuper={can('super_admin')}
            onSubmit={(payload) => create.mutate(payload)}
            pending={create.isPending}
          />
        </Card>
      ) : null}

      {!data?.data.length ? (
        <Empty title="No users visible" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Role</th><th>Tenant access</th><th>Skills</th>
                <th style={{ textAlign: 'right' }}>Open</th><th>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <div className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>
                        {initials(u.display_name)}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {u.display_name}
                          {u.id === me?.id ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · you</span> : null}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td><Pill kind="role" value={u.role} /></td>
                  <td>
                    {u.role === 'super_admin' ? (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>All tenants</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                        {u.scopes.length === 0 ? (
                          <span style={{ fontSize: 12, color: 'var(--danger)' }}>No tenants — cannot sign in</span>
                        ) : (
                          u.scopes.map((s) => (
                            <TenantChip key={s} name={tenantName(s) ?? s} color={tenantColor(s)} />
                          ))
                        )}
                        {can('super_admin') ? (
                          <ScopeEditor
                            current={u.scopes}
                            tenants={tenants?.data ?? []}
                            onSave={(scopes) => updateScopes.mutate({ id: u.id, scopes })}
                          />
                        ) : null}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--muted)' }}>{u.skills.join(', ') || '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{u.open_tickets}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 12 }}>{relTime(u.last_login_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Card title="What the roles mean" style={{ marginTop: 14 }}>
        <dl className="kv" style={{ gridTemplateColumns: '132px 1fr' }}>
          {Object.entries(ROLE_LABEL).map(([role, label]) => (
            <div key={role} style={{ display: 'contents' }}>
              <dt><Pill kind="role" value={role} /></dt>
              <dd style={{ color: 'var(--ink-soft)' }}>{ROLE_DESCRIPTION[role]}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <PageFooter />
    </>
  );
}

function ScopeEditor({
  current,
  tenants,
  onSave,
}: {
  current: string[];
  tenants: Array<{ id: string; name: string }>;
  onSave: (scopes: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>(current);

  if (!open) {
    return (
      <button className="btn btn-ghost btn-sm" onClick={() => { setSel(current); setOpen(true); }}>
        Edit
      </button>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {tenants.map((t) => (
        <label key={t.id} style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={sel.includes(t.id)}
            onChange={(e) =>
              setSel((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))
            }
          />
          {t.name}
        </label>
      ))}
      <button className="btn btn-sm" onClick={() => { onSave(sel); setOpen(false); }}>Save</button>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

function NewUserForm({
  tenants,
  canMakeSuper,
  onSubmit,
  pending,
}: {
  tenants: Array<{ id: string; name: string }>;
  canMakeSuper: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [form, setForm] = useState({
    email: '', display_name: '', role: 'agent', password: '', scopes: [] as string[],
  });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 14 }}
    >
      <div className="field">
        <label className="label">Name</label>
        <input className="input" required value={form.display_name}
               onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
      </div>
      <div className="field">
        <label className="label">Email</label>
        <input className="input" type="email" required value={form.email}
               onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      <div className="field">
        <label className="label">Role</label>
        <select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="agent">Agent</option>
          <option value="manager">Manager</option>
          <option value="product_admin">Tenant Admin</option>
          {canMakeSuper ? <option value="super_admin">Super Admin</option> : null}
        </select>
        <div className="hint">{ROLE_DESCRIPTION[form.role]}</div>
      </div>
      <div className="field">
        <label className="label">Temporary password</label>
        <input className="input" type="text" required minLength={8} value={form.password}
               onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <div className="hint">They will be required to change it on first sign-in.</div>
      </div>
      <div className="field" style={{ gridColumn: '1 / -1' }}>
        <label className="label">Tenant access</label>
        {form.role === 'super_admin' ? (
          <div className="hint">A super admin has access to every tenant — no selection needed.</div>
        ) : (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {tenants.map((t) => (
              <label key={t.id} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={form.scopes.includes(t.id)}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      scopes: e.target.checked ? [...f.scopes, t.id] : f.scopes.filter((x) => x !== t.id),
                    }))
                  }
                />
                {t.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </form>
  );
}
