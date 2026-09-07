/** Inline SVG icons — no icon font, no external requests (CSP-friendly). */

const s = (size: number, body: string, sw = 1.6): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** The assistant avatar, matching the launcher bubble. */
export const robot = (size = 22, stroke = '#fff'): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
     <rect x="4" y="7" width="16" height="12" rx="3.2" stroke="${stroke}" stroke-width="1.7"/>
     <path d="M12 3.4v3.6" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round"/>
     <circle cx="12" cy="2.7" r="1.15" fill="${stroke}"/>
     <circle cx="9.3" cy="12.6" r="1.35" fill="${stroke}"/>
     <circle cx="14.7" cy="12.6" r="1.35" fill="${stroke}"/>
     <path d="M9.6 15.9h4.8" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round"/>
     <path d="M2.6 11.4v2.4M21.4 11.4v2.4" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round"/>
   </svg>`;

// ── the eight capability tiles ─────────────────────────────────────────
export const askIcon = (n = 24) =>
  s(n, `<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.4A8.4 8.4 0 1 1 21 11.5Z"/>
        <path d="M9.6 9.2a2.5 2.5 0 0 1 4.85.83c0 1.67-2.5 2.5-2.5 2.5"/>
        <path d="M12 15.6h.01"/>`);

export const ticketIcon = (n = 24) =>
  s(n, `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/>
        <path d="M14 3l5 5v3"/><path d="M14 3v5h5"/>
        <path d="M18 15v6M15 18h6"/>`);

export const searchIcon = (n = 24) =>
  s(n, `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>`);

export const myTicketsIcon = (n = 24) =>
  s(n, `<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v5"/>
        <path d="M4 5.5V18.5A1.5 1.5 0 0 0 5.5 20H11"/>
        <path d="M7.5 8h5M7.5 11.5h3"/>
        <circle cx="16.5" cy="16.5" r="3.5"/><path d="m20.5 20.5-1.6-1.6"/>`);

export const uploadIcon = (n = 24) =>
  s(n, `<rect x="3" y="4.5" width="18" height="15" rx="2.2"/>
        <path d="m3.6 16.5 4.2-4.2a2 2 0 0 1 2.8 0l2.3 2.3"/>
        <path d="M16.4 8.6v5.2M14.2 10.8l2.2-2.2 2.2 2.2"/>`);

export const chatIcon = (n = 24) =>
  s(n, `<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.4A8.4 8.4 0 1 1 21 11.5Z"/>
        <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/>`);

export const sparkleIcon = (n = 24) =>
  s(n, `<path d="M12 3.2 13.7 8 18.5 9.7 13.7 11.4 12 16.2 10.3 11.4 5.5 9.7 10.3 8 12 3.2Z"/>
        <path d="M18.5 15.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z"/>`);

export const megaphoneIcon = (n = 24) =>
  s(n, `<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/>
        <path d="M15.5 8.5a4.5 4.5 0 0 1 0 7"/><path d="M18.5 5.5a8.5 8.5 0 0 1 0 13"/>`);

// ── chrome ─────────────────────────────────────────────────────────────
export const sendIcon = (n = 18) => s(n, `<path d="M21.5 2.5 11 13"/><path d="M21.5 2.5 15 21l-4-8-8-4 18.5-6.5Z"/>`);
export const backIcon = (n = 18) => s(n, `<path d="M15 5l-7 7 7 7"/>`, 1.9);
export const closeIcon = (n = 17) => s(n, `<path d="M18 6 6 18M6 6l12 12"/>`, 1.9);
export const minimiseIcon = (n = 17) => s(n, `<path d="M5 12h14"/>`, 1.9);
export const refreshIcon = (n = 16) =>
  s(n, `<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.2V9h-4.8"/>`);
export const checkIcon = (n = 26) => s(n, `<path d="m4.5 12.5 5 5 10-11"/>`, 2.2);
export const paperclipIcon = (n = 15) =>
  s(n, `<path d="M20 11.5 12.3 19.2a4.6 4.6 0 0 1-6.5-6.5l7.7-7.7a3 3 0 0 1 4.3 4.3l-7.7 7.7a1.5 1.5 0 0 1-2.1-2.1l7-7"/>`);
export const thumbUpIcon = (n = 14) =>
  s(n, `<path d="M7 10.5v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7Z"/>
        <path d="M7 10.5 11 2.5a2.2 2.2 0 0 1 2.2 2.7L12.5 8.5h5.2a2 2 0 0 1 2 2.5l-1.4 6a2 2 0 0 1-2 1.5H7"/>`);
export const thumbDownIcon = (n = 14) =>
  s(n, `<path d="M7 13.5v-9H4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H7Z"/>
        <path d="M7 13.5 11 21.5a2.2 2.2 0 0 0 2.2-2.7l-.7-3.3h5.2a2 2 0 0 0 2-2.5l-1.4-6a2 2 0 0 0-2-1.5H7"/>`);
export const inboxIcon = (n = 40) =>
  s(n, `<path d="M4 13h4l2 3h4l2-3h4"/><path d="M4 13 6.5 5.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L20 13v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V13Z"/>`, 1.4);
export const docIcon = (n = 40) =>
  s(n, `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 16.5h4"/>`, 1.4);
