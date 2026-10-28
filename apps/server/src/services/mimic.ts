import {
  fromCents,
  mimicOrderSchema,
  planFill,
  type BookLevel,
  type ExchangeActivity,
  type ExchangeOrder,
  type ExchangeState,
  type MimicOrderInput,
  type Token,
} from '@watercooler/shared';
import type { DB } from '../db';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/http';
import type { PolymarketBook, PolymarketClient } from '../mimic/client';
import type { MimicOutcomeRow } from '../mimic/sync';
import { featureOn, getFeatureFlags } from './admin';
import { available, position, shareLabel, takeShares, tokenName, userPositions, type Share } from './exchange';
import { getMarketRow, getOutcomeRows, isBettable, type MarketRow } from './markets';
import { adjustBalance, toUserRef } from './users';

/**
 * Trading Polymarket mirrors (mimic/sync.ts copies them): people buy and sell against the site at
 * Polymarket's live order book, walked like a market order, so their trades never move it. Shares
 * are whole and prices whole cents, rounded against the trader; nothing rests on a book.
 */

export function mirrorMarket(db: DB, marketId: number): MarketRow {
  const m = getMarketRow(db, marketId);
  if (!m.mimic_id) throw badRequest('这不是 Polymarket 镜像盘');
  return m;
}

export interface MirrorShare extends Share {
  option: MimicOutcomeRow;
  /** The Polymarket CLOB token whose book prices this share. */
  tokenId: string;
  label: string;
}

/** An option plus yes/no as a mirrored share: binary mirrors trade their two outcomes directly. */
export function mirrorShare(db: DB, market: MarketRow, outcomeId: number, token: Token = 'yes'): MirrorShare {
  const outcomes = getOutcomeRows(db, market.id) as MimicOutcomeRow[];
  const o = outcomes.find((x) => x.id === outcomeId);
  if (!o) throw notFound('选项不存在');
  if (market.neg_risk) {
    const t = token === 'no' ? 1 : 0;
    return {
      outcome: o.id,
      token: t,
      option: o,
      tokenId: (t ? o.mimic_no_token : o.mimic_yes_token)!,
      label: shareLabel(o.label, t, true),
    };
  }
  const target = token === 'no' ? outcomes.find((x) => x.id !== o.id)! : o;
  return { outcome: target.id, token: 0, option: target, tokenId: target.mimic_yes_token!, label: target.label };
}

export interface MirrorLevels {
  bids: BookLevel[];
  asks: BookLevel[];
}

/** Polymarket's book in this site's units: asks rounded up and bids down to whole cents, whole shares. */
export function toLevels(book: PolymarketBook): MirrorLevels {
  const group = (levels: PolymarketBook['bids'], round: (cents: number) => number, desc: boolean) => {
    const sizes = new Map<number, number>();
    for (const l of levels) {
      const c = round(l.price * 100);
      if (c >= 1 && c <= 99) sizes.set(c, (sizes.get(c) ?? 0) + l.size);
    }
    return [...sizes]
      .map(([c, size]) => ({ price: c / 100, quantity: Math.floor(size) }))
      .filter((l) => l.quantity > 0)
      .sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  };
  return {
    bids: group(book.bids, (c) => Math.floor(c + 1e-9), true),
    asks: group(book.asks, (c) => Math.ceil(c - 1e-9), false),
  };
}

const books = new WeakMap<PolymarketClient, Map<string, { at: number; levels: MirrorLevels }>>();

/** A share's live book, reusing one fetched within `maxAge` ms (0 for a trade). */
export async function mirrorBook(client: PolymarketClient, tokenId: string, maxAge: number): Promise<MirrorLevels> {
  let cache = books.get(client);
  if (!cache) books.set(client, (cache = new Map()));
  const hit = cache.get(tokenId);
  if (hit && Date.now() - hit.at <= maxAge) return hit.levels;
  try {
    const levels = toLevels(await client.book(tokenId));
    cache.set(tokenId, { at: Date.now(), levels });
    return levels;
  } catch {
    throw new HttpError(502, '暂时连不上 Polymarket，稍后再试');
  }
}

export interface MirrorTrade {
  side: 'buy' | 'sell';
  label: string;
  quantity: number;
  total: number;
  avgPrice: number;
}

const tradable = (s: MirrorShare) => s.option.mimic_open === 1 && s.option.mimic_final === null;

/** Fill a market order against `levels` (the share's live Polymarket book), with the site as counterparty. */
export function tradeMirror(
  db: DB,
  userId: number,
  marketId: number,
  input: MimicOrderInput,
  levels: MirrorLevels,
  now: number,
): MirrorTrade {
  const parsed = mimicOrderSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '订单无效');
  return db.transaction(() => {
    const market = mirrorMarket(db, marketId);
    if (!featureOn(getFeatureFlags(db), 'mimic')) throw forbidden('管理员已关闭 Polymarket 镜像盘');
    if (!isBettable(market, now)) throw conflict('交易已截止');
    const user = db.prepare('SELECT is_bot FROM users WHERE id = ?').get(userId) as { is_bot: number } | undefined;
    if (user?.is_bot) throw forbidden('机器人不能交易镜像盘');
    const s = mirrorShare(db, market, input.outcomeId, input.token);
    if (!tradable(s)) throw conflict('这个选项在 Polymarket 上已经停止交易');
    const buy = input.side === 'buy';
    if (!buy && available(db, userId, s) < input.quantity!) throw badRequest('可用份额不足');
    const plan = planFill(
      buy ? levels.asks : levels.bids,
      input.side,
      input.amount !== undefined ? { amount: input.amount } : { quantity: input.quantity! },
      input.price ?? (buy ? 0.99 : 0.01),
    );
    if (plan.quantity === 0) throw conflict('Polymarket 盘口上现在没有可成交的报价');
    if (input.type === 'FOK' && !plan.complete) throw conflict('Polymarket 盘口不够，FOK 订单不能全部成交，已取消');
    const total = Math.round(plan.total * 100);
    const note = `${buy ? '买入' : '卖出'} ${s.label} ${plan.quantity} 份`;
    if (buy) {
      adjustBalance(db, userId, -total, 'buy', now, { marketId, note });
      position(db, userId, marketId, s, plan.quantity, 0, total);
    } else {
      takeShares(db, userId, marketId, s, plan.quantity, false);
      adjustBalance(db, userId, total, 'sell', now, { marketId, note });
    }
    db.prepare(
      `INSERT INTO mimic_trades (market_id, outcome_id, token, user_id, side, quantity, total, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(marketId, s.outcome, s.token, userId, input.side, plan.quantity, total, now);
    return { side: input.side, label: s.label, quantity: plan.quantity, total: plan.total, avgPrice: plan.avgPrice! };
  })();
}

interface TradeRow {
  id: number;
  outcome_id: number;
  token: 0 | 1;
  user_id: number;
  side: 'buy' | 'sell';
  quantity: number;
  total: number;
  created_at: number;
}

const avg = (t: TradeRow) => Math.round((t.total / t.quantity) * 10) / 1000;

/**
 * The order-book view of a mirror for the market page: live books of one option's shares (both
 * outcomes of a binary mirror), the viewer's positions, and trades shown as filled market orders.
 */
export async function mirrorState(
  db: DB,
  client: PolymarketClient,
  marketId: number,
  userId: number | undefined,
  outcomeId?: number,
): Promise<ExchangeState> {
  const market = mirrorMarket(db, marketId);
  const outcomes = getOutcomeRows(db, marketId);
  const focus = outcomes.find((o) => o.id === outcomeId) ?? outcomes[0]!;
  const shares = market.neg_risk
    ? [mirrorShare(db, market, focus.id, 'yes'), mirrorShare(db, market, focus.id, 'no')]
    : outcomes.map((o) => mirrorShare(db, market, o.id));
  const books = await Promise.all(
    shares.map(async (s) => ({
      outcomeId: s.outcome,
      token: tokenName(s.token),
      ...(market.status === 'open' && tradable(s)
        ? await mirrorBook(client, s.tokenId, 10_000)
        : { bids: [], asks: [] }),
      lastPrice: null,
    })),
  );
  const trades = db
    .prepare('SELECT * FROM mimic_trades WHERE market_id = ? ORDER BY id DESC LIMIT 50')
    .all(marketId) as TradeRow[];
  const mine = userId
    ? (db
        .prepare('SELECT * FROM mimic_trades WHERE market_id = ? AND user_id = ? ORDER BY id DESC LIMIT 100')
        .all(marketId, userId) as TradeRow[])
    : [];
  return {
    collateral: 0,
    books,
    positions: userId ? userPositions(db, marketId, userId) : [],
    orders: mine.map((t): ExchangeOrder => ({
      postOnly: false,
      clientOrderId: null,
      id: t.id,
      outcomeId: t.outcome_id,
      token: tokenName(t.token),
      side: t.side,
      type: 'FAK',
      price: avg(t),
      quantity: t.quantity,
      remaining: 0,
      amount: null,
      expiresAt: null,
      status: 'filled',
      createdAt: t.created_at,
    })),
    trades: trades.map((t) => ({
      id: t.id,
      outcomeId: t.outcome_id,
      token: tokenName(t.token),
      price: avg(t),
      quantity: t.quantity,
      kind: 'transfer' as const,
      createdAt: t.created_at,
    })),
  };
}

/** Who bought and sold what in a mirror, newest first; `before` pages by trade id. */
export function mirrorActivity(
  db: DB,
  marketId: number,
  opts: { before?: number; limit?: number } = {},
): ExchangeActivity[] {
  mirrorMarket(db, marketId);
  const rows = db
    .prepare(
      `SELECT t.*, u.username, u.display_name FROM mimic_trades t JOIN users u ON u.id = t.user_id
      WHERE t.market_id = ? AND t.id < ? ORDER BY t.id DESC LIMIT ?`,
    )
    .all(
      marketId,
      opts.before ?? Number.MAX_SAFE_INTEGER,
      Math.min(Math.max(opts.limit ?? 50, 1), 200),
    ) as (TradeRow & {
    username: string;
    display_name: string;
  })[];
  return rows.map((t) => ({
    tradeId: t.id,
    user: toUserRef({ id: t.user_id, username: t.username, display_name: t.display_name }),
    side: t.side,
    outcomeId: t.outcome_id,
    token: tokenName(t.token),
    price: avg(t),
    quantity: t.quantity,
    createdAt: t.created_at,
  }));
}

/** Fetch the share's live book and trade it: what the market page calls. */
export async function placeMirrorOrder(
  db: DB,
  client: PolymarketClient,
  userId: number,
  marketId: number,
  input: MimicOrderInput,
  now: () => number,
): Promise<MirrorTrade & { balance: number }> {
  const parsed = mimicOrderSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '订单无效');
  const market = mirrorMarket(db, marketId);
  const s = mirrorShare(db, market, input.outcomeId, input.token);
  const levels = await mirrorBook(client, s.tokenId, 0);
  const trade = tradeMirror(db, userId, marketId, input, levels, now());
  const { balance } = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance: number };
  return { ...trade, balance: fromCents(balance) };
}
