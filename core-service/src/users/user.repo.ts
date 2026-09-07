import { newId } from '@iris/shared/types';
import { withScope, withSystemScope, type Tx } from '../db/with-scope.js';

export type SupportRole = 'super_admin' | 'product_admin' | 'manager' | 'agent';

export interface SupportUserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  role: SupportRole;
  availability: 'available' | 'busy' | 'away';
  is_active: boolean;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
}

export interface SupportUserWithScopes extends SupportUserRow {
  /** Product ids this user may work. Empty for super_admin, meaning ALL. */
  scopes: string[];
}

/**
 * Authentication lookup runs with a system scope, for the same reason product
 * credential lookup does: resolving WHO is calling is what establishes the
 * scope, so it cannot itself be scoped without being circular.
 * Lookup is by unique email and returns at most one row.
 */
export async function findByEmailForAuth(email: string): Promise<SupportUserWithScopes | null> {
  return withSystemScope('auth', async (tx) => {
    const { rows } = await tx.query<SupportUserRow>(
      `SELECT id, email, display_name, password_hash, role, availability, is_active,
              must_change_password, failed_login_count, locked_until, last_login_at
         FROM support_user
        WHERE lower(email) = lower($1)`,
      [email],
    );
    const user = rows[0];
    if (!user) return null;
    return { ...user, scopes: await scopesFor(tx, user.id) };
  });
}

export async function findByIdForSession(id: string): Promise<SupportUserWithScopes | null> {
  return withSystemScope('session', async (tx) => {
    const { rows } = await tx.query<SupportUserRow>(
      `SELECT id, email, display_name, password_hash, role, availability, is_active,
              must_change_password, failed_login_count, locked_until, last_login_at
         FROM support_user
        WHERE id = $1 AND is_active = true`,
      [id],
    );
    const user = rows[0];
    if (!user) return null;
    return { ...user, scopes: await scopesFor(tx, user.id) };
  });
}

async function scopesFor(tx: Tx, userId: string): Promise<string[]> {
  const { rows } = await tx.query<{ product_id: string }>(
    `SELECT product_id FROM support_user_scope WHERE support_user_id = $1 ORDER BY product_id`,
    [userId],
  );
  return rows.map((r) => r.product_id);
}

/** All product ids — a super_admin's effective scope. */
export async function allProductIds(): Promise<string[]> {
  return withSystemScope('scope', async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM product WHERE is_active = true ORDER BY id`,
    );
    return rows.map((r) => r.id);
  });
}

export async function recordLoginSuccess(userId: string): Promise<void> {
  await withSystemScope('auth', async (tx) => {
    await tx.query(
      `UPDATE support_user
          SET last_login_at = now(), failed_login_count = 0, locked_until = NULL
        WHERE id = $1`,
      [userId],
    );
  });
}

/**
 * Lock after 10 consecutive failures for 15 minutes — matching the behaviour
 * the seeded "Account locked" KB article describes to end users.
 */
export async function recordLoginFailure(userId: string): Promise<void> {
  await withSystemScope('auth', async (tx) => {
    await tx.query(
      `UPDATE support_user
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= 10
                                  THEN now() + interval '15 minutes'
                                  ELSE locked_until END
        WHERE id = $1`,
      [userId],
    );
  });
}

export async function setPassword(userId: string, hash: string): Promise<void> {
  await withSystemScope('auth', async (tx) => {
    await tx.query(
      `UPDATE support_user
          SET password_hash = $2, must_change_password = false,
              failed_login_count = 0, locked_until = NULL
        WHERE id = $1`,
      [userId, hash],
    );
  });
}

// ── admin management ─────────────────────────────────────────────────────

export interface AdminUserView {
  id: string;
  email: string;
  display_name: string;
  role: SupportRole;
  availability: string;
  is_active: boolean;
  last_login_at: string | null;
  scopes: string[];
  skills: string[];
  open_tickets: number;
}

export async function listUsers(tx: Tx, visibleProducts: string[], isSuper: boolean) {
  const { rows } = await tx.query<{
    id: string;
    email: string;
    display_name: string;
    role: SupportRole;
    availability: string;
    is_active: boolean;
    last_login_at: Date | null;
    scopes: string[] | null;
    skills: string[] | null;
    open_tickets: string;
  }>(
    `SELECT u.id, u.email, u.display_name, u.role, u.availability, u.is_active, u.last_login_at,
            (SELECT array_agg(s.product_id ORDER BY s.product_id)
               FROM support_user_scope s WHERE s.support_user_id = u.id) AS scopes,
            (SELECT array_agg(k.skill ORDER BY k.skill)
               FROM support_user_skill k WHERE k.support_user_id = u.id) AS skills,
            (SELECT count(*) FROM ticket t
              WHERE t.assignee_id = u.id
                AND t.status IN ('assigned','in_progress','waiting_on_raiser')) AS open_tickets
       FROM support_user u
      WHERE u.is_active = true
        -- A non-super admin sees only staff who share at least one of their
        -- tenants, and never platform super admins. They cannot enumerate
        -- another tenant's team.
        AND ($1::boolean
             OR (u.role <> 'super_admin'
                 AND EXISTS (SELECT 1 FROM support_user_scope s
                              WHERE s.support_user_id = u.id
                                AND s.product_id = ANY($2::text[]))))
      ORDER BY u.display_name`,
    [isSuper, visibleProducts],
  );

  return rows.map<AdminUserView>((r) => ({
    id: r.id,
    email: r.email,
    display_name: r.display_name,
    role: r.role,
    availability: r.availability,
    is_active: r.is_active,
    last_login_at: r.last_login_at ? r.last_login_at.toISOString() : null,
    scopes: r.scopes ?? [],
    skills: r.skills ?? [],
    open_tickets: Number(r.open_tickets),
  }));
}

export async function createUser(
  tx: Tx,
  args: {
    email: string;
    displayName: string;
    role: SupportRole;
    passwordHash: string;
    scopes: string[];
    createdBy: string;
  },
): Promise<string> {
  const id = newId('su');
  await tx.query(
    `INSERT INTO support_user (id, email, display_name, role, password_hash, must_change_password)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [id, args.email.toLowerCase(), args.displayName, args.role, args.passwordHash],
  );
  await replaceScopes(tx, id, args.scopes, args.createdBy);
  return id;
}

/** Replaces a user's tenant scopes wholesale — the portal edits them as a set. */
export async function replaceScopes(
  tx: Tx,
  userId: string,
  productIds: string[],
  grantedBy: string,
): Promise<void> {
  await tx.query(`DELETE FROM support_user_scope WHERE support_user_id = $1`, [userId]);
  for (const productId of productIds) {
    await tx.query(
      `INSERT INTO support_user_scope (support_user_id, product_id, granted_by)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, productId, grantedBy],
    );
  }
}

export async function updateUser(
  tx: Tx,
  userId: string,
  patch: { role?: SupportRole; availability?: string; is_active?: boolean; display_name?: string },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return;
  await tx.query(`UPDATE support_user SET ${sets.join(', ')} WHERE id = $1`, params);
}

export { withScope };
