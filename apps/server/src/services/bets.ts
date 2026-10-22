import {
  fromCents,
  RESOLVE_GRACE_DAYS,
  splitPot,
  toCents,
  type Bet,
  type BetInput,
  type Holder,
  type Stake,
} from '@watercooler/shared';
import type { DB } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { DAY } from '../lib/time';
import { settleExchange } from './exchange';
import {
  getMarketRow,
  getOutcomeRows,
  isBettable,
  marketProbabilities,
  recordPriceSnapshot,
  resolveDeadline,
  type MarketRow,
} from './markets';
import { adjustBalance, toUserRef } from './users';

interface BetRow {
  id: number;
  user_id: number;
  market_id: number;
  outcome_id: number;
  amount: number;
  created_at: number;
  username: string;
  display_name: string;
  question: string;
  label: string;
}

const BET_SELECT = `
  SELECT b.*, u.username, u.display_name, m.question, o.label
    FROM bets b
    JOIN users u    ON u.id = b.user_id
    JOIN markets m  ON m.id = b.market_id
    JOIN outcomes o ON o.id = b.outcome_id`;

const toBet = (r: BetRow): Bet => ({
  id: r.id,
  user: toUserRef({ id: r.user_id, username: r.username, display_name: r.display_name }),
  marketId: r.market_id,
  marketQuestion: r.question,
  outcomeId: r.outcome_id,
  outcomeLabel: r.label,
  amount: fromCents(r.amount),
  createdAt: r.created_at,
});

export function getBet(db: DB, id: number): Bet {
  return toBet(db.prepare(`${BET_SELECT} WHERE b.id = ?`).get(id) as BetRow);
}

export function listBets(
  db: DB,
  opts: { marketId?: number; userId?: number; zone?: 'human' | 'ai'; before?: number; limit?: number },
): Bet[] {
  const where: string[] = [];
  const params: unknown[] = [];
  // The AI werewolf games keep their bets to themselves.
  if (opts.zone) where.push(opts.zone === 'ai' ? 'm.is_ai = 1' : 'm.is_ai = 0 AND m.werewolf_game_id IS NULL');
  if (opts.marketId !== undefined) {
    where.push('b.market_id = ?');
    params.push(opts.marketId);
  }
  if (opts.userId !== undefined) {
    where.push('b.user_id = ?');
    params.push(opts.userId);
  }
  if (opts.before !== undefined) {
    where.push('b.id < ?');
    params.push(opts.before);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db
    .prepare(`${BET_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.id DESC LIMIT ${limit}`)
    .all(...params) as BetRow[];
  return rows.map(toBet);
}

export function getUserStakes(db: DB, userId: number, marketId: number): Stake[] {
  const rows = db
    .prepare(
      `SELECT outcome_id, SUM(amount) AS amount FROM bets
        WHERE user_id = ? AND market_id = ? GROUP BY outcome_id ORDER BY outcome_id`,
    )
    .all(userId, marketId) as { outcome_id: number; amount: number }[];
  return rows.map((r) => ({ outcomeId: r.outcome_id, amount: fromCents(r.amount) }));
}

export function listHolders(db: DB, marketId: number, perOutcome = 10): Holder[] {
  const rows = db
    .prepare(
      `SELECT b.user_id, b.outcome_id, SUM(b.amount) AS amount, u.username, u.display_name
         FROM bets b JOIN users u ON u.id = b.user_id
        WHERE b.market_id = ?
        GROUP BY b.user_id, b.outcome_id
        ORDER BY amount DESC`,
    )
    .all(marketId) as {
    user_id: number;
    outcome_id: number;
    amount: number;
    username: string;
    display_name: string;
  }[];
  const counts = new Map<number, number>();
  const holders: Holder[] = [];
  for (const r of rows) {
    const n = counts.get(r.outcome_id) ?? 0;
    if (n >= perOutcome) continue;
    counts.set(r.outcome_id, n + 1);
    holders.push({
      user: toUserRef({ id: r.user_id, username: r.username, display_name: r.display_name }),
      outcomeId: r.outcome_id,
      amount: fromCents(r.amount),
    });
  }
  return holders;
}

/** Put money on an outcome. Returns the new bet id. */
export function placeBet(db: DB, userId: number, marketId: number, input: BetInput, now: number): number {
  return db.transaction(() => {
    const market = getMarketRow(db, marketId);
    if (market.mode !== 'pool') throw badRequest('Polymarket 模式请使用订单交易');
    if (!isBettable(market, now)) throw conflict('该市场已停止下注');
    const bettor = db.prepare('SELECT is_bot FROM users WHERE id = ?').get(userId) as { is_bot: 0 | 1 } | undefined;
    if (bettor?.is_bot && !market.is_ai) throw forbidden('机器人只能在 AI 专区下注');
    const outcomes = getOutcomeRows(db, marketId);
    const outcome = outcomes.find((o) => o.id === input.outcomeId);
    if (!outcome) throw notFound('选项不存在');
    const amount = toCents(input.amount);

    adjustBalance(db, userId, -amount, 'bet', now, { marketId });
    outcome.pool += amount;
    db.prepare('UPDATE outcomes SET pool = ? WHERE id = ?').run(outcome.pool, outcome.id);
    db.prepare('UPDATE markets SET pot = pot + ? WHERE id = ?').run(amount, marketId);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO bets (user_id, market_id, outcome_id, amount, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, marketId, outcome.id, amount, now);
    recordPriceSnapshot(db, marketId, marketProbabilities(market, outcomes), now);
    return Number(lastInsertRowid);
  })();
}

function assertCreator(market: MarketRow, actorId: number): void {
  if (market.creator_id !== actorId) throw forbidden('只有市场创建者可以公布结果或取消市场');
}

function assertUnsettled(market: MarketRow): void {
  if (market.status === 'resolved') throw conflict('该市场已结算');
  if (market.status === 'cancelled') throw conflict('该市场已取消');
}

/** Give every bettor back exactly what they staked. */
function refundAll(db: DB, marketId: number, note: string, now: number): void {
  const stakes = db
    .prepare('SELECT user_id, SUM(amount) AS amount FROM bets WHERE market_id = ? GROUP BY user_id ORDER BY user_id')
    .all(marketId) as { user_id: number; amount: number }[];
  for (const s of stakes) adjustBalance(db, s.user_id, s.amount, 'refund', now, { marketId, note });
}

/**
 * Announce the result: the winners split the whole pot in proportion to their stakes on the
 * winning outcome. If nobody backed it, everyone gets their stake back.
 */
export function resolveMarket(
  db: DB,
  marketId: number,
  outcomeId: number,
  actorId: number,
  note: string | undefined,
  now: number,
): void {
  db.transaction(() => {
    const market = getMarketRow(db, marketId);
    assertCreator(market, actorId);
    assertUnsettled(market);
    // Polymarket traders price in the settlement time, so it binds there; pool creators may
    // announce as soon as the result is known, which also stops betting.
    if (market.mode === 'polymarket' && now < market.settle_at) throw conflict('尚未到结算时间，暂不能公布结果');
    const outcomes = getOutcomeRows(db, marketId);
    if (!outcomes.some((o) => o.id === outcomeId)) throw notFound('选项不存在');

    const winners = db
      .prepare('SELECT user_id, SUM(amount) AS stake FROM bets WHERE outcome_id = ? GROUP BY user_id ORDER BY user_id')
      .all(outcomeId) as { user_id: number; stake: number }[];
    if (market.mode === 'polymarket') {
      settleExchange(db, marketId, outcomeId, now);
    } else if (winners.length === 0) {
      refundAll(db, marketId, '没有人押中，全部退还', now);
    } else {
      const payouts = splitPot(
        market.pot,
        winners.map((w) => w.stake),
      );
      winners.forEach((w, i) => {
        if (payouts[i]! > 0) adjustBalance(db, w.user_id, payouts[i]!, 'payout', now, { marketId });
      });
    }
    db.prepare(
      `UPDATE markets SET status = 'resolved', resolved_outcome_id = ?, resolved_at = ?, resolution_note = ?,
              close_at = MIN(close_at, ?), settle_at = MIN(settle_at, ?) WHERE id = ?`,
    ).run(outcomeId, now, note || null, now, now, marketId);
    recordPriceSnapshot(
      db,
      marketId,
      marketProbabilities({ status: 'resolved', resolved_outcome_id: outcomeId }, outcomes),
      now,
    );
  })();
}

/** Pool markets can be cancelled; Polymarket positions always wait for a result. */
export function cancelMarket(
  db: DB,
  marketId: number,
  actorId: number | null,
  note: string | undefined,
  now: number,
): void {
  db.transaction(() => {
    const market = getMarketRow(db, marketId);
    if (actorId !== null) assertCreator(market, actorId);
    if (market.mode === 'polymarket')
      throw forbidden('Polymarket 市场不可取消，只能等待公布结果结算；未成交订单仍可撤销');
    assertUnsettled(market);
    refundAll(db, marketId, '市场取消，全部退还', now);
    db.prepare(
      `UPDATE markets SET status = 'cancelled', resolved_at = ?, resolution_note = ?,
              close_at = MIN(close_at, ?) WHERE id = ?`,
    ).run(now, note || null, now, marketId);
  })();
}

/** Only pool markets expire; Polymarket collateral and positions wait indefinitely. */
export function cancelOverdueMarkets(db: DB, now: number): void {
  db.transaction(() => {
    const overdue = db
      .prepare(`SELECT * FROM markets WHERE mode = 'pool' AND status = 'open' AND settle_at <= ?`)
      .all(now - RESOLVE_GRACE_DAYS * DAY) as MarketRow[];
    for (const m of overdue) {
      cancelMarket(
        db,
        m.id,
        null,
        `创建者超过 ${RESOLVE_GRACE_DAYS} 天没有公布结果，已自动取消并退款`,
        resolveDeadline(m),
      );
    }
  })();
}
