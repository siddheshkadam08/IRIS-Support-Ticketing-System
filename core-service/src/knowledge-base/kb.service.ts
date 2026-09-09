import {
  AppError,
  allowedKbTransitions,
  canEditKbArticle,
  canPublishKb,
  isLegalKbTransition,
  type KbArticleStatus,
} from '@iris/shared/types';

/**
 * KB lifecycle rules — Phase 18.
 *
 * DELIBERATELY THIN, AND DELIBERATELY NOT A REPOSITORY. There is no SQL here
 * and there should never be any: this file exists to answer two questions that
 * are neither persistence nor HTTP.
 *
 *   "May this actor make this change?"
 *   "Is this transition one the lifecycle allows?"
 *
 * The ANSWERS live in shared/types/kb.ts, as data, because the admin panel has
 * to reach the same conclusions to decide which controls to render. What lives
 * HERE is the translation from a boolean into the right IRIS error — which
 * status code, and a message an operator can act on. That translation is
 * server-only and has no business in a shared module the browser imports.
 *
 * ⚠️ WHY THE MESSAGES ARE THIS SPECIFIC. A refused lifecycle change is not a
 * bug report, it is a workflow answer. "Forbidden" tells an agent nothing;
 * "publishing requires a manager" tells them who to ask. None of these messages
 * name another tenant, another user, or whether a resource exists — that
 * distinction is `assertTenant`'s job and it stays a not-found.
 */

/**
 * ⚠️ THE ILLEGAL TRANSITION IS A 409, NOT A 400.
 *
 * `invalid_state_transition` is the code the ticket state machine already uses
 * for exactly this shape of refusal. It matters because the two mean different
 * things to a caller: a 400 says the request was malformed and retrying it
 * unchanged is pointless, while a 409 says the request was well-formed but the
 * resource is not in a state that accepts it — retry after changing the
 * resource. Publishing an archived article is the second thing, and the message
 * says what the intermediate step is.
 */
export function assertKbTransition(from: KbArticleStatus, to: KbArticleStatus): void {
  if (isLegalKbTransition(from, to)) return;

  if (from === to) {
    throw new AppError(
      'invalid_state_transition',
      `This article is already ${from}.`,
    );
  }

  if (from === 'archived' && to === 'published') {
    throw new AppError(
      'invalid_state_transition',
      'An archived article cannot be published directly. Restore it to draft first, ' +
        'so its text is reviewed before it returns to the knowledge base and to AI answers.',
    );
  }

  const allowed = allowedKbTransitions(from);
  throw new AppError(
    'invalid_state_transition',
    `A ${from} article cannot become ${to}. Allowed from here: ${allowed.join(', ')}.`,
  );
}

/**
 * Publication is a governance decision, so it has a role gate of its own that
 * is separate from "may this person touch KB articles at all".
 *
 * Every transition goes through this, not just draft -> published. Unpublishing
 * and archiving withdraw an article that customers and the AI are currently
 * using, which is the same class of decision as putting it there.
 */
export function assertCanTransitionKb(role: string): void {
  if (canPublishKb(role)) return;
  throw new AppError(
    'forbidden',
    'Publishing, unpublishing and archiving require a manager, product admin or super admin. ' +
      'You can create and edit drafts.',
  );
}

/**
 * ⚠️ THE STATE IS PART OF THE PERMISSION, not just the role.
 *
 * An agent may edit a draft and not a published article, and NOBODY may edit an
 * archived one. Passing the article's current status in — read from the
 * database row, never from the request — is what makes that expressible.
 */
export function assertCanEditKb(role: string, status: KbArticleStatus): void {
  if (canEditKbArticle(role, status)) return;

  if (status === 'archived') {
    throw new AppError(
      'invalid_state_transition',
      'An archived article cannot be edited. Restore it to draft first.',
    );
  }

  throw new AppError(
    'forbidden',
    'Editing a published article requires a manager, product admin or super admin. ' +
      'Unpublish it to a draft, or ask someone who can.',
  );
}
