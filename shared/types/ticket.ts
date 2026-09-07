/**
 * Ticket domain types. These mirror the database CHECK constraints exactly —
 * an enum that drifts from the DB produces runtime failures the type system
 * cheerfully approves of.
 */

export const TICKET_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'waiting_on_raiser',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const AUTHOR_TYPES = ['raiser', 'assignee', 'system'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const IDENTITY_ASSURANCE = ['sso', 'email_verified', 'anonymous'] as const;
export type IdentityAssurance = (typeof IDENTITY_ASSURANCE)[number];

export const CLASSIFICATION_SOURCES = [
  'product',
  'ai_auto',
  'ai_uncertain',
  'unclassified',
] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const CONVERSATION_OUTCOMES = ['self_served', 'ticket_created', 'abandoned'] as const;
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];

/**
 * The ticket state machine, in one place.
 * `assigned` exists because it is the transition that fires the dual JIT access
 * grant (HLD §13). It is not rendered as a filter chip — see HLD §10.1.
 */
export const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['assigned', 'closed'],
  assigned: ['in_progress', 'open', 'resolved'],
  in_progress: ['waiting_on_raiser', 'resolved'],
  waiting_on_raiser: ['in_progress', 'resolved'],
  resolved: ['closed', 'open'],
  closed: ['open'],
} as const;

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses a *product* credential may set. Assignment/resolve are support-side. */
export const PRODUCT_SETTABLE_STATUSES: readonly TicketStatus[] = ['closed', 'open'];

/** Display mapping — HLD §10.1. `waiting_on_raiser` shows as "On Hold". */
export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  assigned: 'Open',
  in_progress: 'In Progress',
  waiting_on_raiser: 'On Hold',
  resolved: 'Resolved',
  closed: 'Closed',
};

export interface RaiserIdentity {
  ref: string;
  name: string | null;
  email: string | null;
  product_tenant_id: string;
}

export interface TicketDTO {
  id: string;
  reference: string;
  status: TicketStatus;
  product_tenant_id: string;
  subject: string | null;
  description: string;
  category: string | null;
  severity: Severity | null;
  classification_source: ClassificationSource;
  summary: string | null;
  raised_by: { ref: string; name: string | null; email: string | null };
  identity_assurance: IdentityAssurance;
  rating: number | null;
  rating_comment: string | null;
  raised_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  assignee: { id: string; display_name: string } | null;
  comments?: CommentDTO[];
  attachments?: AttachmentDTO[];
}

export interface CommentDTO {
  id: string;
  author_type: AuthorType;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface AttachmentDTO {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

export interface KbArticleDTO {
  id: string;
  title: string;
  category: string | null;
  excerpt: string;
  body?: string;
  score?: number;
  helpful_pct: number | null;
  views: number;
}

export interface AskAnswer {
  type: 'kb_article' | 'resolved_ticket';
  id: string;
  title: string;
  excerpt: string;
  score: number;
  url?: string;
}

export interface AskResponse {
  conversation_id: string;
  suggested_action: 'answer' | 'create_ticket';
  answers: AskAnswer[];
  prefill: { description: string; category: string | null; severity: Severity | null };
}

export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}
