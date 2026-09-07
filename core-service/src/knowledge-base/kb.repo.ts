import type { KbArticleDTO } from '@iris/shared/types';
import type { Tx } from '../db/with-scope.js';

interface KbRow {
  id: string;
  title: string;
  category: string | null;
  body: string;
  views: number;
  helpful_yes: number;
  helpful_no: number;
  score?: number;
}

function excerpt(body: string, max = 180): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function helpfulPct(yes: number, no: number): number | null {
  const total = yes + no;
  return total === 0 ? null : Math.round((yes / total) * 100);
}

function toDTO(r: KbRow, includeBody = false): KbArticleDTO {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    excerpt: excerpt(r.body),
    ...(includeBody ? { body: r.body } : {}),
    ...(r.score !== undefined ? { score: Number(r.score.toFixed(4)) } : {}),
    helpful_pct: helpfulPct(r.helpful_yes, r.helpful_no),
    views: r.views,
  };
}

/**
 * Hybrid text search: full-text rank (weighted title > body) combined with
 * trigram similarity on the title, so short/typo'd queries still match.
 *
 * When ai-service lands this becomes a hybrid of THIS score and vector
 * distance against kb_article.embedding — the column already exists, so no
 * migration is needed. The endpoint contract does not change.
 */
export async function searchArticles(
  tx: Tx,
  query: string,
  opts: { category?: string | null; limit?: number } = {},
): Promise<KbArticleDTO[]> {
  const limit = Math.min(opts.limit ?? 5, 50);
  const q = query.trim();
  if (!q) return [];

  const { rows } = await tx.query<KbRow>(
    `SELECT id, title, category, body, views, helpful_yes, helpful_no,
            (ts_rank(search_tsv, websearch_to_tsquery('english', $1)) * 4
             + similarity(title, $1)) AS score
       FROM kb_article
      WHERE (search_tsv @@ websearch_to_tsquery('english', $1) OR similarity(title, $1) > 0.15)
        AND ($2::text IS NULL OR category = $2)
      ORDER BY score DESC
      LIMIT $3`,
    [q, opts.category ?? null, limit],
  );
  return rows.map((r) => toDTO(r));
}

export async function listArticles(
  tx: Tx,
  opts: { category?: string | null; limit?: number } = {},
): Promise<KbArticleDTO[]> {
  const { rows } = await tx.query<KbRow>(
    `SELECT id, title, category, body, views, helpful_yes, helpful_no
       FROM kb_article
      WHERE ($1::text IS NULL OR category = $1)
      ORDER BY views DESC, title ASC
      LIMIT $2`,
    [opts.category ?? null, Math.min(opts.limit ?? 20, 50)],
  );
  return rows.map((r) => toDTO(r));
}

export async function getArticle(tx: Tx, id: string): Promise<KbArticleDTO | null> {
  const { rows } = await tx.query<KbRow>(
    `SELECT id, title, category, body, views, helpful_yes, helpful_no
       FROM kb_article WHERE id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  await tx.query(`UPDATE kb_article SET views = views + 1 WHERE id = $1`, [id]);
  return toDTO(rows[0], true);
}

export async function voteHelpful(tx: Tx, id: string, helpful: boolean): Promise<void> {
  await tx.query(
    helpful
      ? `UPDATE kb_article SET helpful_yes = helpful_yes + 1 WHERE id = $1`
      : `UPDATE kb_article SET helpful_no  = helpful_no  + 1 WHERE id = $1`,
    [id],
  );
}

/**
 * Past resolved tickets as a second retrieval corpus — often a better answer
 * than a KB article, because someone already hit this exact problem.
 * Only resolved/closed tickets, and only the resolution comment is surfaced.
 */
export async function searchResolvedTickets(
  tx: Tx,
  query: string,
  limit = 3,
): Promise<Array<{ id: string; title: string; excerpt: string; score: number }>> {
  const q = query.trim();
  if (!q) return [];

  const { rows } = await tx.query<{
    id: string;
    reference: string;
    subject: string | null;
    description: string;
    resolution: string | null;
    score: number;
  }>(
    `SELECT t.id, t.reference, t.subject, t.description,
            (SELECT c.body FROM comment c
              WHERE c.ticket_id = t.id AND c.is_internal = false AND c.author_type = 'assignee'
              ORDER BY c.created_at DESC LIMIT 1) AS resolution,
            ts_rank(t.search_tsv, websearch_to_tsquery('english', $1)) AS score
       FROM ticket t
      WHERE t.status IN ('resolved','closed')
        AND t.search_tsv @@ websearch_to_tsquery('english', $1)
      ORDER BY score DESC
      LIMIT $2`,
    [q, limit],
  );

  return rows
    .filter((r) => r.resolution)
    .map((r) => ({
      id: r.id,
      title: r.subject ?? `${r.reference} — similar issue`,
      excerpt: excerpt(r.resolution!),
      score: Number(r.score),
    }));
}
