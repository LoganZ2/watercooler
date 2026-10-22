import {
  fromCents,
  poolShares,
  type CreateMarketInput,
  type MarketDetail,
  type MarketStatus,
  type MarketSummary,
  type Outcome,
  type PricePoint,
  createMarketSchema,
  MIN_MULTI_OUTCOMES,
  RESOLVE_GRACE_DAYS,
} from '@watercooler/shared';
import { placeholders, type DB } from '../db';
import { badRequest, notFound } from '../lib/http';
import { DAY, MINUTE } from '../lib/time';
import { toUserRef } from './users';

export interface MarketRow {
  mode: 'pool' | 'polymarket';
  id: number;
  question: string;
  description: string;
  category: string;
  creator_id: number;
  status: 'open' | 'resolved' | 'cancelled';
  close_at: number;
  settle_at: number;
  resolved_outcome_id: number | null;
  resolved_at: number | null;
  resolution_note: string | null;
  pot: number;
  is_ai: 0 | 1;
  /** Polymarket with 3+ options: each option has its own Yes/No book (see services/exchange). */
  neg_risk: 0 | 1;
  ai_checked_at: number | null;
  created_at: number;
}

export interface OutcomeRow {
  last_price: number | null;
  mark_price: number;
  id: number;
  market_id: number;
  idx: number;
  label: string;
  pool: number;
}

interface MarketListRow extends MarketRow {
  creator_username: string;
  creator_display_name: string;
  bettor_count: number;
  comment_count: number;
  pot_24h: number;
}

export function derivedStatus(m: Pick<MarketRow, 'status' | 'close_at'>, now: number): MarketStatus {
  return m.status === 'open' && m.close_at <= now ? 'closed' : m.status;
}

/** Betting is allowed only while a market is open and before its close time. */
export function isBettable(m: Pick<MarketRow, 'status' | 'close_at'>, now: number): boolean {
  return derivedStatus(m, now) === 'open';
}

export function resolveDeadline(m: Pick<MarketRow, 'settle_at'>): number {
  return m.settle_at + RESOLVE_GRACE_DAYS * DAY;
}

export function getMarketRow(db: DB, id: number): MarketRow {
  const row = db.prepare('SELECT * FROM markets WHERE id = ?').get(id) as MarketRow | undefined;
  if (!row) throw notFound('市场不存在');
  return row;
}

export function getOutcomeRows(db: DB, marketId: number): OutcomeRow[] {
  return db.prepare('SELECT * FROM outcomes WHERE market_id = ? ORDER BY idx').all(marketId) as OutcomeRow[];
}

/** Each outcome's share of the pot; resolved markets are pinned to 1 for the winner. */
export function marketProbabilities(
  market: Pick<MarketRow, 'status' | 'resolved_outcome_id'> & Partial<Pick<MarketRow, 'mode'>>,
  outcomes: OutcomeRow[],
): number[] {
  if (market.status === 'resolved') return outcomes.map((o) => (o.id === market.resolved_outcome_id ? 1 : 0));
  if (market.mode === 'polymarket') return outcomes.map((o) => o.mark_price / 100);
  return poolShares(outcomes.map((o) => o.pool));
}

const LIST_SELECT = `
  SELECT m.*,
         u.username     AS creator_username,
         u.display_name AS creator_display_name,
         CASE WHEN m.mode = 'polymarket' THEN (SELECT COUNT(DISTINCT p.user_id) FROM exchange_positions p WHERE p.market_id = m.id AND p.quantity > 0)
           ELSE (SELECT COUNT(DISTINCT b.user_id) FROM bets b WHERE b.market_id = m.id) END AS bettor_count,
         (SELECT COUNT(*) FROM comments c WHERE c.market_id = m.id)              AS comment_count,
         CASE WHEN m.mode = 'polymarket' THEN (SELECT COALESCE(SUM(t.price * t.quantity), 0) FROM exchange_trades t WHERE t.market_id = m.id AND t.created_at > @since)
           ELSE (SELECT COALESCE(SUM(b.amount), 0) FROM bets b
           WHERE b.market_id = m.id AND b.created_at > @since) END AS pot_24h
    FROM markets m
    JOIN users u ON u.id = m.creator_id`;

const QUOTE_ORDERS = `e.market_id = o.market_id AND e.status = 'open' AND (e.expires_at IS NULL OR e.expires_at > ?)`;
const YES_SHARE = `(e.outcome_id = o.id AND e.token = 0)`;
const NO_SHARE = `((mk.neg_risk = 1 AND e.outcome_id = o.id AND e.token = 1) OR (mk.neg_risk = 0 AND e.outcome_id <> o.id))`;

/** Hydrate market rows with outcomes, probabilities and 24h change. */
function hydrate(db: DB, rows: MarketListRow[], now: number): MarketSummary[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const outcomeRows = db
    .prepare(
      // Best quotes for each option's Yes share, with the complementary share's orders folded in
      // (the other option in binary markets, the option's No share in multi-outcome ones).
      `SELECT o.*,
        (SELECT MAX(CASE WHEN e.side = 'buy' THEN e.price ELSE 100 - e.price END) FROM exchange_orders e
          WHERE ${QUOTE_ORDERS} AND ((${YES_SHARE} AND e.side = 'buy') OR (${NO_SHARE} AND e.side = 'sell'))) AS best_bid,
        (SELECT MIN(CASE WHEN e.side = 'sell' THEN e.price ELSE 100 - e.price END) FROM exchange_orders e
          WHERE ${QUOTE_ORDERS} AND ((${YES_SHARE} AND e.side = 'sell') OR (${NO_SHARE} AND e.side = 'buy'))) AS best_ask
      FROM outcomes o JOIN markets mk ON mk.id = o.market_id
      WHERE o.market_id IN (${placeholders(ids)}) ORDER BY o.market_id, o.idx`,
    )
    .all(now, now, ...ids) as (OutcomeRow & { best_bid: number | null; best_ask: number | null })[];
  const byMarket = new Map<number, (typeof outcomeRows)[number][]>();
  for (const o of outcomeRows) {
    const list = byMarket.get(o.market_id) ?? [];
    list.push(o);
    byMarket.set(o.market_id, list);
  }

  const prev = snapshotsAt(db, ids, now - DAY);
  const sparkMarkets = rows.filter((r) => r.status === 'open' && byMarket.get(r.id)?.length === 2);
  const sparks = sparklines(db, sparkMarkets, now);

  return rows.map((r) => {
    const outs = byMarket.get(r.id) ?? [];
    const probs = marketProbabilities(r, outs);
    const before = prev.get(r.id);
    const outcomes: Outcome[] = outs.map((o, i) => ({
      id: o.id,
      index: o.idx,
      label: o.label,
      pool: fromCents(o.pool),
      probability: probs[i] ?? 0,
      change24h: before?.[i] !== undefined && r.status === 'open' ? (probs[i] ?? 0) - before[i]! : null,
      ...(r.mode === 'polymarket'
        ? {
            bestBid: isBettable(r, now) && o.best_bid !== null ? fromCents(o.best_bid) : null,
            bestAsk: isBettable(r, now) && o.best_ask !== null ? fromCents(o.best_ask) : null,
          }
        : {}),
    }));
    return {
      mode: r.mode,
      id: r.id,
      question: r.question,
      category: r.category,
      status: derivedStatus(r, now),
      isBinary: outcomes.length === 2,
      isAi: r.is_ai === 1,
      pot: fromCents(r.pot),
      closeAt: r.close_at,
      settleAt: r.settle_at,
      createdAt: r.created_at,
      resolvedOutcomeId: r.resolved_outcome_id,
      bettorCount: r.bettor_count,
      commentCount: r.comment_count,
      creator: toUserRef({ id: r.creator_id, username: r.creator_username, display_name: r.creator_display_name }),
      outcomes,
      spark: sparks.get(r.id) ?? [],
    };
  });
}

/** Latest probability snapshot at or before `t`, per market. */
function snapshotsAt(db: DB, ids: number[], t: number): Map<number, number[]> {
  const rows = db
    .prepare(
      `SELECT market_id, probs FROM price_history WHERE id IN (
         SELECT MAX(id) FROM price_history
          WHERE market_id IN (${placeholders(ids)}) AND created_at <= ?
          GROUP BY market_id)`,
    )
    .all(...ids, t) as { market_id: number; probs: string }[];
  return new Map(rows.map((r) => [r.market_id, JSON.parse(r.probs) as number[]]));
}

const SPARK_WINDOW = 7 * DAY;
const SPARK_POINTS = 32;

/** First-outcome probability sampled at evenly spaced times over the last week. */
function sparklines(
  db: DB,
  markets: Pick<MarketRow, 'id' | 'created_at' | 'close_at'>[],
  now: number,
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  if (markets.length === 0) return result;
  const ids = markets.map((m) => m.id);
  const since = now - SPARK_WINDOW;
  const before = snapshotsAt(db, ids, since);
  const rows = db
    .prepare(
      `SELECT market_id, probs, created_at FROM price_history
        WHERE market_id IN (${placeholders(ids)}) AND created_at > ? ORDER BY id`,
    )
    .all(...ids, since) as { market_id: number; probs: string; created_at: number }[];
  const series = new Map<number, { t: number; p: number }[]>();
  for (const r of rows) {
    const list = series.get(r.market_id) ?? [];
    list.push({ t: r.created_at, p: (JSON.parse(r.probs) as number[])[0] ?? 0 });
    series.set(r.market_id, list);
  }
  for (const m of markets) {
    const points = series.get(m.id) ?? [];
    const start = Math.max(m.created_at, since);
    const end = Math.min(now, m.close_at);
    let value = before.get(m.id)?.[0] ?? points[0]?.p ?? 0.5;
    let j = 0;
    const out: number[] = [];
    for (let k = 0; k < SPARK_POINTS; k++) {
      const t = start + ((end - start) * k) / (SPARK_POINTS - 1);
      while (j < points.length && points[j]!.t <= t) value = points[j++]!.p;
      out.push(Math.round(value * 1000) / 1000);
    }
    result.set(m.id, out);
  }
  return result;
}

export type MarketFilter = 'active' | 'closed' | 'resolved' | 'all';
export type MarketSort = 'trending' | 'pot' | 'new' | 'closing';
/** People's markets, the AI zone, or both. */
export type MarketZone = 'human' | 'ai' | 'any';

export interface ListMarketsOptions {
  mode?: 'pool' | 'polymarket';
  filter?: MarketFilter;
  zone?: MarketZone;
  sort?: MarketSort;
  category?: string;
  search?: string;
  creatorId?: number;
  limit?: number;
}

export function listMarkets(db: DB, now: number, opts: ListMarketsOptions = {}): MarketSummary[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { now, since: now - DAY };
  if (opts.mode) {
    where.push('m.mode = @mode');
    params.mode = opts.mode;
  }
  switch (opts.filter ?? 'active') {
    case 'active':
      where.push(`m.status = 'open' AND m.close_at > @now`);
      break;
    case 'closed':
      where.push(`m.status = 'open' AND m.close_at <= @now`);
      break;
    case 'resolved':
      where.push(`m.status IN ('resolved', 'cancelled')`);
      break;
    case 'all':
      break;
  }
  if (opts.zone === 'human') where.push('m.is_ai = 0');
  if (opts.zone === 'ai') where.push('m.is_ai = 1');
  if (opts.category) {
    where.push('m.category = @category');
    params.category = opts.category;
  }
  if (opts.search) {
    where.push(`(m.question LIKE @search ESCAPE '\\' OR m.description LIKE @search ESCAPE '\\')`);
    params.search = `%${opts.search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  }
  if (opts.creatorId !== undefined) {
    where.push('m.creator_id = @creatorId');
    params.creatorId = opts.creatorId;
  }
  const order = {
    trending: 'pot_24h DESC, m.pot DESC, m.id DESC',
    pot: 'm.pot DESC, m.id DESC',
    new: 'm.id DESC',
    closing: 'm.close_at ASC, m.id DESC',
  }[opts.sort ?? 'trending'];
  params.limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);

  const rows = db
    .prepare(`${LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT @limit`)
    .all(params) as MarketListRow[];
  return hydrate(db, rows, now);
}

export function getMarketSummary(db: DB, id: number, now: number): MarketSummary {
  const row = db.prepare(`${LIST_SELECT} WHERE m.id = @id`).get({ id, since: now - DAY }) as MarketListRow | undefined;
  if (!row) throw notFound('市场不存在');
  return hydrate(db, [row], now)[0]!;
}

export function getMarketDetail(db: DB, id: number, now: number): MarketDetail {
  const summary = getMarketSummary(db, id, now);
  const row = getMarketRow(db, id);
  return {
    ...summary,
    description: row.description,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    ...(row.mode === 'pool' ? { resolveBy: resolveDeadline(row) } : {}),
  };
}

export function recordPriceSnapshot(db: DB, marketId: number, probs: number[], now: number): void {
  const rounded = probs.map((p) => Math.round(p * 1e6) / 1e6);
  db.prepare('INSERT INTO price_history (market_id, probs, created_at) VALUES (?, ?, ?)').run(
    marketId,
    JSON.stringify(rounded),
    now,
  );
}

export function createMarket(
  db: DB,
  creatorId: number,
  input: CreateMarketInput,
  now: number,
  opts: { ai?: boolean } = {},
): number {
  if (!createMarketSchema.safeParse(input).success) throw badRequest('市场配置无效');
  if (input.closeAt <= now + 5 * MINUTE) throw badRequest('截止时间至少要在 5 分钟之后');
  if (input.closeAt > now + 5 * 365 * DAY) throw badRequest('截止时间不能超过 5 年');
  const settleAt = input.settleAt ?? input.closeAt;
  const multi = input.mode === 'polymarket' && input.outcomes.length >= MIN_MULTI_OUTCOMES;
  if (settleAt > now + 5 * 365 * DAY) throw badRequest('结算时间不能超过 5 年');
  return db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO markets (question, description, category, creator_id, close_at, created_at, mode, settle_at, is_ai, neg_risk)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.question,
        input.description ?? '',
        input.category,
        creatorId,
        input.closeAt,
        now,
        input.mode ?? 'pool',
        settleAt,
        opts.ai ? 1 : 0,
        multi ? 1 : 0,
      );
    const marketId = Number(lastInsertRowid);
    // Until anyone trades, every option of a multi-outcome market shows an even 1/N.
    const insertOutcome = db.prepare('INSERT INTO outcomes (market_id, idx, label, mark_price) VALUES (?, ?, ?, ?)');
    input.outcomes.forEach((label, i) =>
      insertOutcome.run(marketId, i, label, multi ? 100 / input.outcomes.length : 50),
    );
    recordPriceSnapshot(db, marketId, poolShares(input.outcomes.map(() => 0)), now);
    return marketId;
  })();
}

export function aiMarketsExist(db: DB): boolean {
  return db.prepare('SELECT 1 FROM markets WHERE is_ai = 1 LIMIT 1').get() !== undefined;
}

export type HistoryRange = '1d' | '1w' | '1m' | 'all';

/** Probability history, downsampled to at most `maxPoints` and always ending at `now`. */
export function getPriceHistory(
  db: DB,
  marketId: number,
  range: HistoryRange,
  now: number,
  maxPoints = 300,
): PricePoint[] {
  const market = getMarketRow(db, marketId);
  const since = { '1d': now - DAY, '1w': now - 7 * DAY, '1m': now - 30 * DAY, all: 0 }[range];
  const rows = db
    .prepare('SELECT probs, created_at FROM price_history WHERE market_id = ? AND created_at >= ? ORDER BY id')
    .all(marketId, since) as { probs: string; created_at: number }[];
  // Carry in the last value before the window so the line starts at the left edge.
  const before = db
    .prepare('SELECT probs FROM price_history WHERE market_id = ? AND created_at < ? ORDER BY id DESC LIMIT 1')
    .get(marketId, since) as { probs: string } | undefined;

  let points: PricePoint[] = rows.map((r) => ({ t: r.created_at, probs: JSON.parse(r.probs) as number[] }));
  if (before) points.unshift({ t: since, probs: JSON.parse(before.probs) as number[] });

  if (points.length > maxPoints) {
    // Keep the last point of each time bucket.
    const start = points[0]!.t;
    const span = Math.max(points[points.length - 1]!.t - start, 1);
    const buckets = new Map<number, PricePoint>();
    for (const p of points) buckets.set(Math.floor(((p.t - start) / span) * (maxPoints - 1)), p);
    points = [...buckets.values()];
  }

  const last = points[points.length - 1];
  const end = market.status === 'open' ? Math.min(now, market.close_at) : (market.resolved_at ?? now);
  if (last && last.t < end) points.push({ t: end, probs: last.probs });
  return points;
}
