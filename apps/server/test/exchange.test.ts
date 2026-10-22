import { afterEach, describe, expect, it } from 'vitest';
import { cancelOrder, placeOrder, splitMerge } from '../src/services/exchange';
import { cancelMarket, resolveMarket } from '../src/services/bets';
import { createAction, executeAction } from '../src/wecom/actions';
import { runTool, type ToolContext } from '../src/wecom/tools';
import { HttpError } from '../src/lib/http';
import { setup } from './helpers';

const environments: ReturnType<typeof setup>[] = [];
afterEach(() => {
  for (const e of environments.splice(0)) e.db.close();
});

async function fixture() {
  const env = setup();
  environments.push(env);
  const alice = await env.register('alice');
  const bob = await env.register('bob');
  const carol = await env.register('carol');
  const created = await alice.post('/markets', {
    question: '明天会下雨吗？',
    category: '生活',
    mode: 'polymarket',
    outcomes: ['Yes', 'No'],
    closeAt: env.clock.now + 86400000,
  });
  expect(created.status).toBe(201);
  const id = created.body.id as number;
  const market = (await alice.get(`/markets/${id}`)).body.market;
  const [yes, no] = market.outcomes.map((o: { id: number }) => o.id) as [number, number];
  const base = `/markets/${id}`;
  const order = (c: typeof alice, outcomeId: number, side: 'buy' | 'sell', price: number, quantity: number) =>
    c.post(`${base}/orders`, { outcomeId, side, price, quantity });
  const state = async (c = alice) => (await c.get(`${base}/exchange`)).body;
  const balance = async (c = alice) => (await c.get('/auth/me')).body.user.balance;
  return { ...env, alice, bob, carol, id, yes, no, base, order, state, balance };
}

describe('Polymarket exchange', () => {
  it('splits and merges complete sets, tracks locked assets and rejects overspending/overselling', async () => {
    const e = await fixture();
    expect((await e.alice.post(`${e.base}/split`, { quantity: 10 })).status).toBe(200);
    expect(await e.balance()).toBe(990);
    expect((await e.state()).positions.map((p: any) => p.quantity)).toEqual([10, 10]);
    expect((await e.alice.get('/portfolio')).body.stats.netWorth).toBe(1000);
    const ask = await e.order(e.alice, e.yes, 'sell', 0.6, 7);
    expect(ask.status).toBe(201);
    expect((await e.order(e.alice, e.yes, 'sell', 0.6, 4)).status).toBe(400);
    expect((await e.alice.post(`${e.base}/merge`, { quantity: 4 })).status).toBe(400);
    expect((await e.alice.post(`${e.base}/merge`, { quantity: 3 })).status).toBe(200);
    expect((await e.bob.post(`${e.base}/orders/${ask.body.id}/cancel`)).status).toBe(403);
    await e.alice.post(`${e.base}/orders/${ask.body.id}/cancel`);
    await e.alice.post(`${e.base}/merge`, { quantity: 7 });
    expect(await e.balance()).toBe(1000);
    expect((await e.state()).collateral).toBe(0);
    expect((await e.alice.post(`${e.base}/split`, { quantity: 1001 })).status).toBe(400);
  });

  it('keeps AI bots out of human order books and collateral operations', async () => {
    const e = await fixture();
    e.db.prepare('UPDATE users SET is_bot = 1 WHERE id = 1').run();
    expect(() => splitMerge(e.db, 1, e.id, 2, 'split', e.clock.now)).toThrow('机器人只能在 AI 专区交易');
    expect(() =>
      placeOrder(e.db, 1, e.id, { outcomeId: e.yes, side: 'buy', price: 0.4, quantity: 1 }, e.clock.now),
    ).toThrow('机器人只能在 AI 专区交易');
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM exchange_orders').get()).toEqual({ n: 0 });
    expect(e.db.prepare('SELECT balance FROM users WHERE id = 1').get()).toEqual({ balance: 100000 });
    e.db.prepare('UPDATE markets SET is_ai = 1 WHERE id = ?').run(e.id);
    splitMerge(e.db, 1, e.id, 2, 'split', e.clock.now);
    expect(
      placeOrder(e.db, 1, e.id, { outcomeId: e.yes, side: 'sell', price: 0.6, quantity: 1 }, e.clock.now).status,
    ).toBe('open');
  });

  it('matches best prices then FIFO, partially fills and refunds limit price improvement', async () => {
    const e = await fixture();
    await e.bob.post(`${e.base}/split`, { quantity: 10 });
    await e.carol.post(`${e.base}/split`, { quantity: 10 });
    const expensive = (await e.order(e.bob, e.yes, 'sell', 0.6, 4)).body;
    const first = (await e.order(e.bob, e.yes, 'sell', 0.4, 3)).body;
    const second = (await e.order(e.carol, e.yes, 'sell', 0.4, 5)).body;
    const bought = (await e.order(e.alice, e.yes, 'buy', 0.7, 6)).body;
    expect(bought.remaining).toBe(0);
    expect(await e.balance()).toBe(997.6);
    const rows = e.db
      .prepare('SELECT id,remaining,status FROM exchange_orders WHERE id IN (?,?,?) ORDER BY id')
      .all(expensive.id, first.id, second.id);
    expect(rows).toEqual([
      { id: expensive.id, remaining: 4, status: 'open' },
      { id: first.id, remaining: 0, status: 'filled' },
      { id: second.id, remaining: 2, status: 'open' },
    ]);
    expect((await e.state()).trades.map((t: any) => [t.price, t.quantity])).toEqual([
      [0.4, 3],
      [0.4, 3],
    ]);
    const bid = (await e.order(e.alice, e.yes, 'buy', 0.3, 10)).body;
    expect((await e.alice.get('/portfolio')).body.stats.balance).toBe(994.6);
    expect((await e.alice.get('/portfolio')).body.stats.staked).toBeGreaterThanOrEqual(3);
    await e.alice.post(`${e.base}/orders/${bid.id}/cancel`);
    expect(await e.balance()).toBe(997.6);
  });

  it('mints complementary buys with maker pricing and shows them as implied asks', async () => {
    const e = await fixture();
    await e.order(e.bob, e.no, 'buy', 0.65, 4);
    expect((await e.state()).books).toEqual([
      { outcomeId: e.yes, token: 'yes', bids: [], asks: [{ price: 0.35, quantity: 4 }], lastPrice: null },
      { outcomeId: e.no, token: 'yes', bids: [{ price: 0.65, quantity: 4 }], asks: [], lastPrice: null },
    ]);
    const incoming = await e.order(e.alice, e.yes, 'buy', 0.5, 6);
    expect(incoming.body.remaining).toBe(2);
    expect(await e.balance()).toBe(997.6); // 1.40 paid + 1.00 still locked
    expect(await e.balance(e.bob)).toBe(997.4);
    expect((await e.state()).collateral).toBe(4);
    expect((await e.state()).trades[0].kind).toBe('mint');
    await e.alice.post(`${e.base}/orders/${incoming.body.id}/cancel`);
    expect(await e.balance()).toBe(998.6);
    expect((await e.state()).positions.find((p: any) => p.outcomeId === e.yes).quantity).toBe(4);
  });

  it('exposes best quotes, including complementary orders, without inventing prices for empty or closed books', async () => {
    const e = await fixture();
    const quotes = (market: any) => market.outcomes.map(({ bestBid, bestAsk }: any) => [bestBid, bestAsk]);
    const empty = [
      [null, null],
      [null, null],
    ];
    expect(quotes((await e.alice.get(e.base)).body.market)).toEqual(empty);
    await e.order(e.bob, e.no, 'buy', 0.52, 10);
    expect(quotes((await e.alice.get(e.base)).body.market)).toEqual([
      [null, 0.48],
      [0.52, null],
    ]);
    await e.bob.post(`${e.base}/split`, { quantity: 10 });
    await e.order(e.bob, e.yes, 'sell', 0.6, 3);
    const bestAsk = (await e.order(e.bob, e.yes, 'sell', 0.55, 2)).body;
    await e.order(e.alice, e.yes, 'buy', 0.3, 4);
    const bid = (await e.order(e.carol, e.yes, 'buy', 0.4, 2)).body;
    const expected = [
      [0.4, 0.48],
      [0.52, 0.6],
    ];
    expect(quotes((await e.alice.get(e.base)).body.market)).toEqual(expected);
    expect(quotes((await e.alice.get('/markets?mode=polymarket')).body[0])).toEqual(expected);
    await e.bob.post(`${e.base}/orders/${bestAsk.id}/cancel`);
    await e.carol.post(`${e.base}/orders/${bid.id}/cancel`);
    expect(quotes((await e.alice.get(e.base)).body.market)).toEqual([
      [0.3, 0.48],
      [0.52, 0.7],
    ]);
    e.clock.now += 86400000;
    expect(quotes((await e.alice.get(e.base)).body.market)).toEqual(empty);
  });

  it('shows remaining orders with complementary liquidity folded in, aggregated and sorted, in both book endpoints', async () => {
    const e = await fixture();
    await e.bob.post(`${e.base}/split`, { quantity: 20 });
    await e.order(e.bob, e.no, 'sell', 0.6, 7);
    await e.order(e.bob, e.yes, 'sell', 0.7, 2);
    await e.order(e.bob, e.yes, 'sell', 0.48, 5);
    await e.order(e.bob, e.yes, 'sell', 0.48, 2);
    await e.order(e.bob, e.no, 'buy', 0.52, 4);
    await e.order(e.bob, e.yes, 'buy', 0.4, 3);
    await e.order(e.bob, e.yes, 'buy', 0.4, 6);
    await e.order(e.carol, e.yes, 'buy', 0.45, 2);
    await e.order(e.alice, e.yes, 'buy', 0.48, 1);
    const cancelled = (await e.order(e.bob, e.yes, 'buy', 0.3, 1)).body;
    await e.bob.post(`${e.base}/orders/${cancelled.id}/cancel`);
    // A No sell at p is a Yes bid at 1 − p, a No buy is a Yes ask, and the other way round.
    const expected = [
      {
        outcomeId: e.yes,
        token: 'yes',
        bids: [
          { price: 0.45, quantity: 2 },
          { price: 0.4, quantity: 16 },
        ],
        asks: [
          { price: 0.48, quantity: 10 },
          { price: 0.7, quantity: 2 },
        ],
        lastPrice: 0.48,
      },
      {
        outcomeId: e.no,
        token: 'yes',
        bids: [
          { price: 0.52, quantity: 10 },
          { price: 0.3, quantity: 2 },
        ],
        asks: [
          { price: 0.55, quantity: 2 },
          { price: 0.6, quantity: 16 },
        ],
        lastPrice: 0.52,
      },
    ];
    expect((await e.state()).books).toEqual(expected);
    expect((await e.client().get(`/trading/markets/${e.id}/book`)).body.books).toEqual(expected);
  });

  it('merges complementary sell orders and releases exactly one unit per pair', async () => {
    const e = await fixture();
    await e.alice.post(`${e.base}/split`, { quantity: 5 });
    await e.bob.post(`${e.base}/split`, { quantity: 5 });
    await e.order(e.alice, e.yes, 'sell', 0.6, 5);
    const result = await e.order(e.bob, e.no, 'sell', 0.3, 3);
    expect(result.body.remaining).toBe(0);
    expect(await e.balance(e.bob)).toBe(996.2); // maker Yes .60 => taker No .40
    expect(await e.balance()).toBe(996.8);
    expect((await e.state()).collateral).toBe(7);
    expect((await e.state()).trades[0]).toMatchObject({ price: 0.4, quantity: 3, kind: 'merge' });
  });

  it('prioritizes the best effective price across direct and complementary orders', async () => {
    const e = await fixture();
    await e.order(e.bob, e.no, 'buy', 0.6, 5); // implied Yes ask .40
    await e.carol.post(`${e.base}/split`, { quantity: 5 });
    await e.order(e.carol, e.yes, 'sell', 0.35, 5); // newer but better than .40
    await e.order(e.alice, e.yes, 'buy', 0.5, 7);
    expect((await e.state()).trades.map((t: any) => [t.price, t.quantity, t.kind])).toEqual([
      [0.4, 2, 'mint'],
      [0.35, 5, 'transfer'],
    ]);
    expect(await e.balance()).toBe(997.45);
    expect((await e.state()).collateral).toBe(7);
    const pending = (await e.order(e.alice, e.yes, 'buy', 0.1, 2)).body;
    const portfolio = (await e.alice.get('/portfolio')).body;
    expect(portfolio.exchangeOrders).toContainEqual(
      expect.objectContaining({ id: pending.id, remaining: 2, marketId: e.id }),
    );
  });

  it('settles fixed winning-share payouts, unlocks orders, and prevents double settlement', async () => {
    const e = await fixture();
    await e.order(e.alice, e.yes, 'buy', 0.4, 100);
    await e.order(e.bob, e.no, 'buy', 0.6, 100);
    await e.order(e.carol, e.yes, 'buy', 0.2, 7);
    await e.order(e.alice, e.yes, 'sell', 0.8, 10);
    expect((await e.bob.post(`${e.base}/resolve`, { outcomeId: e.yes })).status).toBe(403);
    e.clock.now += 86400000;
    expect((await e.alice.post(`${e.base}/resolve`, { outcomeId: e.yes })).status).toBe(200);
    expect(await e.balance()).toBe(1060);
    expect(await e.balance(e.bob)).toBe(940);
    expect(await e.balance(e.carol)).toBe(1000);
    expect((await e.state()).collateral).toBe(0);
    expect((await e.state()).orders.some((o: any) => o.status === 'open')).toBe(false);
    expect((await e.alice.post(`${e.base}/resolve`, { outcomeId: e.yes })).status).toBe(409);
    expect((await e.order(e.alice, e.yes, 'buy', 0.4, 1)).status).toBe(409);
    expect((await e.alice.get('/portfolio')).body.stats.netWorth).toBe(1060);
  });

  it('keeps profit and net-worth rankings immune to quotes and tiny trades until settlement', async () => {
    const e = await fixture();
    await e.bob.post(`${e.base}/split`, { quantity: 100 });
    await e.order(e.carol, e.no, 'buy', 0.7, 100);
    await e.order(e.bob, e.no, 'sell', 0.7, 100);
    const rankings = async () => {
      const result = [];
      for (const sort of ['profit', 'netWorth']) {
        result.push(
          (await e.alice.get(`/leaderboard?sort=${sort}`)).body.map((entry: any) => ({
            user: entry.user.username,
            rank: entry.rank,
            profit: entry.stats.profit,
            netWorth: entry.stats.netWorth,
          })),
        );
      }
      return result;
    };
    const before = await rankings();
    expect(before[0]).toEqual([
      { user: 'alice', rank: 1, profit: 0, netWorth: 1000 },
      { user: 'bob', rank: 2, profit: 0, netWorth: 1000 },
      { user: 'carol', rank: 3, profit: 0, netWorth: 1000 },
    ]);

    // The review's attack: 1-share quotes reprice 100 shares without a fill.
    const bid = await e.order(e.bob, e.yes, 'buy', 0.98, 1);
    const ask = await e.order(e.bob, e.yes, 'sell', 0.99, 1);
    expect([bid.status, ask.status]).toEqual([201, 201]);
    expect(e.db.prepare('SELECT mark_price FROM outcomes WHERE id = ?').get(e.yes)).toEqual({ mark_price: 98.5 });
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM exchange_trades').get()).toEqual({ n: 1 });
    expect(await rankings()).toEqual(before);
    for (const path of ['/portfolio', '/trading/account', '/users/2']) {
      expect((await e.bob.get(path)).body.stats).toMatchObject({
        balance: 969.02,
        staked: 30.98,
        profit: 0,
        netWorth: 1000,
      });
    }
    await e.bob.post(`${e.base}/orders/${bid.body.id}/cancel`);
    await e.bob.post(`${e.base}/orders/${ask.body.id}/cancel`);
    expect(await rankings()).toEqual(before);

    // Using a small real trade instead of a quote cannot mark up the remaining shares either.
    await e.order(e.bob, e.yes, 'sell', 0.99, 1);
    await e.order(e.carol, e.yes, 'buy', 0.99, 1);
    await e.order(e.bob, e.no, 'buy', 0.2, 3);
    expect(await rankings()).toEqual(before);
    e.clock.now += 86400000;
    expect((await e.alice.get(e.base)).body.market.status).toBe('closed');
    expect(await rankings()).toEqual(before);

    expect((await e.alice.post(`${e.base}/resolve`, { outcomeId: e.yes })).status).toBe(200);
    const bob = (await e.bob.get('/portfolio')).body.stats;
    const carol = (await e.carol.get('/trading/account')).body.stats;
    expect(bob).toMatchObject({ balance: 1069.99, staked: 0, netWorth: 1069.99, profit: 69.99 });
    expect(carol).toMatchObject({ balance: 930.01, staked: 0, netWorth: 930.01, profit: -69.99 });
    expect((await e.bob.get('/leaderboard')).body.map((entry: any) => entry.user.username)).toEqual([
      'bob',
      'alice',
      'carol',
    ]);
  });

  it('defers exited trading profits and accounts for mint, merge, partial fills, bonuses and other open markets', async () => {
    const e = await fixture();
    // Mint at 0.40/0.60, sell part at a profit, then merge the rest with bought No shares.
    await e.order(e.alice, e.yes, 'buy', 0.4, 10);
    await e.order(e.bob, e.no, 'buy', 0.6, 10);
    const partial = await e.order(e.alice, e.yes, 'sell', 0.5, 10);
    await e.order(e.carol, e.yes, 'buy', 0.8, 4);
    await e.alice.post(`${e.base}/orders/${partial.body.id}/cancel`);
    await e.order(e.bob, e.no, 'sell', 0.4, 6);
    await e.order(e.alice, e.no, 'buy', 0.6, 6);
    await e.alice.post(`${e.base}/merge`, { quantity: 6 });
    // Complementary sells merge the remaining sets and leave everyone flat.
    await e.order(e.carol, e.yes, 'sell', 0.5, 4);
    await e.order(e.bob, e.no, 'sell', 0.5, 4);
    expect((await e.state()).collateral).toBe(0);
    expect((await e.alice.get('/portfolio')).body.stats).toMatchObject({
      balance: 1001.6,
      staked: -1.6,
      profit: 0,
      netWorth: 1000,
    });
    expect((await e.bob.get('/portfolio')).body.stats).toMatchObject({ profit: 0, netWorth: 1000 });

    const pool = await e.alice.post('/markets', {
      question: '另一个尚未结算的奖池市场？',
      category: '生活',
      outcomes: ['是', '否'],
      closeAt: e.clock.now + 3 * 86400000,
    });
    expect(pool.status).toBe(201);
    const poolBase = `/markets/${pool.body.id}`;
    const poolMarket = (await e.alice.get(poolBase)).body.market;
    await e.alice.post(`${poolBase}/bets`, { outcomeId: poolMarket.outcomes[0].id, amount: 10 });
    const bonus = await e.alice.post('/me/bonus');
    expect(bonus.status).toBe(200);
    const funded = 1000 + e.config.dailyBonus;
    expect((await e.alice.get('/portfolio')).body.stats).toMatchObject({ funded, profit: 0, netWorth: funded });

    e.clock.now += 86400000;
    expect((await e.alice.post(`${e.base}/resolve`, { outcomeId: e.yes })).status).toBe(200);
    expect((await e.alice.get('/portfolio')).body.stats).toMatchObject({
      balance: funded - 8.4,
      staked: 10,
      profit: 1.6,
      netWorth: funded + 1.6,
    });
    expect((await e.bob.get('/portfolio')).body.stats.profit).toBe(-1.6);
    expect((await e.carol.get('/portfolio')).body.stats.profit).toBe(0);
    // Refunding another market has no profit and does not count the settled exchange twice.
    await e.alice.post(`${poolBase}/cancel`);
    expect((await e.alice.get('/portfolio')).body.stats).toMatchObject({
      balance: funded + 1.6,
      staked: 0,
      profit: 1.6,
      netWorth: funded + 1.6,
    });
  });

  it('forbids market cancellation through the API, automatic calls, and WeCom while retaining order cancellation', async () => {
    const e = await fixture();
    await e.alice.post(`${e.base}/split`, { quantity: 10 });
    await e.order(e.alice, e.yes, 'sell', 0.8, 10);
    await e.order(e.bob, e.yes, 'buy', 0.8, 10);
    const pending = (await e.order(e.alice, e.no, 'buy', 0.2, 3)).body;
    // Even a confirmation card issued under the former policy must not cancel the market.
    const staleAction = createAction(e.db, 1, 'fake-cancel-user', { kind: 'cancel', marketId: e.id }, e.clock.now);
    const snapshot = () =>
      [
        'users',
        'ledger',
        'exchange_positions',
        'exchange_orders',
        'exchange_trades',
        'markets',
        'outcomes',
        'price_history',
        'wecom_actions',
      ].map((table) => e.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    const result = await e.alice.post(`${e.base}/cancel`);
    expect(result.status).toBe(403);
    expect(result.body.error).toContain('Polymarket 市场不可取消');
    expect(snapshot()).toEqual(before);
    expect(() => cancelMarket(e.db, e.id, null, undefined, e.clock.now)).toThrow('Polymarket 市场不可取消');
    expect(() => executeAction(e.db, staleAction, e.clock.now)).toThrow('Polymarket 市场不可取消');
    const ctx: ToolContext = {
      db: e.db,
      config: e.config,
      now: e.clock.now,
      siteUrl: 'https://example.invalid',
      userId: 1,
      wecomUserId: 'fake-cancel-user',
      card: null,
    };
    expect(runTool(ctx, 'cancel_market', { marketId: e.id })).toMatchObject({ isError: true });
    expect(ctx.card).toBeNull();
    expect(snapshot()).toEqual(before);
    expect((await e.alice.get(e.base)).body.market.status).toBe('open');
    expect((await e.state()).collateral).toBe(10);
    expect((await e.alice.post(`${e.base}/orders/${pending.id}/cancel`)).status).toBe(200);
    expect(await e.balance()).toBe(998);
    expect(await e.balance(e.bob)).toBe(992);
    e.clock.now += 86400000;
    expect((await e.alice.post(`${e.base}/resolve`, { outcomeId: e.yes })).status).toBe(200);
    expect((await e.state()).collateral).toBe(0);
    expect(await e.balance(e.bob)).toBe(1002);
  });

  it('expires unmatched bids/asks at close and keeps collateral until resolution', async () => {
    const e = await fixture();
    await e.alice.post(`${e.base}/split`, { quantity: 4 });
    await e.order(e.alice, e.yes, 'sell', 0.8, 3);
    await e.order(e.bob, e.yes, 'buy', 0.2, 10);
    e.clock.now += 86400001;
    expect((await e.state()).orders.every((o: any) => o.status === 'cancelled')).toBe(true);
    expect(await e.balance(e.bob)).toBe(1000);
    expect((await e.state()).positions.every((p: any) => p.reserved === 0)).toBe(true);
    expect((await e.order(e.alice, e.no, 'sell', 0.4, 1)).status).toBe(409);
    e.clock.now += 8 * 86400000;
    expect((await e.alice.get(e.base)).body.market.status).toBe('closed');
    expect((await e.state()).collateral).toBe(4);
    expect(await e.balance()).toBe(996);
    expect((await e.alice.post(`${e.base}/resolve`, { outcomeId: e.yes })).status).toBe(200);
    expect(await e.balance()).toBe(1000);
  });

  it('validates mode, authentication, prices and share quantities, and does not self-trade', async () => {
    const e = await fixture();
    expect((await e.client().post(`${e.base}/split`, { quantity: 1 })).status).toBe(401);
    for (const quantity of [0, -1, 0.5, 1000001])
      expect((await e.alice.post(`${e.base}/split`, { quantity })).status).toBe(400);
    for (const price of [0, 1, 0.501]) expect((await e.order(e.alice, e.yes, 'buy', price, 1)).status).toBe(400);
    expect((await e.order(e.alice, e.yes, 'buy', 0.5, 1.5)).status).toBe(400);
    expect((await e.order(e.alice, e.yes, 'buy', 0.99, 1000000)).status).toBe(400);
    expect((await e.alice.post(`${e.base}/bets`, { outcomeId: e.yes, amount: 10 })).status).toBe(400);
    expect((await e.order(e.alice, 9999, 'buy', 0.5, 10)).status).toBe(404);
    await e.order(e.alice, e.yes, 'buy', 0.6, 10);
    expect((await e.order(e.alice, e.no, 'buy', 0.5, 10)).status).toBe(409);
    expect((await e.state()).trades).toEqual([]);
    expect((await e.state()).collateral).toBe(0);
    const invalid = await e.alice.post('/markets', {
      question: '两个选项必须是 Yes / No',
      category: '生活',
      mode: 'polymarket',
      outcomes: ['Yes', 'Maybe'],
      closeAt: e.clock.now + 86400000,
    });
    expect(invalid.status).toBe(400);
  });

  it('conserves cash, escrow, collateral and share reservations across a deterministic trading sequence', async () => {
    const e = await fixture();
    let seed = 419;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    for (let step = 0; step < 300; step++) {
      const user = 1 + random(3);
      const quantity = 1 + random(8);
      try {
        const op = random(5);
        if (op < 2) splitMerge(e.db, user, e.id, quantity, op === 0 ? 'split' : 'merge', e.clock.now);
        else if (op === 2) {
          const o = e.db
            .prepare("SELECT id FROM exchange_orders WHERE user_id = ? AND status = 'open' ORDER BY id LIMIT 1")
            .get(user) as { id: number } | undefined;
          if (o) cancelOrder(e.db, user, e.id, o.id, e.clock.now);
        } else
          placeOrder(
            e.db,
            user,
            e.id,
            {
              outcomeId: random(2) ? e.yes : e.no,
              side: random(2) ? 'buy' : 'sell',
              price: (1 + random(99)) / 100,
              quantity,
            },
            e.clock.now,
          );
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
      const cash = (e.db.prepare('SELECT SUM(balance) AS n FROM users').get() as any).n;
      const escrow = (
        e.db
          .prepare(
            "SELECT COALESCE(SUM(price * remaining),0) AS n FROM exchange_orders WHERE status = 'open' AND side = 'buy'",
          )
          .get() as any
      ).n;
      const collateral = (e.db.prepare('SELECT pot FROM markets WHERE id = ?').get(e.id) as any).pot;
      expect(cash + escrow + collateral).toBe(300000);
      for (const outcomeId of [e.yes, e.no]) {
        const shares = (
          e.db
            .prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM exchange_positions WHERE outcome_id = ?')
            .get(outcomeId) as any
        ).n;
        expect(shares * 100).toBe(collateral);
      }
      const invalidReserved = e.db
        .prepare(
          `SELECT p.user_id FROM exchange_positions p WHERE reserved <>
        (SELECT COALESCE(SUM(remaining),0) FROM exchange_orders o WHERE o.user_id = p.user_id AND o.outcome_id = p.outcome_id AND o.side = 'sell' AND o.status = 'open')`,
        )
        .all();
      expect(invalidReserved).toEqual([]);
      expect(
        e.db
          .prepare(
            'SELECT u.id FROM users u WHERE balance <> (SELECT COALESCE(SUM(amount),0) FROM ledger l WHERE l.user_id = u.id)',
          )
          .all(),
      ).toEqual([]);
    }
    expect((e.db.prepare('SELECT COUNT(*) AS n FROM exchange_trades').get() as any).n).toBeGreaterThan(5);
    resolveMarket(e.db, e.id, e.yes, 1, undefined, e.clock.now + 86400000);
    expect((e.db.prepare('SELECT SUM(balance) AS n FROM users').get() as any).n).toBe(300000);
  });
});
