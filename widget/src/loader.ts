/**
 * IRIS Support widget loader.
 *
 *   <script src="https://support.example/widget.js"
 *           data-product-key="pub_live_..."
 *           data-identity-token="<short-lived JWT your backend minted>"
 *           defer></script>
 *
 * This runs on someone else's page. It must be invisible until invoked and
 * impossible to blame:
 *   - injects an iframe, never inline DOM, so host CSS/JS cannot reach it
 *   - touches no host globals beyond one namespaced key
 *   - never throws onto the host page; failures render inside the iframe
 *   - namespaces every id, class and storage key with `iris-support-`
 */
const NS = 'iris-support';

interface WidgetOptions {
  productKey: string;
  identityToken?: string | null;
  origin: string;
  position: 'bottom-right' | 'bottom-left';
  primaryColor: string;
  autoOpen: boolean;
  openView: string | null;
  zIndex: number;
}

function readOptions(): WidgetOptions | null {
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[data-product-key]');

  if (!script) return null;
  const d = script.dataset;
  const productKey = d.productKey ?? '';
  if (!productKey) {
    // Fail quietly on the host page — a console error storm on someone else's
    // product is our problem, not theirs.
    console.warn('[iris-support] data-product-key is missing; widget not mounted.');
    return null;
  }

  let origin = d.origin ?? '';
  if (!origin) {
    try {
      origin = new URL(script.src).origin;
    } catch {
      origin = window.location.origin;
    }
  }

  return {
    productKey,
    identityToken: d.identityToken ?? null,
    origin: origin.replace(/\/$/, ''),
    position: d.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
    primaryColor: d.primaryColor ?? '#1D4ED8',
    autoOpen: d.autoOpen === 'true',
    openView: d.openView ?? null,
    zIndex: Number(d.zIndex ?? 2147483000),
  };
}

function build(opts: WidgetOptions) {
  const side = opts.position === 'bottom-left' ? 'left' : 'right';

  const launcher = document.createElement('button');
  launcher.id = `${NS}-launcher`;
  launcher.type = 'button';
  launcher.setAttribute('aria-label', 'Open support');
  launcher.innerHTML = `
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3.2" stroke="#fff" stroke-width="1.7"/>
      <path d="M12 3.4v3.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
      <circle cx="12" cy="2.7" r="1.15" fill="#fff"/>
      <circle cx="9.3" cy="12.6" r="1.35" fill="#fff"/>
      <circle cx="14.7" cy="12.6" r="1.35" fill="#fff"/>
      <path d="M9.6 15.9h4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M2.6 11.4v2.4M21.4 11.4v2.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`;

  const frame = document.createElement('iframe');
  frame.id = `${NS}-frame`;
  frame.title = 'Support assistant';
  const src = new URL(`${opts.origin}/app/index.html`);
  src.searchParams.set('key', opts.productKey);
  src.searchParams.set('primary', opts.primaryColor);
  // Deep link straight to a view: ask | create | docs | tickets | announcements
  if (opts.openView) src.searchParams.set('view', opts.openView);
  frame.src = src.toString();
  frame.setAttribute('allow', 'clipboard-write');

  const style = document.createElement('style');
  style.id = `${NS}-style`;
  style.textContent = `
    #${NS}-launcher{position:fixed;bottom:22px;${side}:22px;width:58px;height:58px;border-radius:50%;
      border:0;cursor:pointer;background:${opts.primaryColor};color:#fff;z-index:${opts.zIndex};
      box-shadow:0 8px 24px rgba(15,23,42,.28);display:flex;align-items:center;justify-content:center;
      transition:transform .18s ease, box-shadow .18s ease;padding:0}
    #${NS}-launcher:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 12px 30px rgba(15,23,42,.34)}
    #${NS}-launcher:focus-visible{outline:3px solid #fff;outline-offset:3px}
    #${NS}-launcher[data-open="true"] svg{transform:rotate(90deg);opacity:.9}
    /* 500px is the measured minimum at which the 4x2 tile grid renders without
       clipping at these font sizes. Below it the grid drops to 2 columns. */
    #${NS}-frame{position:fixed;bottom:92px;${side}:22px;width:500px;height:660px;max-height:calc(100vh - 120px);
      max-width:calc(100vw - 32px);border:0;border-radius:18px;z-index:${opts.zIndex};
      box-shadow:0 24px 60px rgba(15,23,42,.26);display:none;background:transparent;
      opacity:0;transform:translateY(10px) scale(.98);transition:opacity .18s ease, transform .18s ease}
    #${NS}-frame[data-open="true"]{display:block;opacity:1;transform:none}
    @media (max-width:560px){
      #${NS}-frame{width:calc(100vw - 24px);height:calc(100vh - 104px);bottom:84px;${side}:12px}
    }
    @media (prefers-reduced-motion:reduce){
      #${NS}-launcher,#${NS}-frame{transition:none}
    }`;

  document.head.appendChild(style);
  document.body.appendChild(frame);
  document.body.appendChild(launcher);
  return { launcher, frame };
}

function mount(): void {
  const opts = readOptions();
  if (!opts) return;
  if (document.getElementById(`${NS}-frame`)) return; // never mount twice

  const { launcher, frame } = build(opts);
  let open = false;
  let frameReady = false;

  const post = (message: Record<string, unknown>) => {
    // Explicit targetOrigin — '*' would leak our payload to any frame.
    frame.contentWindow?.postMessage({ source: NS, ...message }, opts.origin);
  };

  const setOpen = (next: boolean) => {
    open = next;
    frame.setAttribute('data-open', String(open));
    launcher.setAttribute('data-open', String(open));
    launcher.setAttribute('aria-label', open ? 'Close support' : 'Open support');
    if (open && frameReady) post({ type: 'focus' });
  };

  launcher.addEventListener('click', () => setOpen(!open));

  window.addEventListener('message', (event) => {
    // Validate the origin on receipt, not just on send.
    if (event.origin !== opts.origin) return;
    const data = event.data as { source?: string; type?: string } | null;
    if (!data || data.source !== NS) return;

    if (data.type === 'ready') {
      frameReady = true;
      // The identity token travels by postMessage, never in the iframe URL —
      // URLs leak through history, referrers and server logs.
      if (opts.identityToken) post({ type: 'identity', token: opts.identityToken });
      if (opts.autoOpen) setOpen(true);
    }
    if (data.type === 'close') setOpen(false);
    if (data.type === 'open') setOpen(true);
  });

  // Public API, on one namespaced global.
  const api = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    /** Call after your user logs in, or to refresh an expiring token. */
    setIdentity: (token: string) => {
      opts.identityToken = token;
      if (frameReady) post({ type: 'identity', token });
    },
    isOpen: () => open,
  };
  (window as unknown as Record<string, unknown>).IrisSupport = api;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
