import {
  FEATURES,
  fromCents,
  toCents,
  type AdminAuditEntry,
  type AdminOverview,
  type AdminUser,
  type Feature,
} from '@watercooler/shared';
import type { DB } from '../db';
import { badRequest, notFound } from '../lib/http';
import { adjustBalance, getUserByUsername, toUserRef, type UserRow } from './users';

const FEATURE_LABEL: Record<Feature, string> = {
  polymarket: 'Polymarket 模式',
  mimic: 'Polymarket 镜像盘',
};

/** The flags alone decide what runs. With no stored flag, Polymarket and its mirror are on. */
export function getFeatureFlags(db: DB): Record<Feature, boolean> {
  const flags: Record<Feature, boolean> = { polymarket: true, mimic: true };
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'feature.%'`).all() as {
    key: string;
    value: string;
  }[];
  for (const r of rows) {
    const key = r.key.slice('feature.'.length) as Feature;
    if (FEATURES.includes(key)) flags[key] = r.value === 'on';
  }
  return flags;
}

/** Features that only run, and can only be switched on, while another one is on. */
export const FEATURE_REQUIRES: Partial<Record<Feature, Feature>> = { mimic: 'polymarket' };

/** Whether a feature is on and so is everything it needs. */
export const featureOn = (flags: Record<Feature, boolean>, key: Feature): boolean =>
  flags[key] && (FEATURE_REQUIRES[key] === undefined || featureOn(flags, FEATURE_REQUIRES[key]));

export function setFeatureFlag(db: DB, adminId: number, key: Feature, enabled: boolean, now: number): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(`feature.${key}`, enabled ? 'on' : 'off', now);
    audit(db, adminId, 'feature', `${enabled ? '开启' : '关闭'}「${FEATURE_LABEL[key]}」`, now);
  })();
}

export function audit(db: DB, adminId: number, action: string, detail: string, now: number): void {
  db.prepare('INSERT INTO admin_audit (admin_id, action, detail, created_at) VALUES (?, ?, ?, ?)').run(
    adminId,
    action,
    detail,
    now,
  );
}

export function listAudit(db: DB, opts: { before?: number; limit?: number } = {}): AdminAuditEntry[] {
  const rows = db
    .prepare(
      `SELECT a.*, u.username, u.display_name FROM admin_audit a JOIN users u ON u.id = a.admin_id
        WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`,
    )
    .all(opts.before ?? Number.MAX_SAFE_INTEGER, Math.min(Math.max(opts.limit ?? 50, 1), 200)) as {
    id: number;
    admin_id: number;
    action: string;
    detail: string;
    created_at: number;
    username: string;
    display_name: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    admin: toUserRef({ id: r.admin_id, username: r.username, display_name: r.display_name }),
    action: r.action,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

const toAdminUser = (u: UserRow): AdminUser => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  balance: fromCents(u.balance),
  isAdmin: u.is_admin === 1,
  createdAt: u.created_at,
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * People (never bots), for the user pickers at /admin. A search matches the username or display
 * name fuzzily: its characters in order, anywhere ("xm" finds xiaoming). Names that start with it
 * come first, then names that contain it, then the rest; admins first when nothing is typed.
 */
export function listUsers(db: DB, search?: string, limit = 200): AdminUser[] {
  const q = search?.trim();
  const matches = (p: string) => `(username LIKE ${p} ESCAPE '\\' OR display_name LIKE ${p} ESCAPE '\\')`;
  const rows = db
    .prepare(
      `SELECT * FROM users WHERE is_bot = 0
        ${q ? `AND ${matches('@fuzzy')}` : ''}
        ORDER BY ${q ? `CASE WHEN ${matches('@prefix')} THEN 0 WHEN ${matches('@contains')} THEN 1 ELSE 2 END,` : ''}
                 is_admin DESC, id
        LIMIT @limit`,
    )
    .all({
      limit: Math.min(Math.max(limit, 1), 200),
      ...(q
        ? {
            fuzzy: `%${[...q].map(escapeLike).join('%')}%`,
            prefix: `${escapeLike(q)}%`,
            contains: `%${escapeLike(q)}%`,
          }
        : {}),
    }) as UserRow[];
  return rows.map(toAdminUser);
}

function findPerson(db: DB, username: string): UserRow {
  const user = getUserByUsername(db, username.trim());
  if (!user || user.is_bot) throw notFound(`找不到用户 ${username}`);
  return user;
}

export function setAdmin(db: DB, actorId: number, username: string, isAdmin: boolean, now: number): AdminUser {
  return db.transaction(() => {
    const user = findPerson(db, username);
    // An admin never removes themselves, so there is always at least one admin left.
    if (!isAdmin && user.id === actorId) throw badRequest('不能取消自己的管理员身份');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, user.id);
    audit(
      db,
      actorId,
      'admin',
      `${isAdmin ? '设为管理员' : '取消管理员'}：${user.display_name}（${user.username}）`,
      now,
    );
    return toAdminUser({ ...user, is_admin: isAdmin ? 1 : 0 });
  })();
}

/** Add (or with a negative amount, take away) 水滴 for one person; it counts as funding, not profit. */
export function adjustUserBalance(
  db: DB,
  actorId: number,
  username: string,
  amount: number,
  reason: string,
  now: number,
): AdminUser {
  return db.transaction(() => {
    const user = findPerson(db, username);
    const balance = adjustBalance(db, user.id, toCents(amount), 'grant', now, { note: reason });
    audit(
      db,
      actorId,
      'balance',
      `${amount > 0 ? '发放' : '扣除'} ${Math.abs(amount)} 水滴：${user.display_name}（${user.username}），原因：${reason}`,
      now,
    );
    return toAdminUser({ ...user, balance });
  })();
}

/** Hand the same amount to every person; returns how many got it. */
export function grantAll(db: DB, actorId: number, amount: number, reason: string, now: number): number {
  return db.transaction(() => {
    const ids = db.prepare('SELECT id FROM users WHERE is_bot = 0').all() as { id: number }[];
    for (const { id } of ids) adjustBalance(db, id, toCents(amount), 'grant', now, { note: reason });
    audit(db, actorId, 'balance', `全员发放 ${amount} 水滴（${ids.length} 人），原因：${reason}`, now);
    return ids.length;
  })();
}

/** Where people's 水滴 are; the same accounting as the leaderboard (see computeAllStats). */
export function moneyOverview(db: DB): AdminOverview['money'] {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE is_bot = 0) AS users,
         (SELECT COALESCE(SUM(balance), 0) FROM users WHERE is_bot = 0) AS balances,
         (SELECT COALESCE(SUM(l.amount), 0) FROM ledger l JOIN users u ON u.id = l.user_id
           WHERE u.is_bot = 0 AND l.kind IN ('signup', 'bonus', 'grant')) AS funded,
         (SELECT COALESCE(-SUM(l.amount), 0) FROM ledger l JOIN users u ON u.id = l.user_id
           JOIN markets m ON m.id = l.market_id WHERE u.is_bot = 0 AND m.status = 'open') AS in_markets`,
    )
    .get() as { users: number; balances: number; funded: number; in_markets: number };
  return {
    users: row.users,
    balances: fromCents(row.balances),
    inMarkets: fromCents(row.in_markets),
    funded: fromCents(row.funded),
  };
}
