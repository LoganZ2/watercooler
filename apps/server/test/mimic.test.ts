import { afterEach, describe, expect, it } from 'vitest';
import { parseEvent, type PolymarketEvent, type PolymarketMarket } from '../src/mimic/client';
import { syncMimic } from '../src/mimic/sync';
import { executeMirrorAction, type ActionRow } from '../src/wecom/actions';
import { runTool, type ToolContext } from '../src/wecom/tools';
import { leaderboard } from '../src/services/stats';
import { toLevels } from '../src/services/mimic';
import { fakePolymarket, setup } from './helpers';

const environments: ReturnType<typeof setup>[] = [];
afterEach(() => {
  for (const e of environments.splice(0)) e.db.close();
});

function pm(id: string, yes: number, over: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    id,
    question: `Will ${id} happen?`,
    groupItemTitle: id,
    outcomes: ['Yes', 'No'],
    outcomePrices: [yes, Math.round((1 - yes) * 1000) / 1000],
    tokens: [`${id}-yes`, `${id}-no`],
    bestBid: yes - 0.01,
    bestAsk: yes + 0.01,
    closed: false,
    acceptingOrders: true,
    resolved: false,
    ...over,
  };
}

const resolved = (m: PolymarketMarket, yesWins: boolean): PolymarketMarket => ({
  ...m,
  outcomePrices: yesWins ? [1, 0] : [0, 1],
  closed: true,
  acceptingOrders: false,
  resolved: true,
});

async function fixture() {
  const end = Date.UTC(2026, 1, 1);
  const binary: PolymarketEvent = {
    id: 'e1',
    slug: 'rain-in-la',
    title: 'Will it rain in LA tomorrow?',
    description: 'Resolves Yes if…',
    endDate: end,
    volume24hr: 900_000,
    tags: ['weather'],
    markets: [pm('m1', 0.62, { groupItemTitle: null, outcomes: ['Yes', 'No'] })],
  };
  const multi: PolymarketEvent = {
    id: 'e2',
    slug: 'nba-champion',
    title: 'NBA Champion 2027',
    description: '',
    endDate: end,
    volume24hr: 2_000_000,
    tags: ['sports', 'nba'],
    markets: [
      pm('lakers', 0.3),
      pm('celtics', 0.5),
      pm('knicks', 0.15),
      pm('jazz', 0.01, { closed: true, acceptingOrders: false }),
    ],
  };
  const tiny: PolymarketEvent = {
    ...multi,
    id: 'e3',
    slug: 'tiny',
    title: 'Only one open market',
    markets: [pm('x', 0.5), pm('y', 0.1, { closed: true, acceptingOrders: false })],
  };
  const fake = fakePolymarket([multi, binary, tiny]);
  const env = setup({}, () => ({ polymarket: fake.client }));
  environments.push(env);
  const alice = await env.register('alice');
  const bob = await env.register('bob');
  const sync = (enabled = true) => syncMimic(env.db, fake.client, () => env.clock.now, enabled);
  return { ...env, fake, binary, multi, alice, bob, sync };
}

describe('Polymarket mirror', () => {
  it('copies the busiest events as mirrors, in Polymarket order, outside the people’s market list', async () => {
    const e = await fixture();
    expect(await e.sync()).toEqual({ listed: 2, refreshed: 0, settled: 0 });
    const mirrors = (await e.alice.get('/markets?zone=mimic')).body;
    expect(mirrors.map((m: any) => [m.question, m.mimic.rank, m.mode])).toEqual([
      ['NBA Champion 2027', 1, 'polymarket'],
      ['Will it rain in LA tomorrow?', 2, 'polymarket'],
    ]);
    const [nba, rain] = mirrors;
    expect(nba.category).toBe('体育');
    expect(nba.isBinary).toBe(false);
    // Open options only, likeliest first; Polymarket's prices and best quotes.
    expect(nba.outcomes.map((o: any) => [o.label, o.probability, o.bestBid, o.bestAsk])).toEqual([
      ['celtics', 0.5, 0.49, 0.51],
      ['lakers', 0.3, 0.29, 0.31],
      ['knicks', 0.15, 0.14, 0.16],
    ]);
    expect(rain.outcomes.map((o: any) => [o.label, o.bestBid, o.bestAsk])).toEqual([
      ['Yes', 0.61, 0.63],
      ['No', 0.37, 0.39],
    ]);
    expect(rain.mimic.url).toBe('https://polymarket.com/event/rain-in-la');
    expect((await e.alice.get('/markets')).body).toEqual([]);
    // The mirror's account is a bot that is neither an AI bot nor anyone's rival.
    expect(nba.creator.displayName).toBe('Polymarket');
    expect(leaderboard(e.db, 'profit', true)).toEqual([]);

    // Dropping out of the top K unlists a mirror but keeps it; a second pass reuses the rows.
    e.fake.state.top = [e.binary];
    expect(await e.sync()).toMatchObject({ listed: 1 });
    expect((await e.alice.get('/markets?zone=mimic')).body.map((m: any) => m.id)).toEqual([rain.id]);
    expect((await e.alice.get(`/markets/${nba.id}`)).body.market.mimic.rank).toBeNull();
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM markets').get()).toEqual({ n: 2 });
  });

  it('trades at Polymarket’s live book with the site as counterparty, never moving it', async () => {
    const e = await fixture();
    await e.sync();
    const rain = (await e.alice.get('/markets?zone=mimic')).body[1];
    const [yes, no] = rain.outcomes.map((o: any) => o.id);
    e.fake.state.books.set('m1-yes', {
      asks: [
        { price: 0.63, size: 10.5 },
        { price: 0.635, size: 20 },
      ],
      bids: [{ price: 0.605, size: 15.7 }],
    });
    e.fake.state.books.set('m1-no', { asks: [{ price: 0.4, size: 100 }], bids: [] });
    const order = (c: typeof e.alice, body: object) => c.post(`/markets/${rain.id}/mimic/order`, body);

    // 10 at 0.63, then 0.635 rounds up to 0.64: 3.70 buys 5 more.
    const bought = await order(e.alice, { outcomeId: yes, side: 'buy', amount: 10 });
    expect(bought.status).toBe(201);
    expect(bought.body).toMatchObject({ quantity: 15, total: 9.5, label: 'Yes', balance: 990.5 });
    const again = await order(e.bob, { outcomeId: yes, side: 'buy', amount: 10 });
    expect(again.body).toMatchObject({ quantity: 15, total: 9.5 });

    const sold = await order(e.alice, { outcomeId: yes, side: 'sell', quantity: 5 });
    expect(sold.body).toMatchObject({ quantity: 5, total: 3, avgPrice: 0.6, balance: 993.5 });
    expect((await order(e.alice, { outcomeId: yes, side: 'sell', quantity: 11 })).status).toBe(400);
    expect((await order(e.alice, { outcomeId: yes, side: 'buy', type: 'FOK', amount: 1000 })).status).toBe(409);
    // "No" on the Yes option is the No outcome of a binary mirror.
    expect((await order(e.alice, { outcomeId: yes, token: 'no', side: 'buy', quantity: 5 })).body).toMatchObject({
      label: 'No',
      total: 2,
    });

    const state = (await e.alice.get(`/markets/${rain.id}/exchange`)).body;
    expect(state.books.map((b: any) => [b.outcomeId, b.asks[0]?.price])).toEqual([
      [yes, 0.63],
      [no, 0.4],
    ]);
    expect(state.books[0].bids).toEqual([{ price: 0.6, quantity: 15 }]);
    expect(state.positions).toEqual([
      expect.objectContaining({ outcomeId: yes, quantity: 10, avgPrice: 0.63 }),
      expect.objectContaining({ outcomeId: no, quantity: 5, avgPrice: 0.4 }),
    ]);
    expect(state.orders.map((o: any) => [o.side, o.quantity, o.status])).toEqual([
      ['buy', 5, 'filled'],
      ['sell', 5, 'filled'],
      ['buy', 15, 'filled'],
    ]);
    const activity = (await e.alice.get(`/markets/${rain.id}/exchange/activity`)).body;
    expect(activity.map((a: any) => [a.user.username, a.side, a.quantity])).toEqual([
      ['alice', 'buy', 5],
      ['alice', 'sell', 5],
      ['bob', 'buy', 15],
      ['alice', 'buy', 15],
    ]);
    expect((await e.alice.get('/portfolio/ledger')).body.slice(0, 2).map((l: any) => l.kind)).toEqual(['buy', 'sell']);
    // Mirrors never take resting orders, splits or the pool tools.
    expect(
      (await e.alice.post(`/markets/${rain.id}/orders`, { outcomeId: yes, side: 'buy', price: 0.5, quantity: 1 }))
        .status,
    ).toBe(400);
    expect((await e.alice.post(`/markets/${rain.id}/split`, { quantity: 1 })).status).toBe(400);

    e.fake.state.fail = true;
    expect((await order(e.alice, { outcomeId: yes, side: 'buy', amount: 1 })).status).toBe(502);
  });

  it('settles each option at Polymarket’s result, even after the mirror is switched off', async () => {
    const e = await fixture();
    await e.sync();
    const nba = (await e.alice.get('/markets?zone=mimic')).body[0];
    const [celtics, lakers] = nba.outcomes.map((o: any) => o.id);
    e.fake.state.books.set('celtics-yes', { asks: [{ price: 0.5, size: 100 }], bids: [] });
    e.fake.state.books.set('lakers-no', { asks: [{ price: 0.7, size: 100 }], bids: [] });
    await e.alice.post(`/markets/${nba.id}/mimic/order`, { outcomeId: celtics, side: 'buy', quantity: 20 });
    await e.bob.post(`/markets/${nba.id}/mimic/order`, { outcomeId: lakers, token: 'no', side: 'buy', quantity: 10 });
    expect([
      (await e.alice.get('/auth/me')).body.user.balance,
      (await e.bob.get('/auth/me')).body.user.balance,
    ]).toEqual([990, 993]);

    // Switched off, a pass only follows mirrors people hold, and still settles them.
    e.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('feature.mimic', 'off', 0)`).run();
    expect(
      (await e.alice.post(`/markets/${nba.id}/mimic/order`, { outcomeId: celtics, side: 'buy', quantity: 1 })).status,
    ).toBe(403);
    const [lak, cel, kni] = e.multi.markets;
    e.fake.state.top = [];
    e.fake.state.events.set('e2', { ...e.multi, markets: [resolved(lak!, false), cel!, kni!, e.multi.markets[3]!] });
    expect(await e.sync(false)).toEqual({ listed: 0, refreshed: 1, settled: 1 });
    expect((await e.bob.get('/auth/me')).body.user.balance).toBe(1003);
    expect((await e.alice.get(`/markets/${nba.id}`)).body.market.status).toBe('open');

    e.fake.state.events.set('e2', {
      ...e.multi,
      markets: [resolved(lak!, false), resolved(cel!, true), resolved(kni!, false), e.multi.markets[3]!],
    });
    expect(await e.sync(false)).toMatchObject({ settled: 2 });
    expect((await e.alice.get('/auth/me')).body.user.balance).toBe(1010);
    const done = (await e.alice.get(`/markets/${nba.id}`)).body.market;
    expect(done).toMatchObject({ status: 'resolved', resolvedOutcomeId: celtics });
    const portfolio = (await e.alice.get('/portfolio')).body;
    expect(portfolio.stats.profit).toBe(10);
    expect(portfolio.exchangePositions[0]).toMatchObject({ outcomeLabel: 'celtics · Yes', value: 20, pnl: 10 });
  });

  it('needs Polymarket mode on, is on by default and reports its sync in the admin console', async () => {
    const e = await fixture();
    expect((await e.alice.get('/config')).body.mimic).toBe(true);
    e.db.prepare(`UPDATE users SET is_admin = 1 WHERE username = 'alice'`).run();
    expect((await e.alice.post('/admin/features', { key: 'polymarket', enabled: false })).status).toBe(200);
    expect((await e.alice.get('/config')).body.mimic).toBe(false);
    expect((await e.alice.post('/admin/features', { key: 'mimic', enabled: true })).status).toBe(409);
    expect((await e.alice.post('/admin/mimic', { topK: 0 })).status).toBe(400);
    expect((await e.alice.post('/admin/mimic', { topK: 20 })).body.mimicTopK).toBe(20);
    expect((await e.alice.get('/admin/audit')).body[0].detail).toContain('前 20 个');
  });
});

describe('Polymarket mirror on WeCom', () => {
  it('lists mirrors, quotes the last sync on a card and fills at the live book when confirmed', async () => {
    const e = await fixture();
    await e.sync();
    const userId = (e.db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get() as { id: number }).id;
    const ctx = (): ToolContext => ({
      db: e.db,
      config: e.config,
      now: e.clock.now,
      siteUrl: 'https://example.invalid',
      userId,
      wecomUserId: 'wc-alice',
      card: null,
    });
    const listed = JSON.parse(runTool(ctx(), 'list_markets', { zone: 'mimic' }).content);
    expect(listed.map((m: any) => m.question)).toEqual(['NBA Champion 2027', 'Will it rain in LA tomorrow?']);
    const nba = listed[0].id;
    const detail = JSON.parse(runTool(ctx(), 'get_market', { marketId: nba }).content);
    expect(detail.quotes.slice(0, 2)).toEqual([
      { share: 'celtics · Yes', bestBid: 0.49, bestAsk: 0.51, trading: true },
      { share: 'celtics · No', bestBid: 0.49, bestAsk: 0.51, trading: true },
    ]);
    expect(
      runTool(ctx(), 'place_order', {
        marketId: nba,
        outcome: 'celtics',
        side: 'buy',
        orderType: 'limit',
        price: 0.5,
        shares: 5,
      }).isError,
    ).toBe(true);

    const card = ctx();
    const quoted = runTool(card, 'place_order', {
      marketId: nba,
      outcome: 'lakers',
      share: 'no',
      side: 'buy',
      orderType: 'market',
      amount: 7,
    });
    expect(quoted.isError).toBe(false);
    const action = e.db.prepare('SELECT * FROM wecom_actions ORDER BY id DESC').get() as ActionRow;
    expect(action.kind).toBe('mimic_order');
    // Reference: 1 − 0.29 = 0.71; never more than two cents above it.
    expect(JSON.parse(action.payload).input).toMatchObject({ token: 'no', amount: 7, price: 0.73 });
    expect(JSON.stringify(card.card)).toContain('约 9 份');

    e.fake.state.books.set('lakers-no', {
      asks: [
        { price: 0.72, size: 5 },
        { price: 0.75, size: 50 },
      ],
      bids: [],
    });
    const done = await executeMirrorAction(e.db, e.fake.client, action, () => e.clock.now);
    expect(done.detail).toBe('买入 5 份，均价 0.720，花了 3.6');
    await expect(executeMirrorAction(e.db, e.fake.client, action, () => e.clock.now)).rejects.toThrow('已经处理过');
  });
});

describe('Polymarket data', () => {
  it('parses Gamma events and rounds books against the trader', () => {
    const event = parseEvent({
      id: 7,
      slug: 's',
      title: 'T',
      endDate: '2027-01-01T00:00:00Z',
      volume24hr: '12.5',
      tags: [{ slug: 'crypto' }],
      markets: [
        {
          id: 8,
          outcomes: '["Up", "Down"]',
          outcomePrices: '["1", "0"]',
          clobTokenIds: '["a", "b"]',
          closed: true,
          acceptingOrders: false,
        },
        { id: 9, outcomes: '["Yes"]', outcomePrices: '["1"]', clobTokenIds: '["c"]' },
      ],
    })!;
    expect(event).toMatchObject({ id: '7', volume24hr: 12.5, tags: ['crypto'], endDate: Date.UTC(2027, 0, 1) });
    expect(event.markets).toEqual([
      expect.objectContaining({
        id: '8',
        outcomes: ['Up', 'Down'],
        tokens: ['a', 'b'],
        resolved: true,
        acceptingOrders: false,
      }),
    ]);
    expect(
      toLevels({
        bids: [
          { price: 0.455, size: 3.9 },
          { price: 0.451, size: 2.2 },
          { price: 0.004, size: 100 },
        ],
        asks: [
          { price: 0.461, size: 0.5 },
          { price: 0.995, size: 10 },
        ],
      }),
    ).toEqual({ bids: [{ price: 0.45, quantity: 6 }], asks: [] });
  });
});
