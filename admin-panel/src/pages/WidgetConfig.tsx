import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CAPABILITY_LABELS,
  WIDGET_CAPABILITIES,
  slugifyCategory,
  type WidgetCapability,
  type WidgetSettings,
} from '@iris/shared/widget-config';
import { ApiError, api } from '../api/client';
import { Banner, Card, Spinner } from '../components/ui';

/**
 * Everything a product's widget shows, editable without the product deploying.
 *
 * This is the screen that makes the zero-code claim literal rather than
 * aspirational: the widget bundle is identical for every tenant, so if it
 * cannot be configured here it cannot be configured at all.
 */
export default function WidgetConfig({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<WidgetSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['widget-config', tenantId],
    queryFn: () => api.widgetConfig(tenantId),
  });

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const save = useMutation({
    mutationFn: (payload: WidgetSettings) => api.saveWidgetConfig(tenantId, payload),
    onSuccess: (res) => {
      setDraft(res);
      setErr(null);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      setTimeout(() => setSaved(false), 4000);
    },
    onError: (e: Error) => {
      setSaved(false);
      const fields = e instanceof ApiError ? e.fields : undefined;
      setErr(
        fields
          ? Object.entries(fields).map(([k, v]) => `${k}: ${v.join(' ')}`).join(' · ')
          : e.message,
      );
    },
  });

  if (isLoading || !draft) return <Spinner />;

  const set = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  const toggleCapability = (cap: WidgetCapability) =>
    set(
      'capabilities',
      draft.capabilities.includes(cap)
        ? draft.capabilities.filter((c) => c !== cap)
        : [...draft.capabilities, cap],
    );

  return (
    <>
      {err ? <Banner kind="err">{err}</Banner> : null}
      {saved ? (
        <Banner kind="ok">
          Saved. Every gateway dropped its cached copy immediately — users see this on their next
          page load, with no redeploy on {tenantName}'s side.
        </Banner>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div>
          <Card title="Branding" style={{ marginBottom: 14 }}>
            <div className="field">
              <label className="label">Header title</label>
              <input className="input" maxLength={60} value={draft.branding.title}
                     onChange={(e) => set('branding', { ...draft.branding, title: e.target.value })} />
              <div className="hint">
                Shown at the top of the widget. This is the "AI Support" text — set it to something
                like "{tenantName} Support".
              </div>
            </div>
            <div className="field">
              <label className="label">Subtitle</label>
              <input className="input" maxLength={120} value={draft.branding.subtitle}
                     onChange={(e) => set('branding', { ...draft.branding, subtitle: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">Greeting</label>
              <input className="input" maxLength={160} value={draft.branding.greeting}
                     onChange={(e) => set('branding', { ...draft.branding, greeting: e.target.value })} />
              <div className="hint">
                Appears under "Hi &lt;first name&gt;!". The name comes from the SSO token — without
                one the widget can only say "Hi there!".
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ColorField label="Primary colour" value={draft.branding.primary_color}
                          onChange={(v) => set('branding', { ...draft.branding, primary_color: v })} />
              <ColorField label="Accent colour" value={draft.branding.accent_color}
                          onChange={(v) => set('branding', { ...draft.branding, accent_color: v })} />
            </div>
            <div className="field">
              <label className="label">Logo text (optional)</label>
              <input className="input" maxLength={24} value={draft.branding.logo_text ?? ''}
                     onChange={(e) => set('branding', { ...draft.branding, logo_text: e.target.value || null })} />
            </div>
          </Card>

          <Card title="Tiles" style={{ marginBottom: 14 }}>
            <div className="hint" style={{ marginBottom: 10 }}>
              Which of the eight capabilities appear on the widget's home screen.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {WIDGET_CAPABILITIES.map((cap) => (
                <label key={cap} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={draft.capabilities.includes(cap)}
                         onChange={() => toggleCapability(cap)} />
                  {CAPABILITY_LABELS[cap]}
                </label>
              ))}
            </div>
            {draft.capabilities.length === 0 ? (
              <div className="hint" style={{ color: 'var(--danger, #b91c1c)', marginTop: 8 }}>
                With no tiles enabled the widget opens to an empty panel.
              </div>
            ) : null}
          </Card>
        </div>

        <div>
          <Card title="Ticket categories" style={{ marginBottom: 14 }}>
            <div className="hint" style={{ marginBottom: 10 }}>
              The options in the widget's Create a Ticket form. The value is stored on the ticket and
              used in filters and exports, so it is fixed once tickets exist — change a label freely,
              change a value carefully.
            </div>
            <CategoryEditor value={draft.categories} onChange={(v) => set('categories', v)} />
          </Card>

          <Card title="Suggested questions" style={{ marginBottom: 14 }}>
            <div className="hint" style={{ marginBottom: 10 }}>
              The prompts offered under "Try asking something like:". Up to six.
            </div>
            <ListEditor value={draft.suggestions} max={6} placeholder="How do I reset my password?"
                        onChange={(v) => set('suggestions', v)} />
          </Card>

          <Card title="Behaviour" style={{ marginBottom: 14 }}>
            <Toggle label="Knowledge base" checked={draft.knowledge_base_enabled}
                    hint="Lets the widget search and show articles."
                    onChange={(v) => set('knowledge_base_enabled', v)} />
            <Toggle label="Answer before filing" checked={draft.deflection_enabled}
                    hint="Answers from the knowledge base first, so a user who is helped never files a ticket. Never closes an existing one."
                    onChange={(v) => set('deflection_enabled', v)} />
            <Toggle label="Allow anonymous users" checked={draft.allow_anonymous}
                    hint="Permits use without an SSO token. Those tickets carry no verified identity, so leave this off if the product signs users in."
                    onChange={(v) => set('allow_anonymous', v)} />

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 8 }}>Form fields</div>
              {(['subject', 'category', 'severity', 'attachments'] as const).map((f) => (
                <Toggle key={f} label={f === 'severity' ? 'Priority' : f[0]!.toUpperCase() + f.slice(1)}
                        checked={draft.fields[f]}
                        onChange={(v) => set('fields', { ...draft.fields, [f]: v })} />
              ))}
            </div>
          </Card>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? 'Saving…' : 'Save widget configuration'}
        </button>
        <button className="btn btn-ghost" disabled={save.isPending}
                onClick={() => { if (data) setDraft(data); setErr(null); }}>
          Discard changes
        </button>
      </div>
    </>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
               style={{ width: 38, height: 32, padding: 2, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
        <input className="input mono" style={{ fontSize: 12 }} value={value}
               onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

function Toggle({ label, checked, hint, onChange }: {
  label: string; checked: boolean; hint?: string; onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {hint ? <div className="hint" style={{ marginLeft: 24 }}>{hint}</div> : null}
    </div>
  );
}

function ListEditor({ value, max, placeholder, onChange }: {
  value: string[]; max: number; placeholder: string; onChange: (v: string[]) => void;
}) {
  return (
    <>
      {value.map((item, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" value={item} placeholder={placeholder}
                 onChange={(e) => onChange(value.map((v, j) => (j === i ? e.target.value : v)))} />
          <button className="btn btn-ghost btn-sm" title="Remove"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {value.length < max ? (
        <button className="btn btn-ghost btn-sm" onClick={() => onChange([...value, ''])}>
          Add
        </button>
      ) : null}
    </>
  );
}

function CategoryEditor({ value, onChange }: {
  value: Array<{ value: string; label: string }>;
  onChange: (v: Array<{ value: string; label: string }>) => void;
}) {
  return (
    <>
      {value.map((cat, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 8 }}>
          <input className="input" placeholder="Login / Access" value={cat.label}
                 onChange={(e) => {
                   const label = e.target.value;
                   // Keep the value in step with the label only while it still
                   // looks auto-derived; once an operator edits it by hand, or a
                   // ticket has used it, it must stop moving underneath them.
                   const autoTracked = cat.value === slugifyCategory(cat.label) || !cat.value;
                   onChange(value.map((c, j) =>
                     j === i ? { label, value: autoTracked ? slugifyCategory(label) : c.value } : c));
                 }} />
          <input className="input mono" style={{ fontSize: 12 }} placeholder="login_access" value={cat.value}
                 onChange={(e) => onChange(value.map((c, j) =>
                   j === i ? { ...c, value: e.target.value.toLowerCase() } : c))} />
          <button className="btn btn-ghost btn-sm" title="Remove"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {value.length < 30 ? (
        <button className="btn btn-ghost btn-sm" onClick={() => onChange([...value, { label: '', value: '' }])}>
          Add a category
        </button>
      ) : null}
    </>
  );
}
