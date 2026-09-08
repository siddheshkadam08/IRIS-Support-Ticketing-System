import './styles.css';
import { ApiError, api, configure, hasIdentity, setIdentityToken, type WidgetConfig } from './api';
import * as I from './icons';
import type { AskAnswer, ChatTurn, KbArticle, Ticket, View } from './types';

const NS = 'iris-support';
const DRAFT_KEY = `${NS}-draft`;

// ── the eight tiles, in the order shown in the mockup ──────────────────
const TILES = [
  { id: 'ask', label: 'Ask a Question', sub: 'Get instant answers', icon: I.askIcon },
  { id: 'create_ticket', label: 'Create a Ticket', sub: 'Report an issue', icon: I.ticketIcon },
  { id: 'search_docs', label: 'Search Docs', sub: 'Find help articles', icon: I.searchIcon },
  { id: 'my_tickets', label: 'My Tickets', sub: 'Track your tickets', icon: I.myTicketsIcon },
  { id: 'upload_screenshot', label: 'Upload Screenshot', sub: 'Get AI help', icon: I.uploadIcon },
  { id: 'live_chat', label: 'Live Chat', sub: 'Talk to an agent', icon: I.chatIcon },
  { id: 'ai_suggestions', label: 'AI Suggestions', sub: 'Smart recommendations', icon: I.sparkleIcon },
  { id: 'announcements', label: 'Announcements', sub: 'Latest updates', icon: I.megaphoneIcon },
] as const;

interface State {
  view: View;
  config: WidgetConfig | null;
  loading: boolean;
  error: string | null;
  chat: ChatTurn[];
  conversationId: string | null;
  asking: boolean;
  tickets: Ticket[];
  ticket: Ticket | null;
  docs: KbArticle[];
  docsQuery: string;
  article: KbArticle | null;
  announcements: Array<{ id: string; title: string; body: string; kind: string; published_at: string }>;
  createdRef: string | null;
  createdId: string | null;
  pendingAttachments: Array<{ id: string; filename: string }>;
  fromLiveChat: boolean;
  submitting: boolean;
  banner: { kind: 'ok' | 'err' | 'info'; text: string } | null;
}

const state: State = {
  view: 'home',
  config: null,
  loading: true,
  error: null,
  chat: [],
  conversationId: null,
  asking: false,
  tickets: [],
  ticket: null,
  docs: [],
  docsQuery: '',
  article: null,
  announcements: [],
  createdRef: null,
  createdId: null,
  pendingAttachments: [],
  fromLiveChat: false,
  submitting: false,
  banner: null,
};

const root = document.getElementById('root')!;
const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const params = new URLSearchParams(location.search);
const publishableKey = params.get('key') ?? '';
configure(location.origin, publishableKey);

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  assigned: 'Open',
  in_progress: 'In Progress',
  waiting_on_raiser: 'On Hold', // HLD §10.1 — display mapping only
  resolved: 'Resolved',
  closed: 'Closed',
};

// ─────────────────────────────────────────────────────────────────────────
// Chrome
// ─────────────────────────────────────────────────────────────────────────
function header(): string {
  const c = state.config;
  const showBack = state.view !== 'home';
  const title = showBack ? backTitle() : (c?.branding.title ?? 'AI Support');
  const sub = showBack ? '' : (c?.branding.subtitle ?? 'Your smart support assistant');

  return `
    <div class="hdr">
      ${
        showBack
          ? `<button class="hdr-btn" data-act="back" aria-label="Back">${I.backIcon()}</button>`
          : `<div class="hdr-avatar">${I.robot(23)}</div>`
      }
      <div class="hdr-text">
        <div class="hdr-title">${esc(title)}</div>
        ${sub ? `<div class="hdr-sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="hdr-actions">
        <button class="hdr-btn" data-act="restart" aria-label="Start over">${I.refreshIcon()}</button>
        <button class="hdr-btn" data-act="close" aria-label="Minimise">${I.minimiseIcon()}</button>
        <button class="hdr-btn" data-act="close" aria-label="Close">${I.closeIcon()}</button>
      </div>
    </div>`;
}

function backTitle(): string {
  switch (state.view) {
    case 'ask': return 'Ask a Question';
    case 'create': return 'Create a Ticket';
    case 'created': return 'Ticket Created';
    case 'tickets': return 'My Tickets';
    case 'ticket': return state.ticket?.reference ?? 'Ticket';
    case 'docs': return 'Search Docs';
    case 'article': return state.article?.title ?? 'Article';
    case 'announcements': return 'Announcements';
    default: return 'Support';
  }
}

/** Footer — disclaimer plus the brand line, on every single view. */
function footer(): string {
  const c = state.config;
  return `
    <div class="foot">
      ${state.view === 'home' || state.view === 'ask'
        ? `<div class="foot-disclaimer">${esc(c?.disclaimer ?? 'AI can make mistakes. Please verify important information.')}</div>`
        : ''}
      <div class="foot-brand">${esc(c?.footer ?? 'Powered by Elevate - X.')}</div>
    </div>`;
}

function banner(): string {
  if (!state.banner) return '';
  const cls = state.banner.kind === 'err' ? 'banner-err' : state.banner.kind === 'ok' ? 'banner-ok' : 'banner-info';
  return `<div class="banner ${cls}">${esc(state.banner.text)}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Views
// ─────────────────────────────────────────────────────────────────────────
function homeView(): string {
  const c = state.config!;
  const name = c.identity.name?.split(' ')[0] ?? null;
  const enabled = new Set(c.capabilities);

  const tiles = TILES.filter((t) => enabled.has(t.id))
    .map(
      (t) => `
      <button class="tile" data-tile="${t.id}">
        <span class="tile-ico">${t.icon(23)}</span>
        <span class="tile-label">${t.label}</span>
        <span class="tile-sub">${t.sub}</span>
      </button>`,
    )
    .join('');

  const chips = (c.suggestions ?? [])
    .map(
      (q) => `
      <button class="chip" data-suggest="${esc(q)}">
        <span class="chip-ico">${I.sendIcon(15)}</span>
        <span>${esc(q)}</span>
      </button>`,
    )
    .join('');

  return `
    <div class="body">
      ${banner()}
      <div class="greet">👋 Hi ${esc(name ?? 'there')}!</div>
      <div class="greet-sub">${esc(c.branding.greeting)}</div>
      <div class="tiles">${tiles}</div>
      ${chips ? `<div class="sect-label">Try asking something like:</div><div class="chips">${chips}</div>` : ''}
    </div>
    ${composer('Type your question...')}`;
}

function composer(placeholder: string): string {
  return `
    <div class="composer">
      <form class="composer-box" data-form="ask">
        <input class="composer-input" name="q" autocomplete="off"
               placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" />
        <button class="send-btn" type="submit" aria-label="Send">${I.sendIcon()}</button>
      </form>
    </div>`;
}

function answerCard(a: AskAnswer, cited = false): string {
  const kind = a.type === 'kb_article' ? 'Help article' : 'Previously resolved';
  const attr = a.type === 'kb_article' ? `data-article="${esc(a.id)}"` : `data-answer-ticket="1"`;
  // A cited source is marked so the reader can see which cards the answer
  // actually rests on. Title and type only — no ids, no scores, no internals.
  const mark = cited ? '<span class="answer-cited">Cited</span>' : '';
  return `
    <button class="answer-card${cited ? ' is-cited' : ''}" ${attr}>
      <div class="answer-title">${esc(a.title)}</div>
      <div class="answer-excerpt">${esc(a.excerpt)}</div>
      <div class="answer-meta">${kind}${mark}</div>
    </button>`;
}

function askView(): string {
  const turns = state.chat
    .map((t) => {
      if (t.role === 'user') {
        return `<div class="msg msg-user">
                  <div class="msg-avatar">${I.robot(15, 'currentColor')}</div>
                  <div class="bubble">${esc(t.text)}</div>
                </div>`;
      }
      const cards = (t.answers ?? [])
        .map((a, i) => answerCard(a, t.cited?.includes(i + 1) ?? false))
        .join('');
      /**
       * An AI-written answer is LABELLED as one. The sources are listed
       * underneath either way, so a reader can check any claim against them —
       * which is the whole point of grounding.
       */
      const groundedNote = t.grounded
        ? '<div class="answer-meta" style="margin:6px 0 2px">AI answer, based on the sources below</div>'
        : '';
      const escalate = t.escalate
        ? `<div class="escalate">
             <div class="escalate-text">Not what you were looking for? Create a ticket and a support engineer will pick it up.</div>
             <button class="btn" data-act="escalate">Create a ticket</button>
           </div>`
        : '';
      return `<div class="msg">
                <div class="msg-avatar">${I.robot(15, 'currentColor')}</div>
                <div style="flex:1;min-width:0">
                  <div class="bubble">${esc(t.text)}</div>
                  ${groundedNote}${cards}${escalate}
                </div>
              </div>`;
    })
    .join('');

  return `
    <div class="body" id="chat-scroll">
      ${banner()}
      ${turns}
      ${state.asking ? `<div class="spinner" style="margin:14px auto"></div>` : ''}
    </div>
    ${composer('Type your question...')}`;
}

function createView(): string {
  const c = state.config!;
  const draft = loadDraft();
  const cats = c.categories
    .map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`)
    .join('');
  const sevs = c.severities
    .map(
      (x) =>
        `<option value="${esc(x.value)}" ${x.value === c.default_severity ? 'selected' : ''}>${esc(x.label)}</option>`,
    )
    .join('');

  const files = state.pendingAttachments
    .map(
      (f) => `<div class="file-row">${I.paperclipIcon()}
                <span class="file-name">${esc(f.filename)}</span>
                <button type="button" class="file-remove" data-remove-file="${esc(f.id)}" aria-label="Remove">${I.closeIcon(13)}</button>
              </div>`,
    )
    .join('');

  return `
    <div class="body">
      ${banner()}
      ${state.fromLiveChat
        ? `<div class="banner banner-info">Live chat isn't available yet — tell us what's happening and an agent will pick this up. You'll get an email and can track it under My Tickets.</div>`
        : ''}
      <form data-form="create">
        ${c.fields.subject
          ? `<div class="field"><label class="label" for="f-subject">Subject</label>
               <input class="input" id="f-subject" name="subject" maxlength="200"
                      placeholder="Short summary" value="${esc(draft.subject ?? '')}" /></div>`
          : ''}
        <div class="field">
          <label class="label" for="f-desc">What's happening?</label>
          <textarea class="textarea" id="f-desc" name="description" required maxlength="20000"
                    placeholder="Describe the issue. What did you expect, and what happened instead?">${esc(draft.description ?? '')}</textarea>
          <div class="hint">Including the time it happened and a screenshot helps us a lot.</div>
        </div>
        ${c.fields.category && c.categories.length
          ? `<div class="field"><label class="label" for="f-cat">Category</label>
               <select class="select" id="f-cat" name="category"><option value="">Choose one…</option>${cats}</select></div>`
          : ''}
        ${c.fields.severity
          ? `<div class="field"><label class="label" for="f-sev">Severity</label>
               <select class="select" id="f-sev" name="severity">${sevs}</select></div>`
          : ''}
        ${c.fields.attachments
          ? `<div class="field">
               <label class="label">Attachments</label>
               <button type="button" class="btn btn-ghost" data-act="pick-file">${I.paperclipIcon()} &nbsp;Attach a file or screenshot</button>
               <input type="file" id="file-input" hidden
                      accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,application/zip" />
               ${files}
             </div>`
          : ''}
        <button class="btn" type="submit" ${state.submitting ? 'disabled' : ''}>
          ${state.submitting ? 'Submitting…' : 'Submit ticket'}
        </button>
      </form>
    </div>`;
}

function createdView(): string {
  return `
    <div class="body">
      <div class="success-wrap">
        <div class="success-ico">${I.checkIcon()}</div>
        <div style="font-size:15px;font-weight:650">Ticket created</div>
        <div class="success-ref">${esc(state.createdRef ?? '')}</div>
        <div style="font-size:12.5px;color:var(--muted);line-height:1.5;margin-bottom:18px">
          We've sent a confirmation by email. You can track progress under My Tickets.
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost" data-act="home">Back to start</button>
          <button class="btn" data-act="view-created">View ticket</button>
        </div>
      </div>
    </div>`;
}

function ticketsView(): string {
  if (state.loading) return `<div class="body"><div class="spinner" style="margin:34px auto"></div></div>`;
  if (!state.tickets.length) {
    return `<div class="body"><div class="empty">
      <div class="empty-ico">${I.inboxIcon()}</div>
      <div class="empty-title">No tickets yet</div>
      <div class="empty-text">When you raise a ticket it will appear here so you can track it.</div>
    </div></div>`;
  }
  const items = state.tickets
    .map(
      (t) => `
      <button class="list-item" data-ticket="${esc(t.id)}">
        <div class="list-top">
          <span class="list-title">${esc(t.subject || t.description.slice(0, 60))}</span>
          <span class="pill pill-${esc(t.status)}">${esc(STATUS_LABEL[t.status] ?? t.status)}</span>
        </div>
        <div class="list-meta">${esc(t.reference)} · ${esc(relTime(t.raised_at))}</div>
      </button>`,
    )
    .join('');
  return `<div class="body">${banner()}${items}</div>`;
}

function ticketView(): string {
  const t = state.ticket;
  if (!t) return `<div class="body"><div class="spinner" style="margin:34px auto"></div></div>`;

  const comments = (t.comments ?? [])
    .map(
      (c) => `
      <div class="comment">
        <div class="comment-head">
          <span class="comment-author">${esc(c.author_type === 'raiser' ? 'You' : (c.author_name ?? 'Support'))}</span>
          <span class="comment-time">${esc(relTime(c.created_at))}</span>
        </div>
        <div class="comment-body">${esc(c.body)}</div>
      </div>`,
    )
    .join('');

  return `
    <div class="body">
      ${banner()}
      <div class="list-top" style="margin-bottom:10px">
        <span class="pill pill-${esc(t.status)}">${esc(STATUS_LABEL[t.status] ?? t.status)}</span>
        ${t.severity ? `<span class="pill pill-${esc(t.severity)}">${esc(t.severity)}</span>` : ''}
      </div>
      <div style="font-size:14.5px;font-weight:650;margin-bottom:5px">${esc(t.subject || 'Support request')}</div>
      <div class="list-meta" style="margin-bottom:12px">
        ${esc(t.reference)} · raised ${esc(relTime(t.raised_at))}
        ${t.assignee ? ` · assigned to ${esc(t.assignee.display_name)}` : ''}
      </div>
      <div class="comment-body" style="padding-bottom:12px;border-bottom:1px solid var(--line)">${esc(t.description)}</div>
      ${comments}
      <form data-form="comment" style="margin-top:14px">
        <div class="field">
          <label class="label" for="f-reply">Add a reply</label>
          <textarea class="textarea" id="f-reply" name="body" required style="min-height:74px"
                    placeholder="Anything else we should know?"></textarea>
        </div>
        <button class="btn" type="submit" ${state.submitting ? 'disabled' : ''}>
          ${state.submitting ? 'Sending…' : 'Send reply'}
        </button>
      </form>
    </div>`;
}

function docsView(): string {
  const results = state.docs
    .map(
      (a) => `
      <button class="list-item" data-article="${esc(a.id)}">
        <div class="list-title">${esc(a.title)}</div>
        <div class="answer-excerpt" style="margin-top:3px">${esc(a.excerpt)}</div>
        <div class="list-meta" style="margin-top:5px">
          ${a.category ? `${esc(a.category)} · ` : ''}${a.views} views${a.helpful_pct !== null ? ` · ${a.helpful_pct}% found this helpful` : ''}
        </div>
      </button>`,
    )
    .join('');

  return `
    <div class="body">
      ${banner()}
      <form data-form="docs" style="margin-bottom:14px">
        <div class="composer-box">
          <input class="composer-input" name="q" placeholder="Search help articles…"
                 value="${esc(state.docsQuery)}" aria-label="Search help articles" />
          <button class="send-btn" type="submit" aria-label="Search">${I.searchIcon(17)}</button>
        </div>
      </form>
      ${state.loading ? `<div class="spinner" style="margin:26px auto"></div>` : ''}
      ${!state.loading && !state.docs.length
        ? `<div class="empty"><div class="empty-ico">${I.docIcon()}</div>
             <div class="empty-title">Nothing found</div>
             <div class="empty-text">Try different words, or create a ticket and we'll help directly.</div></div>`
        : results}
    </div>`;
}

function articleView(): string {
  const a = state.article;
  if (!a) return `<div class="body"><div class="spinner" style="margin:34px auto"></div></div>`;
  return `
    <div class="body">
      ${banner()}
      <div style="font-size:16px;font-weight:700;line-height:1.35;margin-bottom:6px">${esc(a.title)}</div>
      <div class="list-meta" style="margin-bottom:14px">
        ${a.category ? `${esc(a.category)} · ` : ''}${a.views} views
      </div>
      <div class="article-body">${esc(a.body ?? a.excerpt)}</div>
      <div class="helpful">
        <span class="helpful-label">Was this helpful?</span>
        <button class="helpful-btn" data-helpful="yes">${I.thumbUpIcon()} Yes</button>
        <button class="helpful-btn" data-helpful="no">${I.thumbDownIcon()} No</button>
      </div>
    </div>`;
}

function announcementsView(): string {
  if (state.loading) return `<div class="body"><div class="spinner" style="margin:34px auto"></div></div>`;
  if (!state.announcements.length) {
    return `<div class="body"><div class="empty">
      <div class="empty-ico">${I.megaphoneIcon(38)}</div>
      <div class="empty-title">Nothing new</div>
      <div class="empty-text">Product updates and incident notices will show up here.</div>
    </div></div>`;
  }
  const items = state.announcements
    .map(
      (a) => `
      <div class="list-item" style="cursor:default">
        <div class="list-top">
          <span class="list-title">${esc(a.title)}</span>
          <span class="pill pill-${a.kind === 'incident' ? 'high' : a.kind === 'maintenance' ? 'medium' : 'low'}">${esc(a.kind)}</span>
        </div>
        <div class="answer-excerpt" style="margin-top:4px">${esc(a.body)}</div>
        <div class="list-meta" style="margin-top:6px">${esc(relTime(a.published_at))}</div>
      </div>`,
    )
    .join('');
  return `<div class="body">${items}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────
function render(): void {
  if (state.loading && !state.config) {
    root.innerHTML = `${header()}<div class="body"><div class="spinner" style="margin:44px auto"></div></div>${footer()}`;
    return;
  }
  if (state.error && !state.config) {
    root.innerHTML = `${header()}
      <div class="body"><div class="banner banner-err">${esc(state.error)}</div>
        <button class="btn btn-ghost" data-act="retry">Try again</button></div>
      ${footer()}`;
    bind();
    return;
  }

  const views: Record<View, () => string> = {
    home: homeView,
    ask: askView,
    create: createView,
    created: createdView,
    tickets: ticketsView,
    ticket: ticketView,
    docs: docsView,
    article: articleView,
    announcements: announcementsView,
  };

  root.innerHTML = `${header()}${views[state.view]()}${footer()}`;
  bind();

  if (state.view === 'ask') {
    const scroll = document.getElementById('chat-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Behaviour
// ─────────────────────────────────────────────────────────────────────────
function go(view: View): void {
  state.view = view;
  state.banner = null;
  render();
}

function saveDraft(d: { subject?: string; description?: string }): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* private mode */
  }
}
function loadDraft(): { subject?: string; description?: string } {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

function fail(err: unknown): void {
  const msg =
    err instanceof ApiError
      ? err.code === 'deflection_unavailable'
        ? 'The assistant is unavailable right now — you can still create a ticket.'
        : err.message
      : 'Something went wrong. Please try again.';
  state.banner = { kind: 'err', text: msg };
}

async function doAsk(question: string): Promise<void> {
  state.chat.push({ role: 'user', text: question });
  state.asking = true;
  go('ask');

  try {
    const res = await api.ask(question, state.conversationId);
    state.conversationId = res.conversation_id;
    const found = res.answers.length > 0;
    /**
     * Phase 13. When Core returned a grounded answer, IT becomes the bubble
     * and the cards below are its sources — which is what the cards already
     * were. When it did not (RAG off, skipped, or failed), the canned line is
     * used exactly as before, so this is additive in behaviour as well as in
     * type.
     */
    const g = res.grounded_answer;
    state.chat.push({
      role: 'assistant',
      text: g
        ? g.answer
        : found
          ? "Here's what I found that should help:"
          : "I couldn't find anything matching that. A support engineer can help.",
      answers: res.answers,
      cited: g?.cited,
      grounded: Boolean(g) && !g?.insufficient,
      escalate: res.suggested_action === 'create_ticket' || !found,
    });
  } catch (err) {
    fail(err);
    state.chat.push({
      role: 'assistant',
      text: 'I could not search just now. You can still create a ticket and we will pick it up.',
      escalate: true,
    });
  } finally {
    state.asking = false;
    render();
  }
}

async function loadTickets(): Promise<void> {
  state.loading = true;
  go('tickets');
  try {
    state.tickets = (await api.myTickets()).data;
  } catch (err) {
    fail(err);
  } finally {
    state.loading = false;
    render();
  }
}

async function openTicket(id: string): Promise<void> {
  state.ticket = null;
  go('ticket');
  try {
    state.ticket = await api.ticket(id);
  } catch (err) {
    fail(err);
  }
  render();
}

async function loadDocs(q: string): Promise<void> {
  state.docsQuery = q;
  state.loading = true;
  go('docs');
  try {
    state.docs = (await api.searchDocs(q)).data;
  } catch (err) {
    fail(err);
    state.docs = [];
  } finally {
    state.loading = false;
    render();
  }
}

async function openArticle(id: string): Promise<void> {
  state.article = null;
  go('article');
  try {
    state.article = await api.article(id);
  } catch (err) {
    fail(err);
  }
  render();
}

async function loadAnnouncements(): Promise<void> {
  state.loading = true;
  go('announcements');
  try {
    state.announcements = (await api.announcements()).data;
  } catch (err) {
    fail(err);
  } finally {
    state.loading = false;
    render();
  }
}

function onTile(id: string): void {
  switch (id) {
    case 'ask':
      state.chat = [
        { role: 'assistant', text: 'Ask me anything — I search the help centre and past resolved tickets.' },
      ];
      go('ask');
      break;
    case 'create_ticket':
      state.fromLiveChat = false;
      go('create');
      break;
    case 'search_docs':
      void loadDocs('');
      break;
    case 'my_tickets':
      void loadTickets();
      break;
    case 'upload_screenshot':
      state.fromLiveChat = false;
      go('create');
      setTimeout(() => document.getElementById('file-input')?.click(), 60);
      break;
    case 'live_chat':
      // ADR-011: real-time chat is deferred. The conversation becomes a ticket
      // and we say so plainly — never a chat window that will not connect.
      state.fromLiveChat = true;
      go('create');
      break;
    case 'ai_suggestions':
      state.chat = [
        {
          role: 'assistant',
          text: 'Tell me what you are trying to do and I will suggest the most relevant articles and past fixes.',
        },
      ];
      go('ask');
      break;
    case 'announcements':
      void loadAnnouncements();
      break;
  }
}

async function submitTicket(form: HTMLFormElement): Promise<void> {
  const fd = new FormData(form);
  const description = String(fd.get('description') ?? '').trim();
  if (!description) return;

  state.submitting = true;
  render();

  try {
    const ticket = await api.createTicket({
      product_tenant_id: 'acme-corp',
      subject: (fd.get('subject') as string) || null,
      description,
      category: (fd.get('category') as string) || null,
      severity: (fd.get('severity') as string) || null,
      conversation_id: state.conversationId,
      from_live_chat: state.fromLiveChat,
      metadata: { page: document.referrer || null },
    });

    if (state.pendingAttachments.length) {
      await api.linkAttachments(
        ticket.id,
        state.pendingAttachments.map((a) => a.id),
      );
    }

    clearDraft();
    state.pendingAttachments = [];
    state.createdRef = ticket.reference;
    state.createdId = ticket.id;
    state.conversationId = null;
    state.fromLiveChat = false;
    go('created');
  } catch (err) {
    fail(err);
    // The user's text is preserved so a network blip never costs them 300 words.
    saveDraft({ subject: String(fd.get('subject') ?? ''), description });
    render();
  } finally {
    state.submitting = false;
  }
}

function bind(): void {
  root.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.onclick = () => {
      const act = el.dataset.act!;
      if (act === 'close') parent.postMessage({ source: NS, type: 'close' }, '*');
      if (act === 'back') go(state.view === 'article' ? 'docs' : state.view === 'ticket' ? 'tickets' : 'home');
      if (act === 'home' || act === 'restart') {
        state.chat = [];
        state.conversationId = null;
        go('home');
      }
      if (act === 'retry') void boot();
      if (act === 'escalate') {
        state.fromLiveChat = false;
        const last = [...state.chat].reverse().find((t) => t.role === 'user');
        if (last) saveDraft({ description: last.text });
        go('create');
      }
      if (act === 'view-created' && state.createdId) void openTicket(state.createdId);
      if (act === 'pick-file') document.getElementById('file-input')?.click();
    };
  });

  root.querySelectorAll<HTMLElement>('[data-tile]').forEach((el) => {
    el.onclick = () => onTile(el.dataset.tile!);
  });
  root.querySelectorAll<HTMLElement>('[data-suggest]').forEach((el) => {
    el.onclick = () => void doAsk(el.dataset.suggest!);
  });
  root.querySelectorAll<HTMLElement>('[data-article]').forEach((el) => {
    el.onclick = () => void openArticle(el.dataset.article!);
  });
  root.querySelectorAll<HTMLElement>('[data-ticket]').forEach((el) => {
    el.onclick = () => void openTicket(el.dataset.ticket!);
  });
  root.querySelectorAll<HTMLElement>('[data-helpful]').forEach((el) => {
    el.onclick = async () => {
      if (!state.article) return;
      try {
        await api.voteHelpful(state.article.id, el.dataset.helpful === 'yes');
        state.banner = { kind: 'ok', text: 'Thanks — that helps us improve these articles.' };
      } catch {
        /* a failed vote is not worth interrupting the user */
      }
      render();
    };
  });
  root.querySelectorAll<HTMLElement>('[data-remove-file]').forEach((el) => {
    el.onclick = () => {
      state.pendingAttachments = state.pendingAttachments.filter((a) => a.id !== el.dataset.removeFile);
      render();
    };
  });

  const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      // Client-side check is fast feedback only; the server re-validates.
      if (file.size > 25 * 1024 * 1024) {
        state.banner = { kind: 'err', text: 'That file is larger than 25 MB.' };
        render();
        return;
      }
      try {
        const up = await api.uploadAttachment(file);
        state.pendingAttachments.push({ id: up.id, filename: up.filename });
        state.banner = null;
      } catch (err) {
        fail(err);
      }
      render();
    };
  }

  root.querySelectorAll<HTMLFormElement>('[data-form]').forEach((form) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const kind = form.dataset.form;
      if (kind === 'ask') {
        const input = form.querySelector<HTMLInputElement>('input[name=q]')!;
        const q = input.value.trim();
        if (!q) return;
        input.value = '';
        void doAsk(q);
      }
      if (kind === 'docs') {
        void loadDocs(form.querySelector<HTMLInputElement>('input[name=q]')!.value.trim());
      }
      if (kind === 'create') void submitTicket(form);
      if (kind === 'comment' && state.ticket) {
        const ta = form.querySelector<HTMLTextAreaElement>('textarea[name=body]')!;
        const body = ta.value.trim();
        if (!body) return;
        state.submitting = true;
        render();
        void api
          .addComment(state.ticket.id, body)
          .then(() => openTicket(state.ticket!.id))
          .catch((err) => {
            fail(err);
            render();
          })
          .finally(() => {
            state.submitting = false;
          });
      }
    };
  });

  const desc = root.querySelector<HTMLTextAreaElement>('#f-desc');
  if (desc) {
    desc.oninput = () => {
      const subject = root.querySelector<HTMLInputElement>('#f-subject')?.value ?? '';
      saveDraft({ subject, description: desc.value });
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────
function applyTheme(cfg: WidgetConfig): void {
  const primary = params.get('primary') || cfg.branding.primary_color;
  document.documentElement.style.setProperty('--primary', primary);
  document.documentElement.style.setProperty('--primary-dark', cfg.branding.accent_color || primary);
}

async function boot(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const cfg = await api.config();
    state.config = cfg;
    applyTheme(cfg);
    state.error = null;
  } catch (err) {
    state.error =
      err instanceof ApiError && err.code === 'origin_not_allowed'
        ? 'This site is not registered to use the support widget.'
        : 'Support is unavailable right now. Please try again shortly.';
  } finally {
    state.loading = false;
    render();
  }
}

window.addEventListener('message', (event) => {
  const data = event.data as { source?: string; type?: string; token?: string } | null;
  if (!data || data.source !== NS) return;
  if (data.type === 'identity' && data.token) {
    setIdentityToken(data.token);
    // Re-fetch config so the greeting picks up the now-known user name.
    if (!hasIdentity()) return;
    void boot();
  }
  if (data.type === 'focus') {
    root.querySelector<HTMLInputElement>('.composer-input')?.focus();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') parent.postMessage({ source: NS, type: 'close' }, '*');
});

parent.postMessage({ source: NS, type: 'ready' }, '*');

/**
 * Optional deep link: `?view=create` opens straight to a view.
 * Products use this to wire their own entry points — e.g. a "Report a problem
 * with this invoice" button that opens the ticket form directly.
 * See widget/INTEGRATION.md.
 */
const OPENABLE: Record<string, string> = {
  ask: 'ask',
  create: 'create_ticket',
  docs: 'search_docs',
  tickets: 'my_tickets',
  announcements: 'announcements',
};

void boot().then(() => {
  const requested = params.get('view');
  if (requested && OPENABLE[requested] && state.config) onTile(OPENABLE[requested]!);
});
