import { fromCents } from '@watercooler/shared';
import type { DB } from '../db';
import { notFound } from '../lib/http';
import { getMarketRow } from './markets';
import { shareLabel, tokenName, toOrder, type OrderRow } from './exchange';

export interface TradingQuery {
  limit: number;
  before?: number;
  marketId?: number;
  status?: OrderRow['status'];
  clientOrderId?: string;
}

const ORDER_SELECT = `SELECT e.*, o.label, m.neg_risk FROM exchange_orders e
  JOIN outcomes o ON o.id = e.outcome_id JOIN markets m ON m.id = e.market_id`;
type LabeledOrder = OrderRow & { label: string; neg_risk: 0 | 1 };
const tradingOrder = (r: LabeledOrder) => ({
  ...toOrder(r),
  marketId: r.market_id,
  outcomeLabel: shareLabel(r.label, r.token, r.neg_risk === 1),
});

export function ownedOrder(db: DB, userId: number, id: number) {
  const row = db.prepare(`${ORDER_SELECT} WHERE e.user_id = ? AND e.id = ?`).get(userId, id) as
    LabeledOrder | undefined;
  if (!row) throw notFound('订单不存在');
  return tradingOrder(row);
}

function page<T extends { id: number }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export function tradingOrders(db: DB, userId: number, q: TradingQuery) {
  const rows = db
    .prepare(
      `${ORDER_SELECT} WHERE e.user_id = @user AND e.id < @before
    ${q.marketId ? 'AND e.market_id = @market' : ''}
    ${q.status ? 'AND e.status = @status' : ''}
    ${q.clientOrderId ? 'AND e.client_order_id = @client' : ''}
    ORDER BY e.id DESC LIMIT @limit`,
    )
    .all({
      user: userId,
      before: q.before ?? Number.MAX_SAFE_INTEGER,
      market: q.marketId ?? null,
      status: q.status ?? null,
      client: q.clientOrderId ?? null,
      limit: q.limit + 1,
    }) as LabeledOrder[];
  return page(rows.map(tradingOrder), q.limit);
}

/** Report each fill in the requesting user's outcome/side, including complementary trades. */
export function tradingFills(db: DB, userId: number, q: TradingQuery) {
  const rows = db
    .prepare(
      `SELECT t.id, t.market_id, e.id AS order_id, e.outcome_id, e.token, e.side, o.label, m.neg_risk,
    CASE WHEN t.outcome_id = e.outcome_id AND t.token = e.token THEN t.price ELSE 100 - t.price END AS price,
    CASE WHEN e.id = t.maker_id THEN 'maker' ELSE 'taker' END AS role,
    t.quantity, t.kind, t.created_at
    FROM exchange_trades t JOIN exchange_orders e ON e.id = t.maker_id OR e.id = t.taker_id
    JOIN outcomes o ON o.id = e.outcome_id JOIN markets m ON m.id = e.market_id
    WHERE e.user_id = @user AND t.id < @before ${q.marketId ? 'AND t.market_id = @market' : ''}
    ORDER BY t.id DESC LIMIT @limit`,
    )
    .all({
      user: userId,
      before: q.before ?? Number.MAX_SAFE_INTEGER,
      market: q.marketId ?? null,
      limit: q.limit + 1,
    }) as {
    id: number;
    market_id: number;
    order_id: number;
    outcome_id: number;
    token: 0 | 1;
    side: 'buy' | 'sell';
    label: string;
    neg_risk: 0 | 1;
    price: number;
    role: 'maker' | 'taker';
    quantity: number;
    kind: 'transfer' | 'mint' | 'merge';
    created_at: number;
  }[];
  return page(
    rows.map((r) => ({
      id: r.id,
      marketId: r.market_id,
      orderId: r.order_id,
      outcomeId: r.outcome_id,
      token: tokenName(r.token),
      outcomeLabel: shareLabel(r.label, r.token, r.neg_risk === 1),
      side: r.side,
      price: fromCents(r.price),
      amount: fromCents(r.price * r.quantity),
      quantity: r.quantity,
      role: r.role,
      kind: r.kind,
      createdAt: r.created_at,
    })),
    q.limit,
  );
}

export function marketTrades(db: DB, marketId: number, q: TradingQuery) {
  getMarketRow(db, marketId);
  const rows = db
    .prepare(`SELECT * FROM exchange_trades WHERE market_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(marketId, q.before ?? Number.MAX_SAFE_INTEGER, q.limit + 1) as {
    id: number;
    outcome_id: number;
    token: 0 | 1;
    price: number;
    quantity: number;
    kind: string;
    created_at: number;
  }[];
  return page(
    rows.map((r) => ({
      id: r.id,
      marketId,
      outcomeId: r.outcome_id,
      token: tokenName(r.token),
      price: fromCents(r.price),
      quantity: r.quantity,
      kind: r.kind,
      createdAt: r.created_at,
    })),
    q.limit,
  );
}
