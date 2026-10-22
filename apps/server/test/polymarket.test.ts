import { afterEach, describe, expect, it } from 'vitest';
import { placeOrder } from '../src/services/exchange';
import { executeAction, type ActionRow } from '../src/wecom/actions';
import { runTool, type ToolContext } from '../src/wecom/tools';
import { setup } from './helpers';

const DAY = 86_400_000;
const environments: ReturnType<typeof setup>[] = [];
afterEach(() => {
  for (const e of environments.splice(0)) e.db.close();
});

type Client = Awaited<ReturnType<ReturnType<typeof setup>['register']>>;

async function fixture(outcomes = ['Yes', 'No']) {
  const env = setup();
  environments.push(env);
  const alice = await env.register('alice');
  const bob = await env.register('bob');
  const carol = await env.register('carol');
  const dave = await env.register('dave');
  const created = await alice.post('/markets', {
    question: outcomes.length > 2 ? '谁会赢得年会大奖？' : '明天会下雨吗？',
    category: '生活',
    mode: 'polymarket',
    outcomes,
    closeAt: env.clock.now + DAY,
  });
  expect(created.status).toBe(201);
  const id = created.body.id as number;
  const market = (await alice.get(`/markets/${id}`)).body.market;
  const ids = market.outcomes.map((o: { id: number }) => o.id) as number[];
  const base = `/markets/${id}`;
  const order = (c: Client, body: Record<string, unknown>) => c.post(`${base}/orders`, body);
  const state = async (c: Client = alice) => (await c.get(`${base}/exchange`)).body;
  const balance = async (c: Client = alice) => (await c.get('/auth/me')).body.user.balance;
  const position = async (c: Client, outcomeId: number, token = 'yes') =>
    (await state(c)).positions.find((p: any) => p.outcomeId === outcomeId && p.token === token);
  return { ...env, alice, bob, carol, dave, id, ids, market, base, order, state, balance, position };
}

describe('Polymarket market orders and order types', () => {
  it('spends an amount in whole shares across levels, escrowing exactly what the fills cost', async () => {
    const e = await fixture();
    const [yes, no] = e.ids as [number, number];
    await e.bob.post(`${e.base}/split`, { quantity: 20 });
    await e.order(e.bob, { outcomeId: yes, side: 'sell', price: 0.4, quantity: 5 });
    await e.order(e.bob, { outcomeId: yes, side: 'sell', price: 0.5, quantity: 10 });

    const bought = await e.order(e.alice, { outcomeId: yes, side: 'buy', type: 'FAK', amount: 6.5 });
    expect(bought.status).toBe(201);
    // 5 × 0.40 = 2.00, then 4.50 buys 9 × 0.50.
    expect(bought.body).toMatchObject({ type: 'FAK', quantity: 14, remaining: 0, status: 'filled', amount: 6.5 });
    expect(await e.balance()).toBe(993.5);
    expect(await e.position(e.alice, yes)).toMatchObject({ quantity: 14, cost: 6.5, avgPrice: 0.46 });
    expect(await e.balance(e.bob)).toBe(986.5);
    expect((await e.alice.get('/portfolio/ledger')).body[0]).toMatchObject({ kind: 'order_lock', amount: -6.5 });

    // FOK needs the whole amount to be absorbed; only one share is left within the limit.
    const fok = await e.order(e.alice, { outcomeId: yes, side: 'buy', type: 'FOK', amount: 100 });
    expect(fok.status).toBe(409);
    expect(await e.balance()).toBe(993.5);
    expect((await e.order(e.alice, { outcomeId: no, side: 'buy', type: 'FAK', amount: 10 })).status).toBe(409);

    // Market sells take bids down to the limit; FAK cancels the rest and frees the shares.
    await e.order(e.carol, { outcomeId: yes, side: 'buy', price: 0.3, quantity: 3 });
    await e.order(e.carol, { outcomeId: yes, side: 'buy', price: 0.2, quantity: 10 });
    const fokSell = await e.order(e.alice, { outcomeId: yes, side: 'sell', type: 'FOK', price: 0.25, quantity: 5 });
    expect(fokSell.status).toBe(409);
    const sold = await e.order(e.alice, { outcomeId: yes, side: 'sell', type: 'FAK', price: 0.25, quantity: 5 });
    expect(sold.body).toMatchObject({ remaining: 2, status: 'cancelled' });
    expect(await e.position(e.alice, yes)).toMatchObject({ quantity: 11, reserved: 0 });
    expect(await e.balance()).toBe(994.4);
    const all = await e.order(e.alice, { outcomeId: yes, side: 'sell', type: 'FOK', quantity: 2 });
    expect(all.body).toMatchObject({ status: 'filled', price: 0.01 });
    expect(await e.balance()).toBe(994.8);

    // A resting ask of one's own only blocks a market buy whose fills would reach it.
    const own = await e.order(e.alice, { outcomeId: yes, side: 'sell', price: 0.9, quantity: 1 });
    expect((await e.order(e.alice, { outcomeId: yes, side: 'buy', type: 'FAK', quantity: 1 })).body).toMatchObject({
      status: 'filled',
    });
    await e.order(e.bob, { outcomeId: yes, side: 'sell', price: 0.95, quantity: 5 });
    const blocked = await e.order(e.alice, { outcomeId: yes, side: 'buy', type: 'FAK', amount: 10 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain(`#${own.body.id}`);
  });

  it('rests GTD orders until they expire, then releases them without matching late', async () => {
    const e = await fixture();
    const [yes] = e.ids as [number];
    const soon = await e.order(e.alice, {
      outcomeId: yes,
      side: 'buy',
      type: 'GTD',
      price: 0.4,
      quantity: 10,
      expiresAt: e.clock.now + 30_000,
    });
    expect(soon.status).toBe(400);
    const gtd = await e.order(e.alice, {
      outcomeId: yes,
      side: 'buy',
      type: 'GTD',
      price: 0.4,
      quantity: 10,
      expiresAt: e.clock.now + 2 * 60_000,
    });
    expect(gtd.body).toMatchObject({ type: 'GTD', status: 'open', expiresAt: e.clock.now + 2 * 60_000 });
    expect(await e.balance()).toBe(996);
    await e.bob.post(`${e.base}/split`, { quantity: 5 });

    // Past expiry the order no longer matches, even before a request has swept it away.
    e.clock.now += 3 * 60_000;
    const row = e.db.prepare(`SELECT id FROM users WHERE username = 'bob'`).get() as { id: number };
    const late = placeOrder(e.db, row.id, e.id, { outcomeId: yes, side: 'sell', price: 0.4, quantity: 5 }, e.clock.now);
    expect(late.status).toBe('open');
    expect((await e.alice.get(`/trading/orders/${gtd.body.id}`)).body.status).toBe('cancelled');
    expect(await e.balance()).toBe(1000);
  });

  it('validates order types and keeps type and amount in client-order idempotency', async () => {
    const e = await fixture();
    const [yes] = e.ids as [number];
    const bad = [
      { side: 'buy', type: 'FOK', amount: 5, postOnly: true },
      { side: 'buy', price: 0.5, amount: 5 },
      { side: 'sell', type: 'FAK', amount: 5 },
      { side: 'buy', type: 'FAK', amount: 5, quantity: 5 },
      { side: 'buy', quantity: 5 },
      { side: 'buy', type: 'GTD', price: 0.5, quantity: 5 },
      { side: 'buy', price: 0.5, quantity: 5, expiresAt: e.clock.now + DAY },
    ];
    for (const body of bad) expect((await e.order(e.alice, { outcomeId: yes, ...body })).status).toBe(400);

    await e.bob.post(`${e.base}/split`, { quantity: 10 });
    await e.order(e.bob, { outcomeId: yes, side: 'sell', price: 0.5, quantity: 10 });
    const body = { marketId: e.id, outcomeId: yes, side: 'buy', type: 'FAK', amount: 2, clientOrderId: 'mkt-1' };
    const first = await e.alice.post('/trading/orders', body);
    expect(first.body).toMatchObject({ quantity: 4, status: 'filled' });
    const retry = await e.alice.post('/trading/orders', body);
    expect(retry.body.id).toBe(first.body.id);
    expect(await e.balance()).toBe(998);
    expect((await e.alice.post('/trading/orders', { ...body, amount: 3 })).status).toBe(409);
    expect((await e.alice.post('/trading/orders', { ...body, type: 'FOK' })).status).toBe(409);
  });
});

describe('Polymarket positions, holders and activity', () => {
  it('keeps average cost through buys, sells and splits; value and P&L are estimates only', async () => {
    const e = await fixture();
    const [yes, no] = e.ids as [number, number];
    await e.bob.post(`${e.base}/split`, { quantity: 30 });
    await e.order(e.bob, { outcomeId: yes, side: 'sell', price: 0.4, quantity: 10 });
    await e.order(e.bob, { outcomeId: yes, side: 'sell', price: 0.6, quantity: 10 });
    await e.order(e.alice, { outcomeId: yes, side: 'buy', price: 0.6, quantity: 20 });
    expect(await e.position(e.alice, yes)).toMatchObject({ quantity: 20, cost: 10, avgPrice: 0.5 });
    await e.order(e.carol, { outcomeId: yes, side: 'buy', price: 0.7, quantity: 5 });
    await e.order(e.alice, { outcomeId: yes, side: 'sell', price: 0.7, quantity: 5 });
    expect(await e.position(e.alice, yes)).toMatchObject({ quantity: 15, cost: 7.5, avgPrice: 0.5 });
    expect(await e.position(e.bob, no)).toMatchObject({ quantity: 30, cost: 15, avgPrice: 0.5 });

    const portfolio = (await e.alice.get('/portfolio')).body;
    const mine = portfolio.exchangePositions.find((p: any) => p.outcomeId === yes);
    expect(mine).toMatchObject({ quantity: 15, cost: 7.5, avgPrice: 0.5, token: 'yes' });
    expect(mine.value).toBeCloseTo(15 * mine.price, 2);
    expect(mine.pnl).toBeCloseTo(mine.value - 7.5, 2);
    // Book value never follows quotes.
    expect(portfolio.stats.netWorth).toBe(1000);
  });

  it('lists the biggest holders of each share and both sides of every trade', async () => {
    const e = await fixture();
    const [yes, no] = e.ids as [number, number];
    await e.order(e.bob, { outcomeId: no, side: 'buy', price: 0.6, quantity: 8 });
    await e.order(e.alice, { outcomeId: yes, side: 'buy', price: 0.4, quantity: 8 }); // mint
    await e.order(e.alice, { outcomeId: yes, side: 'sell', price: 0.45, quantity: 3 });
    await e.order(e.carol, { outcomeId: yes, side: 'buy', type: 'FAK', amount: 1.35 }); // 3 × 0.45

    const holders = (await e.alice.get(`${e.base}/exchange/holders`)).body;
    expect(holders.map((h: any) => [h.user.username, h.outcomeId, h.quantity, h.avgPrice])).toEqual([
      ['bob', no, 8, 0.6],
      ['alice', yes, 5, 0.4],
      ['carol', yes, 3, 0.45],
    ]);
    const activity = (await e.alice.get(`${e.base}/exchange/activity`)).body;
    expect(activity.map((a: any) => [a.user.username, a.side, a.outcomeId, a.price, a.quantity])).toEqual([
      ['carol', 'buy', yes, 0.45, 3],
      ['alice', 'sell', yes, 0.45, 3],
      ['alice', 'buy', yes, 0.4, 8],
      ['bob', 'buy', no, 0.6, 8],
    ]);
  });
});

describe('multi-outcome Polymarket markets', () => {
  it('gives every option its own Yes/No book, converts No shares and settles exactly', async () => {
    const e = await fixture(['小王', '小李', '小张']);
    const [a, b, c] = e.ids as [number, number, number];
    expect(e.market.isBinary).toBe(false);
    expect(e.market.outcomes.map((o: any) => Math.round(o.probability * 100))).toEqual([33, 33, 33]);
    const books = (await e.state()).books;
    expect(books.map((x: any) => [x.outcomeId, x.token])).toEqual([
      [a, 'yes'],
      [a, 'no'],
      [b, 'yes'],
      [b, 'no'],
      [c, 'yes'],
      [c, 'no'],
    ]);

    expect((await e.alice.post(`${e.base}/split`, { quantity: 10 })).status).toBe(400);
    expect((await e.alice.post(`${e.base}/split`, { quantity: 10, outcomeId: a })).status).toBe(200);
    expect(await e.position(e.alice, a, 'yes')).toMatchObject({ quantity: 10 });
    expect(await e.position(e.alice, a, 'no')).toMatchObject({ quantity: 10 });

    // A No bid on 小李 is a Yes ask on 小李 only; it mints against a Yes buyer of 小李.
    await e.order(e.dave, { outcomeId: b, token: 'no', side: 'buy', price: 0.7, quantity: 10 });
    const ybook = (await e.state()).books.find((x: any) => x.outcomeId === b && x.token === 'yes');
    expect(ybook.asks).toEqual([{ price: 0.3, quantity: 10 }]);
    expect((await e.state()).books.find((x: any) => x.outcomeId === c && x.token === 'yes').asks).toEqual([]);
    const mint = await e.order(e.carol, { outcomeId: b, side: 'buy', type: 'FOK', quantity: 10 });
    expect(mint.body).toMatchObject({ status: 'filled' });
    expect((await e.state()).collateral).toBe(20);
    const listed = (await e.alice.get(e.base)).body.market.outcomes;
    expect(listed[1].probability).toBeCloseTo(0.3, 5);

    await e.order(e.alice, { outcomeId: a, token: 'no', side: 'sell', price: 0.7, quantity: 5 });
    await e.order(e.bob, { outcomeId: a, token: 'no', side: 'buy', type: 'FAK', amount: 3.5 });
    expect(await e.position(e.bob, a, 'no')).toMatchObject({ quantity: 5, avgPrice: 0.7 });

    // One No of 小王 becomes one Yes of 小李 and 小张, with no cash either way.
    expect((await e.alice.post(`${e.base}/convert`, { outcomeIds: [a], quantity: 6 })).status).toBe(400);
    expect((await e.alice.post(`${e.base}/convert`, { outcomeIds: [a], quantity: 5 })).status).toBe(200);
    expect(await e.position(e.alice, a, 'no')).toMatchObject({ quantity: 0 });
    expect(await e.position(e.alice, b, 'yes')).toMatchObject({ quantity: 5 });
    expect(await e.position(e.alice, c, 'yes')).toMatchObject({ quantity: 5 });
    // No of 小王 and 小李 together: one unit of cash plus one Yes of 小张 per unit.
    await e.bob.post(`${e.base}/split`, { quantity: 5, outcomeId: b });
    const before = await e.balance(e.bob);
    expect((await e.bob.post(`${e.base}/convert`, { outcomeIds: [a, b], quantity: 5 })).status).toBe(200);
    expect(await e.balance(e.bob)).toBe(before + 5);
    expect(await e.position(e.bob, c, 'yes')).toMatchObject({ quantity: 5 });

    // Whoever wins, the shares that pay add up to exactly the collateral.
    const pot = Math.round((await e.state()).collateral * 100);
    for (const winner of [a, b, c]) {
      const paid = e.db
        .prepare(
          `SELECT SUM(quantity * CASE WHEN (token = 0 AND outcome_id = @w) OR (token = 1 AND outcome_id <> @w)
            THEN 100 ELSE 0 END) AS n FROM exchange_positions WHERE market_id = @m`,
        )
        .get({ w: winner, m: e.id }) as { n: number };
      expect(paid.n).toBe(pot);
    }

    e.clock.now += 2 * DAY;
    const balances = await Promise.all([e.alice, e.bob, e.carol, e.dave].map((x) => e.balance(x)));
    expect((await e.alice.post(`${e.base}/resolve`, { outcomeId: c })).status).toBe(200);
    const after = await Promise.all([e.alice, e.bob, e.carol, e.dave].map((x) => e.balance(x)));
    // alice: 小王 Yes 10 lose, 小李 Yes 5 lose, 小张 Yes 5 win. bob: 小张 Yes 5. dave: 小李 No 10.
    expect(after.map((x, i) => Math.round((x - balances[i]!) * 100) / 100)).toEqual([5, 5, 0, 10]);
    expect((await e.state()).collateral).toBe(0);
    const portfolio = (await e.dave.get('/portfolio')).body.exchangePositions;
    expect(portfolio[0]).toMatchObject({ outcomeLabel: '小李 · No', price: 1, value: 10 });
  });

  it('only accepts Yes / No for two options and leaves pool markets alone', async () => {
    const e = await fixture();
    const create = (mode: string, outcomes: string[]) =>
      e.alice.post('/markets', {
        question: '下周团建去哪里？',
        category: '生活',
        mode,
        outcomes,
        closeAt: e.clock.now + DAY,
      });
    expect((await create('polymarket', ['爬山', '唱歌'])).status).toBe(400);
    const pool = await create('pool', ['爬山', '唱歌', '吃饭']);
    expect(pool.status).toBe(201);
    expect(e.db.prepare('SELECT neg_risk FROM markets WHERE id = ?').get(pool.body.id)).toEqual({ neg_risk: 0 });
    expect((await e.alice.get(`/markets/${pool.body.id}/exchange`)).status).toBe(400);
  });
});

describe('WeCom Polymarket tools', () => {
  it('quotes orders on a confirmation card, bounds slippage and fills only when confirmed', async () => {
    const e = await fixture(['小王', '小李', '小张']);
    const [a] = e.ids as [number];
    const userId = (name: string) =>
      (e.db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number }).id;
    const ctx = (name: string): ToolContext => ({
      db: e.db,
      config: e.config,
      now: e.clock.now,
      siteUrl: 'https://example.invalid',
      userId: userId(name),
      wecomUserId: `wc-${name}`,
      card: null,
    });
    const latest = () => e.db.prepare('SELECT * FROM wecom_actions ORDER BY id DESC').get() as ActionRow;
    await e.bob.post(`${e.base}/split`, { quantity: 20, outcomeId: a });
    await e.order(e.bob, { outcomeId: a, side: 'sell', price: 0.3, quantity: 5 });
    await e.order(e.bob, { outcomeId: a, side: 'sell', price: 0.4, quantity: 10 });

    const book = JSON.parse(runTool(ctx('alice'), 'get_order_book', { marketId: e.id, outcome: '小王' }).content);
    expect(book).toMatchObject({
      share: '小王 · Yes',
      asks: [
        { price: 0.3, quantity: 5 },
        { price: 0.4, quantity: 10 },
      ],
    });
    expect(runTool(ctx('alice'), 'place_bet', { marketId: e.id, outcome: '小王', amount: 5 }).isError).toBe(true);

    const buy = ctx('alice');
    const quoted = runTool(buy, 'place_order', {
      marketId: e.id,
      outcome: '小王',
      side: 'buy',
      orderType: 'market',
      amount: 3.5,
    });
    expect(quoted.isError).toBe(false);
    expect(JSON.stringify(buy.card)).toContain('10 份，均价 0.35');
    expect(await e.balance()).toBe(1000);
    // The card's order never fills above the previewed worst price.
    expect(JSON.parse(latest().payload).input).toMatchObject({ type: 'FAK', amount: 3.5, price: 0.4 });
    expect(executeAction(e.db, latest(), e.clock.now).detail).toBe('全部成交 10 份，均价 0.35');
    expect(await e.balance()).toBe(996.5);

    runTool(ctx('alice'), 'place_order', {
      marketId: e.id,
      outcome: '小李',
      share: 'no',
      side: 'buy',
      orderType: 'limit',
      price: 0.6,
      shares: 5,
    });
    expect(executeAction(e.db, latest(), e.clock.now).detail).toBe('已挂单，等待成交');
    expect(await e.balance()).toBe(993.5);
    const resting = e.db
      .prepare(`SELECT id FROM exchange_orders WHERE user_id = ? AND status = 'open'`)
      .get(userId('alice')) as { id: number };
    expect(runTool(ctx('bob'), 'cancel_order', { orderId: resting.id }).isError).toBe(true);
    expect(runTool(ctx('alice'), 'cancel_order', { orderId: resting.id }).isError).toBe(false);
    executeAction(e.db, latest(), e.clock.now);
    expect(await e.balance()).toBe(996.5);
    const oversell = runTool(ctx('alice'), 'place_order', {
      marketId: e.id,
      outcome: '小王',
      side: 'sell',
      orderType: 'market',
      shares: 11,
    });
    expect(oversell).toMatchObject({ isError: true });
    expect(oversell.content).toContain('只有 10 份');

    const create = ctx('carol');
    runTool(create, 'create_market', {
      question: '年会抽奖谁中一等奖？',
      category: '公司',
      closeAt: new Date(e.clock.now + DAY).toISOString(),
      mode: 'polymarket',
      outcomes: ['甲', '乙', '丙'],
    });
    const created = executeAction(e.db, latest(), e.clock.now).marketId;
    expect(e.db.prepare('SELECT mode, neg_risk FROM markets WHERE id = ?').get(created)).toEqual({
      mode: 'polymarket',
      neg_risk: 1,
    });

    // Winners of 小张: holders of 小张 Yes and of every other option's No (bob's 小王 No).
    e.clock.now += 2 * DAY;
    const resolve = ctx('alice');
    runTool(resolve, 'resolve_market', { marketId: e.id, outcome: '小张' });
    expect(resolve.card?.horizontal_content_list).toContainEqual({ keyname: '获胜持有人', value: '1' });
  });
});
