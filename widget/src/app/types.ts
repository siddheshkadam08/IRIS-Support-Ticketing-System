export interface AskAnswer {
  type: 'kb_article' | 'resolved_ticket';
  id: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface AskResponse {
  conversation_id: string;
  suggested_action: 'answer' | 'create_ticket';
  answers: AskAnswer[];
  prefill: { description: string; category: string | null; severity: string | null };
}

export interface KbArticle {
  id: string;
  title: string;
  category: string | null;
  excerpt: string;
  body?: string;
  score?: number;
  helpful_pct: number | null;
  views: number;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  kind: string;
  published_at: string;
}

export interface Comment {
  id: string;
  author_type: 'raiser' | 'assignee' | 'system';
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface Ticket {
  id: string;
  reference: string;
  status: string;
  subject: string | null;
  description: string;
  category: string | null;
  severity: string | null;
  raised_at: string;
  assignee: { id: string; display_name: string } | null;
  comments?: Comment[];
}

export type View =
  | 'home'
  | 'ask'
  | 'create'
  | 'created'
  | 'tickets'
  | 'ticket'
  | 'docs'
  | 'article'
  | 'announcements';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  answers?: AskAnswer[];
  escalate?: boolean;
}
