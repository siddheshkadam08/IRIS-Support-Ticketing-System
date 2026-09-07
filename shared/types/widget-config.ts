/**
 * The shape of a product's widget configuration.
 *
 * One definition, three consumers: core-service serves it, the admin portal
 * edits it, the widget renders it. Kept here because the alternative — each
 * side carrying its own idea of the shape — is how a portal ends up writing a
 * key the widget never reads, with nothing failing loudly enough to notice.
 */

/** The eight tiles. A product may enable any subset. */
export const WIDGET_CAPABILITIES = [
  'ask',
  'create_ticket',
  'search_docs',
  'my_tickets',
  'upload_screenshot',
  'live_chat',
  'ai_suggestions',
  'announcements',
] as const;

export type WidgetCapability = (typeof WIDGET_CAPABILITIES)[number];

/** Human labels, so the portal and the widget describe a tile the same way. */
export const CAPABILITY_LABELS: Record<WidgetCapability, string> = {
  ask: 'Ask a Question',
  create_ticket: 'Create a Ticket',
  search_docs: 'Search Docs',
  my_tickets: 'My Tickets',
  upload_screenshot: 'Upload Screenshot',
  live_chat: 'Live Chat',
  ai_suggestions: 'AI Suggestions',
  announcements: 'Announcements',
};

export const WIDGET_DEFAULTS = {
  title: 'AI Support',
  subtitle: 'Your smart support assistant',
  greeting: 'How can I help you today?',
  primary_color: '#1D4ED8',
  accent_color: '#2563EB',
  suggestions: [
    'How do I reset my password?',
    'Why is my invoice not showing?',
    "I'm getting an error while exporting data",
  ],
} as const;

/** A ticket category offered in the widget's Create a Ticket form. */
export interface WidgetCategory {
  value: string;
  label: string;
}

export interface WidgetBranding {
  title: string;
  subtitle: string;
  greeting: string;
  primary_color: string;
  accent_color: string;
  logo_text: string | null;
}

export interface WidgetFields {
  subject: boolean;
  category: boolean;
  severity: boolean;
  attachments: boolean;
}

/** What the admin portal reads and writes. Flat on purpose — the nesting in
 *  `product.config` is a storage detail, not something an editor should model. */
export interface WidgetSettings {
  branding: WidgetBranding;
  capabilities: WidgetCapability[];
  fields: WidgetFields;
  suggestions: string[];
  categories: WidgetCategory[];
  allow_anonymous: boolean;
  knowledge_base_enabled: boolean;
  deflection_enabled: boolean;
}

/** `#rrggbb`. Anything else would be injected straight into the widget's CSS. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * A category `value` is stored on the ticket and appears in filters and
 * exports, so it is an identifier rather than a label — lowercase, no spaces.
 */
export const CATEGORY_VALUE = /^[a-z0-9_]+$/;

export const slugifyCategory = (label: string): string =>
  label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
