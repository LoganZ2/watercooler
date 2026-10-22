import {
  convertSchema,
  fromCents,
  orderSchema,
  planFill,
  shareAmountSchema,
  toCents,
  type BookLevel,
  type ExchangeActivity,
  type ExchangeBook,
  type ExchangeHolder,
  type ExchangeOrder,
  type ExchangePortfolioOrder,
  type ExchangePortfolioPosition,
  type ExchangePosition,
  type ExchangeState,
  type FillPlan,
  type OrderInput,
  type OrderType,
  type Token,
} from '@watercooler/shared';
import type { DB } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../lib/http';
import { MINUTE } from '../lib/time';
import {
  derivedStatus,
  getMarketRow,
  getOutcomeRows,
  isBettable,
  recordPriceSnapshot,
  type MarketRow,
  type OutcomeRow,
} from './markets';
import { adjustBalance, toUserRef } from './users';

export interface OrderRow {
  post_only: number;
  client_order_id: string | null;
  id: number;
  user_id: number;
  market_id: number;
  outcome_id: number;
  token: 0 | 1;
  side: 'buy' | 'sell';
  order_type: OrderType;
  price: number;
  quantity: number;
  remaining: number;
  amount: number | null;
  expires_at: number | null;
  status: 'open' | 'filled' | 'cancelled';
  created_at: number;
}

/**
 * A tradable share: an option's Yes (token 0) or No (token 1). Binary markets only use token 0 of
 * their Yes and No options; multi-outcome (neg-risk) markets give every option both.
 */
export interface Share {
  outcome: number;
  token: 0 | 1;
}

/** A Polymarket market with its options, and whether every option has its own Yes/No pair. */
export interface Shares {
  market: MarketRow;
  outcomes: OutcomeRow[];
  multi: boolean;
}

export const tokenName = (token: 0 | 1): Token => (token === 1 ? 'no' : 'yes');

/** "选项" for binary markets, "选项 · Yes/No" for multi-outcome ones. */
export const shareLabel = (label: string, token: 0 | 1, multi: boolean) =>
  multi ? `${label} · ${token === 1 ? 'No' : 'Yes'}` : label;

function sharesOf(db: DB, market: MarketRow): Shares {
  return { market, outcomes: getOutcomeRows(db, market.id), multi: market.neg_risk === 1 };
}

/** Every share of the market, in book order. */
function allShares(sh: Shares): Share[] {
  return sh.outcomes.flatMap((o) =>
    sh.multi
      ? [
          { outcome: o.id, token: 0 as const },
          { outcome: o.id, token: 1 as const },
        ]
      : [{ outcome: o.id, token: 0 as const }],
  );
}

/** The share that pays exactly when `s` does not: the other option, or the option's other side. */
function complement(sh: Shares, s: Share): Share {
  if (sh.multi) return { outcome: s.outcome, token: s.token === 0 ? 1 : 0 };
  return { outcome: sh.outcomes.find((o) => o.id !== s.outcome)!.id, token: 0 };
}

/** An option plus yes/no as a stored share; in binary markets "Yes option, no" is the No option. */
function resolveShare(sh: Shares, outcomeId: number, token: Token = 'yes'): Share {
  if (!sh.outcomes.some((o) => o.id === outcomeId)) throw notFound('选项不存在');
  const yes: Share = { outcome: outcomeId, token: 0 };
  if (token === 'yes') return yes;
  return sh.multi ? { outcome: outcomeId, token: 1 } : complement(sh, yes);
}

/** An option + yes/no as the share it names (in binary markets "Yes, no" is the No option), with its label. */
export function describeShare(db: DB, marketId: number, outcomeId: number, token: Token = 'yes') {
  const sh = sharesOf(db, exchangeMarket(db, marketId));
  const s = resolveShare(sh, outcomeId, token);
  const o = sh.outcomes.find((x) => x.id === s.outcome)!;
  return {
    outcomeId: s.outcome,
    token: tokenName(s.token),
    label: shareLabel(o.label, s.token, sh.multi),
    multi: sh.multi,
  };
}

function exchangeMarket(db: DB, marketId: number, now?: number, userId?: number) {
  const m = getMarketRow(db, marketId);
  if (m.mode !== 'polymarket') throw badRequest('此市场不是 Polymarket 模式');
  if (now !== undefined && !isBettable(m, now)) throw conflict('交易已截止');
  if (userId !== undefined && !m.is_ai) {
    const user = db.prepare('SELECT is_bot FROM users WHERE id = ?').get(userId) as { is_bot: number } | undefined;
    if (user?.is_bot) throw forbidden('机器人只能在 AI 专区交易');
  }
  return m;
}

/** Open orders that have not passed their GTD expiry (expired ones are released by the sweep). */
const LIVE = `status = 'open' AND (expires_at IS NULL OR expires_at > @now)`;

function position(db: DB, userId: number, marketId: number, s: Share, quantity: number, reserved = 0, cost = 0) {
  db.prepare(
    `INSERT INTO exchange_positions (user_id, market_id, outcome_id, token) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, outcome_id, token) DO NOTHING`,
  ).run(userId, marketId, s.outcome, s.token);
  db.prepare(
    `UPDATE exchange_positions SET quantity = quantity + ?, reserved = reserved + ?, cost = cost + ?
    WHERE user_id = ? AND outcome_id = ? AND token = ?`,
  ).run(quantity, reserved, cost, userId, s.outcome, s.token);
}

/** Remove shares at their average cost; returns the cost basis taken out. */
function takeShares(db: DB, userId: number, marketId: number, s: Share, quantity: number, reserved: boolean): number {
  const row = db
    .prepare('SELECT quantity, cost FROM exchange_positions WHERE user_id = ? AND outcome_id = ? AND token = ?')
    .get(userId, s.outcome, s.token) as { quantity: number; cost: number } | undefined;
  const removed = row?.quantity ? Math.round((row.cost * quantity) / row.quantity) : 0;
  position(db, userId, marketId, s, -quantity, reserved ? -quantity : 0, -removed);
  return removed;
}

function available(db: DB, userId: number, s: Share): number {
  return (
    (
      db
        .prepare(
          'SELECT quantity - reserved AS n FROM exchange_positions WHERE user_id = ? AND outcome_id = ? AND token = ?',
        )
        .get(userId, s.outcome, s.token) as { n: number } | undefined
    )?.n ?? 0
  );
}

/** Split 1 into a complete set, or merge a complete set back into 1. */
export function splitMerge(
  db: DB,
  userId: number,
  marketId: number,
  quantity: number,
  action: 'split' | 'merge',
  now: number,
  outcomeId?: number,
) {
  if (!shareAmountSchema.safeParse({ quantity }).success) throw badRequest('份额必须为 1–1000000 的整数');
  db.transaction(() => {
    const sh = sharesOf(db, exchangeMarket(db, marketId, now, userId));
    if (sh.multi && outcomeId === undefined) throw badRequest('多选项市场要指定拆分 / 合并哪个选项的 Yes 和 No');
    const set: Share[] = sh.multi
      ? [resolveShare(sh, outcomeId!, 'yes'), resolveShare(sh, outcomeId!, 'no')]
      : sh.outcomes.map((o) => ({ outcome: o.id, token: 0 as const }));
    if (action === 'merge' && set.some((s) => available(db, userId, s) < quantity))
      throw badRequest('可用 Yes / No 份额不足');
    const delta = action === 'split' ? quantity : -quantity;
    adjustBalance(db, userId, -delta * 100, action, now, { marketId });
    // A complete set costs 1; each of its two shares carries half of that as cost basis.
    for (const s of set) {
      if (action === 'split') position(db, userId, marketId, s, quantity, 0, 50 * quantity);
      else takeShares(db, userId, marketId, s, quantity, false);
    }
    db.prepare('UPDATE markets SET pot = pot + ? WHERE id = ?').run(delta * 100, marketId);
  })();
}

/**
 * Multi-outcome markets: turn No shares of k options into k−1 cash and one Yes share of every other
 * option, per unit. Exactly one option wins, so both sides pay the same in every outcome.
 */
export function convertShares(
  db: DB,
  userId: number,
  marketId: number,
  outcomeIds: number[],
  quantity: number,
  now: number,
) {
  if (!convertSchema.safeParse({ outcomeIds, quantity }).success) throw badRequest('转换的选项或份数无效');
  db.transaction(() => {
    const sh = sharesOf(db, exchangeMarket(db, marketId, now, userId));
    if (!sh.multi) throw badRequest('只有多选项市场可以转换 No 份额');
    const chosen = new Set(outcomeIds);
    const nos = [...chosen].map((id) => resolveShare(sh, id, 'no'));
    if (nos.some((s) => available(db, userId, s) < quantity)) throw badRequest('可用 No 份额不足');
    let basis = 0;
    for (const s of nos) basis += takeShares(db, userId, marketId, s, quantity, false);
    const cash = (chosen.size - 1) * quantity * 100;
    if (cash) {
      adjustBalance(db, userId, cash, 'merge', now, { marketId, note: '转换 No 份额' });
      db.prepare('UPDATE markets SET pot = pot - ? WHERE id = ?').run(cash, marketId);
    }
    const others = sh.outcomes.filter((o) => !chosen.has(o.id));
    const carried = Math.max(basis - cash, 0);
    others.forEach((o, i) => {
      const share = Math.floor(carried / others.length) + (i < carried % others.length ? 1 : 0);
      position(db, userId, marketId, { outcome: o.id, token: 0 }, quantity, 0, share);
    });
  })();
}

export const toOrder = (o: OrderRow): ExchangeOrder => ({
  postOnly: o.post_only === 1,
  clientOrderId: o.client_order_id,
  id: o.id,
  outcomeId: o.outcome_id,
  token: tokenName(o.token),
  side: o.side,
  type: o.order_type,
  price: fromCents(o.price),
  quantity: o.quantity,
  remaining: o.remaining,
  amount: o.amount === null ? null : fromCents(o.amount),
  expiresAt: o.expires_at,
  status: o.status,
  createdAt: o.created_at,
});

const orderShare = (o: Pick<OrderRow, 'outcome_id' | 'token'>): Share => ({ outcome: o.outcome_id, token: o.token });

/** Only GTC/GTD orders rest, and a resting buy always escrows its limit price. */
function releaseOrder(db: DB, o: OrderRow, now: number, note = `撤销订单 #${o.id}`) {
  if (o.side === 'buy') {
    adjustBalance(db, o.user_id, o.price * o.remaining, 'order_release', now, { marketId: o.market_id, note });
  } else {
    position(db, o.user_id, o.market_id, orderShare(o), 0, -o.remaining);
  }
  db.prepare("UPDATE exchange_orders SET status = 'cancelled' WHERE id = ?").run(o.id);
}

/**
 * Resting liquidity for one share, merged the way Polymarket shows it: `side` buy gives the bids
 * (buys of the share plus sells of its complement at 1 − p), sell gives the asks.
 */
function levels(db: DB, sh: Shares, s: Share, side: 'buy' | 'sell', now: number, excludeUser = 0): BookLevel[] {
  const c = complement(sh, s);
  const rows = db
    .prepare(
      `SELECT CASE WHEN outcome_id = @o AND token = @t THEN price ELSE 100 - price END AS level, SUM(remaining) AS quantity
    FROM exchange_orders WHERE market_id = @market AND ${LIVE} AND user_id <> @exclude AND
    ((outcome_id = @o AND token = @t AND side = @side) OR (outcome_id = @co AND token = @ct AND side <> @side))
    GROUP BY level ORDER BY level ${side === 'buy' ? 'DESC' : 'ASC'}`,
    )
    .all({
      market: sh.market.id,
      now,
      exclude: excludeUser,
      o: s.outcome,
      t: s.token,
      co: c.outcome,
      ct: c.token,
      side,
    }) as { level: number; quantity: number }[];
  return rows.map((r) => ({ price: fromCents(r.level), quantity: r.quantity }));
}

/** An option's Yes price as of its last trade, in cents. */
function lastPrice(sh: Shares, s: Share): number | null {
  const o = sh.outcomes.find((x) => x.id === s.outcome)!;
  if (o.last_price === null) return null;
  return s.token === 0 ? o.last_price : 100 - o.last_price;
}

/** Displayed price: the midpoint, or the last trade when the spread is wider than 0.10. */
function refreshPrices(db: DB, marketId: number, now: number) {
  const sh = sharesOf(db, getMarketRow(db, marketId));
  const fallback = sh.multi ? 100 / sh.outcomes.length : 50;
  const probs = sh.outcomes.map((o) => {
    const yes: Share = { outcome: o.id, token: 0 };
    const bid = levels(db, sh, yes, 'buy', now)[0]?.price;
    const ask = levels(db, sh, yes, 'sell', now)[0]?.price;
    const cents =
      bid !== undefined && ask !== undefined && ask - bid <= 0.10000001
        ? ((bid + ask) / 2) * 100
        : (o.last_price ?? fallback);
    db.prepare('UPDATE outcomes SET mark_price = ? WHERE id = ?').run(cents, o.id);
    return cents / 100;
  });
  recordPriceSnapshot(db, marketId, probs, now);
}

/** Record a trade's price as the option's last Yes price (and, for binary markets, the other option's). */
function setLastPrice(db: DB, sh: Shares, s: Share, price: number) {
  if (sh.multi) {
    db.prepare('UPDATE outcomes SET last_price = ? WHERE id = ?').run(s.token === 0 ? price : 100 - price, s.outcome);
  } else {
    db.prepare('UPDATE outcomes SET last_price = CASE WHEN id = ? THEN ? ELSE ? END WHERE market_id = ?').run(
      s.outcome,
      price,
      100 - price,
      sh.market.id,
    );
  }
}

/** `exact`: the buyer escrowed exactly what the fills cost (FOK/FAK), so there is no improvement to refund. */
function fillLeg(db: DB, o: OrderRow, quantity: number, price: number, now: number, exact = false) {
  const s = orderShare(o);
  if (o.side === 'buy') {
    if (price > o.price) throw new Error('Fill exceeds buy limit');
    const improvement = exact ? 0 : (o.price - price) * quantity;
    if (improvement)
      adjustBalance(db, o.user_id, improvement, 'order_release', now, { marketId: o.market_id, note: '成交价格改善' });
    position(db, o.user_id, o.market_id, s, quantity, 0, price * quantity);
  } else {
    if (price < o.price) throw new Error('Fill below sell limit');
    takeShares(db, o.user_id, o.market_id, s, quantity, true);
    adjustBalance(db, o.user_id, price * quantity, 'sell', now, { marketId: o.market_id });
  }
  db.prepare(
    `UPDATE exchange_orders SET remaining = remaining - ?,
    status = CASE WHEN remaining = ? THEN 'filled' ELSE 'open' END WHERE id = ?`,
  ).run(quantity, quantity, o.id);
  o.remaining -= quantity;
}

const defaultLimit = (side: 'buy' | 'sell') => (side === 'buy' ? 99 : 1);

/** What an order would fill right now against other people's orders, without placing it. */
export function quoteOrder(db: DB, userId: number, marketId: number, input: OrderInput, now: number) {
  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '订单无效');
  const sh = sharesOf(db, exchangeMarket(db, marketId));
  const s = resolveShare(sh, input.outcomeId, input.token);
  const limit = input.price !== undefined ? Math.round(input.price * 100) : defaultLimit(input.side);
  const book = levels(db, sh, s, input.side === 'buy' ? 'sell' : 'buy', now, userId);
  const plan: FillPlan = planFill(
    book,
    input.side,
    input.amount !== undefined ? { amount: input.amount } : { quantity: input.quantity! },
    limit / 100,
  );
  const o = sh.outcomes.find((x) => x.id === s.outcome)!;
  return { share: s, label: shareLabel(o.label, s.token, sh.multi), multi: sh.multi, plan, book };
}

/** Price first, then resting order id (FIFO). Each fill executes at the maker's price. */
export function placeOrder(db: DB, userId: number, marketId: number, input: OrderInput, now: number): ExchangeOrder {
  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '订单无效');
  const type = input.type ?? 'GTC';
  const immediate = type === 'FOK' || type === 'FAK';
  const limit = input.price !== undefined ? Math.round(input.price * 100) : defaultLimit(input.side);
  const amount = input.amount !== undefined ? toCents(input.amount) : null;
  return db.transaction(() => {
    // Check before reserving assets or checking close time: retries return the original order,
    // including its latest fills/cancellation, even after the market has closed.
    if (input.clientOrderId) {
      const existing = db
        .prepare('SELECT * FROM exchange_orders WHERE user_id = ? AND client_order_id = ?')
        .get(userId, input.clientOrderId) as OrderRow | undefined;
      if (existing) {
        const same =
          existing.market_id === marketId &&
          (() => {
            const s = resolveShare(sharesOf(db, getMarketRow(db, marketId)), input.outcomeId, input.token);
            return existing.outcome_id === s.outcome && existing.token === s.token;
          })() &&
          existing.side === input.side &&
          existing.order_type === type &&
          existing.price === limit &&
          existing.amount === amount &&
          (amount !== null || existing.quantity === input.quantity) &&
          existing.expires_at === (input.expiresAt ?? null) &&
          existing.post_only === Number(input.postOnly ?? false);
        if (!same) throw conflict('clientOrderId 已用于不同的订单');
        return toOrder(existing);
      }
    }
    const sh = sharesOf(db, exchangeMarket(db, marketId, now, userId));
    const s = resolveShare(sh, input.outcomeId, input.token);
    const c = complement(sh, s);
    if (type === 'GTD' && input.expiresAt! < now + MINUTE) throw badRequest('到期时间至少要在 1 分钟之后');
    const buy = input.side === 'buy';
    let quantity = input.quantity ?? 0;
    let escrow = limit * quantity;
    // How far matching may go. FOK/FAK orders are planned against other people's orders first and
    // never rest, so they only go as far as their fills (buys escrow exactly what those cost).
    let reach = limit;
    if (immediate) {
      const book = levels(db, sh, s, buy ? 'sell' : 'buy', now, userId);
      const plan = planFill(book, input.side, amount !== null ? { amount: amount / 100 } : { quantity }, limit / 100);
      if (plan.quantity === 0) throw conflict('没有可成交的对手单，订单未执行');
      if (type === 'FOK' && !plan.complete) throw conflict('对手单不足，FOK 订单不能全部成交，已取消');
      if (amount !== null) quantity = plan.quantity;
      escrow = Math.round(plan.total * 100);
      reach = Math.round(plan.worstPrice! * 100);
    }
    // The same crossing rule serves self-trade prevention and ordinary matching: the share's
    // opposite side, or the complement's same side at 1 − p.
    const findCrossingOrder = (own: boolean) =>
      db
        .prepare(
          `SELECT *, CASE WHEN outcome_id = @o AND token = @t THEN price ELSE 100 - price END AS effective_price
        FROM exchange_orders WHERE market_id = @market AND ${LIVE} AND user_id ${own ? '=' : '<>'} @user AND
        ((outcome_id = @o AND token = @t AND side <> @side) OR (outcome_id = @co AND token = @ct AND side = @side))
        AND (CASE WHEN outcome_id = @o AND token = @t THEN price ELSE 100 - price END) ${buy ? '<=' : '>='} @price
        ORDER BY effective_price ${buy ? 'ASC' : 'DESC'}, id ASC LIMIT 1`,
        )
        .get({
          market: marketId,
          now,
          user: userId,
          o: s.outcome,
          t: s.token,
          co: c.outcome,
          ct: c.token,
          side: input.side,
          price: reach,
        }) as OrderRow | undefined;
    const ownOrder = findCrossingOrder(true);
    if (ownOrder) throw conflict(`订单会与自己的挂单 #${ownOrder.id} 交叉，已拒绝；请先撤销旧单或调整价格`);

    if (buy) {
      adjustBalance(db, userId, -escrow, 'order_lock', now, { marketId });
    } else {
      if (available(db, userId, s) < quantity) throw badRequest('可用份额不足，不能裸卖空');
      position(db, userId, marketId, s, 0, quantity);
    }
    const id = Number(
      db
        .prepare(
          `INSERT INTO exchange_orders (user_id, market_id, outcome_id, token, side, order_type, price, quantity, remaining,
          amount, expires_at, created_at, client_order_id, post_only)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          marketId,
          s.outcome,
          s.token,
          input.side,
          type,
          limit,
          quantity,
          quantity,
          amount,
          input.expiresAt ?? null,
          now,
          input.clientOrderId ?? null,
          Number(input.postOnly ?? false),
        ).lastInsertRowid,
    );
    const incoming = db.prepare('SELECT * FROM exchange_orders WHERE id = ?').get(id) as OrderRow;
    let spent = 0;
    while (incoming.remaining > 0) {
      const maker = findCrossingOrder(false);
      if (!maker) break;
      // Reject before the first fill; the transaction rolls back reservations and insertion.
      // The ordinary candidate query also covers complementary liquidity and excludes self-trades.
      if (input.postOnly) throw conflict('Post-only 订单会立即成交，已拒绝，请调整限价');
      const fill = Math.min(incoming.remaining, maker.remaining);
      const fillPrice = maker.outcome_id === s.outcome && maker.token === s.token ? maker.price : 100 - maker.price;
      const kind = maker.side !== incoming.side ? 'transfer' : buy ? 'mint' : 'merge';
      fillLeg(db, maker, fill, maker.price, now);
      fillLeg(db, incoming, fill, fillPrice, now, immediate);
      spent += fillPrice * fill;
      if (kind !== 'transfer')
        db.prepare('UPDATE markets SET pot = pot + ? WHERE id = ?').run(
          (kind === 'mint' ? 100 : -100) * fill,
          marketId,
        );
      db.prepare(
        `INSERT INTO exchange_trades (market_id, outcome_id, token, maker_id, taker_id, price, quantity, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(marketId, s.outcome, s.token, maker.id, id, fillPrice, fill, kind, now);
      setLastPrice(db, sh, s, fillPrice);
    }
    if (immediate) {
      if (buy && spent !== escrow) throw new Error('Market order escrow does not match its fills');
      if (incoming.remaining > 0) {
        // FAK: the unfilled rest is cancelled; buys escrowed nothing for it.
        if (type === 'FOK') throw new Error('FOK order did not fill completely');
        if (!buy) position(db, userId, marketId, s, 0, -incoming.remaining);
        db.prepare("UPDATE exchange_orders SET status = 'cancelled' WHERE id = ?").run(id);
      }
    }
    refreshPrices(db, marketId, now);
    return toOrder(db.prepare('SELECT * FROM exchange_orders WHERE id = ?').get(id) as OrderRow);
  })();
}

export function cancelOrder(db: DB, userId: number, marketId: number, orderId: number, now: number) {
  db.transaction(() => {
    exchangeMarket(db, marketId);
    const o = db.prepare('SELECT * FROM exchange_orders WHERE id = ? AND market_id = ?').get(orderId, marketId) as
      OrderRow | undefined;
    if (!o) throw notFound('订单不存在');
    if (o.user_id !== userId) throw forbidden('只能撤销自己的订单');
    if (o.status !== 'open') throw conflict('订单已成交或已撤销');
    releaseOrder(db, o, now);
    refreshPrices(db, marketId, now);
  })();
}

/** Release open orders at trading close (even before the result) and GTD orders at their expiry. */
export function expireExchangeOrders(db: DB, now: number) {
  db.transaction(() => {
    const orders = db
      .prepare(
        `SELECT o.*, (m.status <> 'open' OR m.close_at <= @now) AS closed FROM exchange_orders o
      JOIN markets m ON m.id = o.market_id
      WHERE o.status = 'open' AND (m.status <> 'open' OR m.close_at <= @now OR o.expires_at <= @now)`,
      )
      .all({ now }) as (OrderRow & { closed: number })[];
    for (const o of orders) releaseOrder(db, o, now, o.closed ? `撤销订单 #${o.id}` : `订单 #${o.id} 到期`);
    for (const id of new Set(orders.map((o) => o.market_id))) refreshPrices(db, id, now);
  })();
}

/** Whether a share pays 1 when `winner` wins. */
const PAYS = `((token = 0 AND outcome_id = @winner) OR (token = 1 AND outcome_id <> @winner))`;

/** Caller wraps this together with the market status change in one transaction. */
export function settleExchange(db: DB, marketId: number, winner: number, now: number) {
  const orders = db
    .prepare("SELECT * FROM exchange_orders WHERE market_id = ? AND status = 'open'")
    .all(marketId) as OrderRow[];
  for (const o of orders) releaseOrder(db, o, now);
  const payouts = db
    .prepare(
      `SELECT user_id, SUM(quantity * CASE WHEN ${PAYS} THEN 100 ELSE 0 END) AS amount
    FROM exchange_positions WHERE market_id = @market GROUP BY user_id`,
    )
    .all({ winner, market: marketId }) as { user_id: number; amount: number }[];
  const collateral = getMarketRow(db, marketId).pot;
  if (payouts.reduce((n, p) => n + p.amount, 0) !== collateral)
    throw new Error('Exchange collateral invariant violated');
  for (const p of payouts)
    if (p.amount)
      adjustBalance(db, p.user_id, p.amount, 'payout', now, {
        marketId,
        note: '获胜份额每份兑回 1',
      });
  db.prepare('UPDATE markets SET pot = 0 WHERE id = ?').run(marketId);
  db.prepare('UPDATE outcomes SET mark_price = CASE WHEN id = ? THEN 100 ELSE 0 END WHERE market_id = ?').run(
    winner,
    marketId,
  );
}

/** How many people hold a share that pays when `winner` wins. */
export function winningHolders(db: DB, marketId: number, winner: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(DISTINCT user_id) AS n FROM exchange_positions
        WHERE market_id = @market AND quantity > 0 AND ${PAYS}`,
      )
      .get({ market: marketId, winner }) as { n: number }
  ).n;
}

const toPosition = (p: {
  outcome_id: number;
  token: 0 | 1;
  quantity: number;
  reserved: number;
  cost: number;
}): ExchangePosition => ({
  outcomeId: p.outcome_id,
  token: tokenName(p.token),
  quantity: p.quantity,
  reserved: p.reserved,
  cost: fromCents(p.cost),
  avgPrice: p.quantity ? Math.round(p.cost / p.quantity) / 100 : null,
});

export function exchangeState(db: DB, marketId: number, now: number, userId?: number): ExchangeState {
  const sh = sharesOf(db, exchangeMarket(db, marketId));
  const trades = db
    .prepare('SELECT * FROM exchange_trades WHERE market_id = ? ORDER BY id DESC LIMIT 50')
    .all(marketId) as {
    id: number;
    outcome_id: number;
    token: 0 | 1;
    price: number;
    quantity: number;
    kind: 'transfer' | 'mint' | 'merge';
    created_at: number;
  }[];
  return {
    collateral: fromCents(sh.market.pot),
    books: allShares(sh).map((s): ExchangeBook => ({
      outcomeId: s.outcome,
      token: tokenName(s.token),
      bids: levels(db, sh, s, 'buy', now),
      asks: levels(db, sh, s, 'sell', now),
      lastPrice: lastPrice(sh, s) === null ? null : fromCents(lastPrice(sh, s)!),
    })),
    positions: userId
      ? (
          db
            .prepare(
              `SELECT p.* FROM exchange_positions p JOIN outcomes o ON o.id = p.outcome_id
              WHERE p.market_id = ? AND p.user_id = ? ORDER BY o.idx, p.token`,
            )
            .all(marketId, userId) as Parameters<typeof toPosition>[0][]
        ).map(toPosition)
      : [],
    orders: userId
      ? (
          db
            .prepare(
              `SELECT * FROM exchange_orders WHERE market_id = ? AND user_id = ? AND
              (status = 'open' OR id IN (SELECT id FROM exchange_orders WHERE market_id = ? AND user_id = ? ORDER BY id DESC LIMIT 100))
              ORDER BY (status = 'open') DESC, id DESC`,
            )
            .all(marketId, userId, marketId, userId) as OrderRow[]
        ).map(toOrder)
      : [],
    trades: trades.map((t) => ({
      id: t.id,
      outcomeId: t.outcome_id,
      token: tokenName(t.token),
      price: fromCents(t.price),
      quantity: t.quantity,
      kind: t.kind,
      createdAt: t.created_at,
    })),
  };
}

/** A market's biggest holders of each share. */
export function exchangeHolders(db: DB, marketId: number, perShare = 10): ExchangeHolder[] {
  exchangeMarket(db, marketId);
  const rows = db
    .prepare(
      `SELECT p.*, u.username, u.display_name FROM exchange_positions p JOIN users u ON u.id = p.user_id
      WHERE p.market_id = ? AND p.quantity > 0 ORDER BY p.quantity DESC, p.user_id`,
    )
    .all(marketId) as (Parameters<typeof toPosition>[0] & {
    user_id: number;
    username: string;
    display_name: string;
  })[];
  const counts = new Map<string, number>();
  const holders: ExchangeHolder[] = [];
  for (const r of rows) {
    const key = `${r.outcome_id}:${r.token}`;
    const n = counts.get(key) ?? 0;
    if (n >= perShare) continue;
    counts.set(key, n + 1);
    const p = toPosition(r);
    holders.push({
      user: toUserRef({ id: r.user_id, username: r.username, display_name: r.display_name }),
      outcomeId: p.outcomeId,
      token: p.token,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
    });
  }
  return holders;
}

/** Both sides of a market's trades, newest first: who bought or sold which share at what price. */
export function exchangeActivity(
  db: DB,
  marketId: number,
  opts: { before?: number; limit?: number } = {},
): ExchangeActivity[] {
  exchangeMarket(db, marketId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT t.id AS trade_id, t.quantity, t.created_at, e.side, e.outcome_id, e.token, e.user_id,
        u.username, u.display_name,
        CASE WHEN t.outcome_id = e.outcome_id AND t.token = e.token THEN t.price ELSE 100 - t.price END AS price
      FROM (SELECT * FROM exchange_trades WHERE market_id = @market AND id < @before ORDER BY id DESC LIMIT @limit) t
      JOIN exchange_orders e ON e.id = t.maker_id OR e.id = t.taker_id
      JOIN users u ON u.id = e.user_id
      ORDER BY t.id DESC, e.id = t.taker_id DESC`,
    )
    .all({ market: marketId, before: opts.before ?? Number.MAX_SAFE_INTEGER, limit }) as {
    trade_id: number;
    quantity: number;
    created_at: number;
    side: 'buy' | 'sell';
    outcome_id: number;
    token: 0 | 1;
    user_id: number;
    username: string;
    display_name: string;
    price: number;
  }[];
  return rows.map((r) => ({
    tradeId: r.trade_id,
    user: toUserRef({ id: r.user_id, username: r.username, display_name: r.display_name }),
    side: r.side,
    outcomeId: r.outcome_id,
    token: tokenName(r.token),
    price: fromCents(r.price),
    quantity: r.quantity,
    createdAt: r.created_at,
  }));
}

export function exchangePortfolio(db: DB, userId: number, now: number): ExchangePortfolioPosition[] {
  const rows = db
    .prepare(
      `SELECT p.*, m.question, m.status, m.close_at, m.neg_risk, o.label, o.mark_price
    FROM exchange_positions p JOIN markets m ON m.id = p.market_id JOIN outcomes o ON o.id = p.outcome_id
    WHERE p.user_id = ? AND p.quantity > 0 ORDER BY (m.status = 'open') DESC, m.id DESC, o.idx, p.token`,
    )
    .all(userId) as (Parameters<typeof toPosition>[0] & {
    market_id: number;
    question: string;
    status: 'open' | 'resolved' | 'cancelled';
    close_at: number;
    neg_risk: 0 | 1;
    label: string;
    mark_price: number;
  })[];
  return rows.map((r) => {
    const price = (r.token === 0 ? r.mark_price : 100 - r.mark_price) / 100;
    const value = Math.round(r.quantity * price * 100) / 100;
    return {
      ...toPosition(r),
      marketId: r.market_id,
      question: r.question,
      outcomeLabel: shareLabel(r.label, r.token, r.neg_risk === 1),
      status: derivedStatus(r, now),
      price: Math.round(price * 1000) / 1000,
      value,
      pnl: Math.round((value - fromCents(r.cost)) * 100) / 100,
    };
  });
}

export function exchangePortfolioOrders(db: DB, userId: number): ExchangePortfolioOrder[] {
  const rows = db
    .prepare(
      `SELECT e.*, m.question, m.neg_risk, o.label FROM exchange_orders e
    JOIN markets m ON m.id = e.market_id JOIN outcomes o ON o.id = e.outcome_id
    WHERE e.user_id = ? AND e.status = 'open' ORDER BY e.id DESC`,
    )
    .all(userId) as (OrderRow & { question: string; label: string; neg_risk: 0 | 1 })[];
  return rows.map((r) => ({
    ...toOrder(r),
    marketId: r.market_id,
    question: r.question,
    outcomeLabel: shareLabel(r.label, r.token, r.neg_risk === 1),
  }));
}
