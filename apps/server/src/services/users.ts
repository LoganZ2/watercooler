import { fromCents, type LedgerKind, type Me, type PublicUser, type UserRef } from '@watercooler/shared';
import type { Config } from '../config';
import type { DB } from '../db';
import { badRequest, conflict } from '../lib/http';
import { hashPassword } from '../lib/password';
import { localDate } from '../lib/time';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_bot: 0 | 1;
  is_admin: 0 | 1;
  balance: number;
  last_bonus_date: string | null;
  created_at: number;
}

export const toUserRef = (u: Pick<UserRow, 'id' | 'username' | 'display_name'>): UserRef => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
});

export const toPublicUser = (u: UserRow): PublicUser => ({
  ...toUserRef(u),
  createdAt: u.created_at,
  isBot: u.is_bot === 1,
});

export function toMe(u: UserRow, config: Config, now: number): Me {
  return {
    ...toPublicUser(u),
    balance: fromCents(u.balance),
    canClaimBonus: config.dailyBonus > 0 && u.last_bonus_date !== localDate(now, config.timezone),
    isAdmin: u.is_admin === 1,
  };
}

export function getUserById(db: DB, id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByUsername(db: DB, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

/** Usernames with this prefix are reserved for AI bots. */
export const BOT_USERNAME_PREFIX = 'ai_bot_';

export interface LedgerOptions {
  marketId?: number | null;
  note?: string | null;
}

/**
 * Move money in or out of a user's balance and record it in the ledger.
 * Must be called inside a transaction together with whatever caused the change.
 * Returns the new balance in cents.
 */
export function adjustBalance(
  db: DB,
  userId: number,
  amountCents: number,
  kind: LedgerKind,
  now: number,
  opts: LedgerOptions = {},
): number {
  if (!Number.isSafeInteger(amountCents)) throw new Error(`non-integer cents: ${amountCents}`);
  const row = db
    .prepare('UPDATE users SET balance = balance + ? WHERE id = ? AND balance + ? >= 0 RETURNING balance')
    .get(amountCents, userId, amountCents) as { balance: number } | undefined;
  if (!row) throw badRequest('余额不足');
  db.prepare(
    `INSERT INTO ledger (user_id, kind, amount, balance_after, market_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, kind, amountCents, row.balance, opts.marketId ?? null, opts.note ?? null, now);
  return row.balance;
}

export async function createUser(
  db: DB,
  config: Config,
  input: { username: string; displayName: string; password: string },
  now: number,
  opts: { bot?: boolean } = {},
): Promise<UserRow> {
  if (getUserByUsername(db, input.username)) throw conflict('用户名已被占用');
  if (!opts.bot && input.username.toLowerCase().startsWith(BOT_USERNAME_PREFIX)) throw conflict('用户名已被占用');
  const passwordHash = await hashPassword(input.password);
  return db.transaction(() => {
    // Re-check inside the transaction: hashing is async, another request may have won the race.
    if (getUserByUsername(db, input.username)) throw conflict('用户名已被占用');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, display_name, password_hash, is_bot, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.username, input.displayName, passwordHash, opts.bot ? 1 : 0, now);
    const id = Number(lastInsertRowid);
    const starting = Math.round(config.startingBalance * 100);
    if (starting > 0) adjustBalance(db, id, starting, 'signup', now, { note: '注册奖励' });
    return getUserById(db, id)!;
  })();
}

export function claimDailyBonus(db: DB, config: Config, userId: number, now: number): number {
  if (config.dailyBonus <= 0) throw badRequest('每日奖励未开启');
  const today = localDate(now, config.timezone);
  return db.transaction(() => {
    const claimed = db
      .prepare(
        'UPDATE users SET last_bonus_date = ? WHERE id = ? AND (last_bonus_date IS NULL OR last_bonus_date <> ?)',
      )
      .run(today, userId, today);
    if (claimed.changes === 0) throw conflict('今天已经领过了，明天再来');
    return adjustBalance(db, userId, Math.round(config.dailyBonus * 100), 'bonus', now, { note: '每日签到' });
  })();
}
