import { describe, expect, it } from 'vitest';
import { normalizeBasePath } from '../src/config';
import { setup } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Env = ReturnType<typeof setup>;
type Client = Awaited<ReturnType<Env['register']>>;

async function makeMarket(env: Env, c: Client, outcomes = ['是', '否']) {
  const res = await c.post('/markets', {
    question: '周五团建会下雨吗？',
    description: '以气象局为准',
    category: '生活',
    closeAt: env.clock.now + 2 * DAY,
    outcomes,
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe('auth', () => {
  it('registers, logs in and out', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const me = await alice.get('/auth/me');
    expect(me.body.user).toMatchObject({ username: 'alice', balance: 1000, canClaimBonus: true });
    expect(me.body.user).not.toHaveProperty('role');

    const bob = await env.register('bob');

    expect((await bob.post('/auth/logout')).status).toBe(200);
    expect((await bob.get('/auth/me')).body.user).toBeNull();

    const bad = await bob.post('/auth/login', { username: 'bob', password: 'wrong' });
    expect(bad.status).toBe(401);
    const good = await bob.post('/auth/login', { username: 'BOB', password: 'secret123' });
    expect(good.status).toBe(200);
    expect((await bob.get('/auth/me')).body.user.username).toBe('bob');
  });

  it('rejects duplicate usernames case-insensitively and enforces invite codes', async () => {
    const env = setup({ inviteCode: 'water' });
    const c = env.client();
    expect(
      (await c.post('/auth/register', { username: 'amy', displayName: 'Amy', password: 'secret123' })).status,
    ).toBe(403);
    expect(
      (
        await c.post('/auth/register', {
          username: 'amy',
          displayName: 'Amy',
          password: 'secret123',
          inviteCode: 'water',
        })
      ).status,
    ).toBe(201);
    const dup = await env
      .client()
      .post('/auth/register', { username: 'AMY', displayName: 'Amy2', password: 'secret123', inviteCode: 'water' });
    expect(dup.status).toBe(409);
  });

  it('requires JSON for mutations (CSRF guard) and auth for betting', async () => {
    const env = setup();
    const res = await env.app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    });
    expect(res.status).toBe(415);
    const anon = env.client();
    expect((await anon.post('/markets/1/bets', { outcomeId: 1, amount: 10 })).status).toBe(401);
  });

  it('private mode hides everything from anonymous visitors', async () => {
    const env = setup({ privateMode: true });
    const anon = env.client();
    expect((await anon.get('/markets')).status).toBe(401);
    expect((await anon.get('/leaderboard')).status).toBe(401);
    expect((await anon.get('/config')).body.privateMode).toBe(true);
    expect((await anon.get('/auth/me')).body.user).toBeNull();
    const alice = await env.register('alice');
    expect((await alice.get('/markets')).status).toBe(200);
  });

  it('scopes the session cookie to BASE_PATH', async () => {
    const register = (env: ReturnType<typeof setup>) =>
      env.app.request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'amy', displayName: 'Amy', password: 'secret123' }),
      });
    const sub = await register(setup({ basePath: normalizeBasePath('/watercooler/') }));
    expect(sub.headers.get('set-cookie')).toContain('Path=/watercooler;');
    const root = await register(setup());
    expect(root.headers.get('set-cookie')).toContain('Path=/;');
  });

  it('daily bonus can be claimed once per day', async () => {
    const env = setup();
    const c = await env.register('alice');
    expect((await c.post('/me/bonus')).body.balance).toBe(1100);
    expect((await c.post('/me/bonus')).status).toBe(409);
    env.clock.now += DAY;
    expect((await c.post('/me/bonus')).body.balance).toBe(1200);
  });
});

const outcomeIds = async (c: Client, id: number) =>
  (await c.get(`/markets/${id}`)).body.market.outcomes.map((o: any) => o.id) as number[];
const balance = async (c: Client) => (await c.get('/auth/me')).body.user.balance as number;

/** Every cent ever handed out is either in someone's balance or staked in an unsettled market. */
function expectMoneyConserved(env: Env) {
  const { held } = env.db
    .prepare(
      `SELECT (SELECT SUM(balance) FROM users)
            + (SELECT COALESCE(SUM(pot), 0) FROM markets WHERE status = 'open') AS held`,
    )
    .get() as { held: number };
  const { funded } = env.db
    .prepare(`SELECT SUM(amount) AS funded FROM ledger WHERE kind IN ('signup', 'bonus')`)
    .get() as { funded: number };
  expect(held).toBe(funded);
}

describe('betting', () => {
  it('stakes go into pools and the pot shares are the odds', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const bob = await env.register('bob');
    const carol = await env.register('carol');
    const id = await makeMarket(env, alice);
    const [yes, no] = await outcomeIds(bob, id);

    const fresh = (await bob.get(`/markets/${id}`)).body.market;
    expect(fresh.outcomes.map((o: any) => o.probability)).toEqual([0.5, 0.5]);
    expect(fresh.pot).toBe(0);

    const b1 = await bob.post(`/markets/${id}/bets`, { outcomeId: yes, amount: 200 });
    expect(b1.status).toBe(200);
    expect(b1.body.balance).toBe(800);
    expect(b1.body.stakes).toEqual([{ outcomeId: yes, amount: 200 }]);
    await bob.post(`/markets/${id}/bets`, { outcomeId: yes, amount: 100 });
    const c1 = await carol.post(`/markets/${id}/bets`, { outcomeId: no, amount: 100 });
    expect(c1.body.market.pot).toBe(400);
    expect(c1.body.market.outcomes.map((o: any) => [o.pool, o.probability])).toEqual([
      [300, 0.75],
      [100, 0.25],
    ]);
    expect(c1.body.market.bettorCount).toBe(2);
    expect((await bob.get(`/markets/${id}`)).body.stakes).toEqual([{ outcomeId: yes, amount: 300 }]);

    expect((await carol.post(`/markets/${id}/bets`, { outcomeId: no, amount: 5000 })).status).toBe(400);
    expect((await carol.post(`/markets/${id}/bets`, { outcomeId: no, amount: 0.5 })).status).toBe(400);
    expect(await balance(carol)).toBe(900);
    expectMoneyConserved(env);
  });

  it('the creator announces the result and the winners split the whole pot', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const bob = await env.register('bob');
    const carol = await env.register('carol');
    const dave = await env.register('dave');
    const id = await makeMarket(env, alice, ['A', 'B', 'C']);
    const [a, b] = await outcomeIds(bob, id);

    await bob.post(`/markets/${id}/bets`, { outcomeId: a, amount: 200 });
    await carol.post(`/markets/${id}/bets`, { outcomeId: a, amount: 100 });
    await dave.post(`/markets/${id}/bets`, { outcomeId: b, amount: 300 });

    expect((await bob.post(`/markets/${id}/resolve`, { outcomeId: a })).status).toBe(403);
    env.clock.now += 2 * DAY;
    const resolved = await alice.post(`/markets/${id}/resolve`, { outcomeId: a, note: 'A 赢了' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('resolved');
    expect(resolved.body.outcomes.map((o: any) => o.probability)).toEqual([1, 0, 0]);
    expect(resolved.body.resolutionNote).toBe('A 赢了');

    // Pot of 600 split 2:1 between bob and carol.
    expect(await balance(bob)).toBe(1200);
    expect(await balance(carol)).toBe(1100);
    expect(await balance(dave)).toBe(700);
    expect(await balance(alice)).toBe(1000);
    expectMoneyConserved(env);

    const portfolio = (await bob.get('/portfolio')).body;
    expect(portfolio.bets[0]).toMatchObject({ state: 'won', stake: 200, payout: 400, pnl: 200 });
    expect(portfolio.stats).toMatchObject({ balance: 1200, staked: 0, profit: 200 });
    expect((await dave.get('/portfolio')).body.bets[0]).toMatchObject({ state: 'lost', payout: 0, pnl: -300 });

    const board = (await bob.get('/leaderboard')).body;
    expect(board.map((e: any) => e.user.username)).toEqual(['bob', 'carol', 'alice', 'dave']);

    expect((await alice.post(`/markets/${id}/resolve`, { outcomeId: b })).status).toBe(409);
    expect((await alice.post(`/markets/${id}/cancel`, {})).status).toBe(409);
    expect((await bob.post(`/markets/${id}/bets`, { outcomeId: a, amount: 10 })).status).toBe(409);
  });

  it('lets the creator bet in their own market', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const bob = await env.register('bob');
    const id = await makeMarket(env, alice);
    const [yes, no] = await outcomeIds(alice, id);
    expect((await alice.post(`/markets/${id}/bets`, { outcomeId: yes, amount: 100 })).status).toBe(200);
    await bob.post(`/markets/${id}/bets`, { outcomeId: no, amount: 100 });
    env.clock.now += 2 * DAY;
    await alice.post(`/markets/${id}/resolve`, { outcomeId: yes });
    expect(await balance(alice)).toBe(1100);
    expect(await balance(bob)).toBe(900);
    expectMoneyConserved(env);
  });

  it('splits odd pots to the exact cent', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const players = await Promise.all(['b', 'c', 'd', 'e'].map((n) => env.register(`user_${n}`)));
    const id = await makeMarket(env, alice);
    const [yes, no] = await outcomeIds(alice, id);
    for (const p of players.slice(0, 3)) await p.post(`/markets/${id}/bets`, { outcomeId: yes, amount: 1 });
    await players[3]!.post(`/markets/${id}/bets`, { outcomeId: no, amount: 7.01 });
    env.clock.now += 2 * DAY;
    await alice.post(`/markets/${id}/resolve`, { outcomeId: yes });
    // 10.01 split three ways: 3.34 + 3.34 + 3.33
    const won = (await Promise.all(players.slice(0, 3).map(balance))).map((x) => Math.round((x - 999) * 100));
    expect(won.sort()).toEqual([333, 334, 334]);
    expectMoneyConserved(env);
  });

  it('refunds everyone when nobody backed the winner or the creator cancels', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const bob = await env.register('bob');
    const first = await makeMarket(env, alice);
    const [yes, no] = await outcomeIds(bob, first);
    await bob.post(`/markets/${first}/bets`, { outcomeId: yes, amount: 100 });
    env.clock.now += 2 * DAY;
    await alice.post(`/markets/${first}/resolve`, { outcomeId: no });
    expect(await balance(bob)).toBe(1000);
    expect((await bob.get('/portfolio')).body.bets[0]).toMatchObject({ state: 'refunded', payout: 100, pnl: 0 });

    const second = await makeMarket(env, alice);
    const [yes2] = await outcomeIds(bob, second);
    await bob.post(`/markets/${second}/bets`, { outcomeId: yes2, amount: 250 });
    expect((await bob.post(`/markets/${second}/cancel`, {})).status).toBe(403);
    const cancelled = await alice.post(`/markets/${second}/cancel`, { note: '题目有歧义' });
    expect(cancelled.body.status).toBe('cancelled');
    expect(await balance(bob)).toBe(1000);
    const ledger = (await bob.get('/portfolio/ledger')).body;
    expect(ledger.map((l: any) => l.kind)).toEqual(['refund', 'bet', 'refund', 'bet', 'signup']);
    expectMoneyConserved(env);
  });

  it('stops betting at close and refunds overdue pool markets exactly once', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const bob = await env.register('bob');
    const id = await makeMarket(env, alice);
    const [yes] = await outcomeIds(bob, id);
    await bob.post(`/markets/${id}/bets`, { outcomeId: yes, amount: 100 });

    env.clock.now += 3 * DAY;
    const closed = (await bob.get(`/markets/${id}`)).body.market;
    expect(closed.status).toBe('closed');
    expect(closed.resolveBy).toBe(closed.settleAt + 7 * DAY);
    expect((await bob.post(`/markets/${id}/bets`, { outcomeId: yes, amount: 10 })).status).toBe(409);
    expect(await balance(bob)).toBe(900);

    env.clock.now = closed.settleAt + 8 * DAY;
    const after = (await bob.get(`/markets/${id}`)).body.market;
    expect(after.status).toBe('cancelled');
    expect(after.resolvedAt).toBe(closed.resolveBy);
    expect((await alice.post(`/markets/${id}/resolve`, { outcomeId: yes })).status).toBe(409);
    expect(await balance(bob)).toBe(1000);
    expectMoneyConserved(env);
  });

  it('history, holders, comments and activity endpoints work', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const bob = await env.register('bob');
    const id = await makeMarket(env, alice);
    const [yes] = await outcomeIds(bob, id);
    env.clock.now += HOUR;
    await bob.post(`/markets/${id}/bets`, { outcomeId: yes, amount: 50 });
    env.clock.now += HOUR;

    const history = (await bob.get(`/markets/${id}/history?range=all`)).body;
    expect(history.map((p: any) => p.probs)).toEqual([
      [0.5, 0.5],
      [1, 0],
      [1, 0],
    ]);
    expect(history[2].t).toBe(env.clock.now);

    expect((await bob.get(`/markets/${id}/holders`)).body).toMatchObject([{ outcomeId: yes, amount: 50 }]);
    expect((await bob.get(`/markets/${id}/bets`)).body).toMatchObject([{ amount: 50, outcomeLabel: '是' }]);

    const comment = await bob.post(`/markets/${id}/comments`, { body: '我觉得会下雨' });
    expect(comment.status).toBe(201);
    expect((await bob.get(`/markets/${id}/comments`)).body[0].body).toBe('我觉得会下雨');
    expect((await alice.del(`/comments/${comment.body.id}`)).status).toBe(403);
    expect((await bob.del(`/comments/${comment.body.id}`)).status).toBe(200);

    const activity = (await env.client().get('/activity')).body;
    expect(activity[0]).toMatchObject({ amount: 50, outcomeLabel: '是' });

    const list = (await env.client().get('/markets?sort=pot')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pot: 50, bettorCount: 1 });

    const stats = (await env.client().get('/stats')).body;
    expect(stats).toMatchObject({ openMarkets: 1, totalStaked: 50, bettors: 1, users: 2 });

    const profile = (await env.client().get(`/users/${list[0].creator.id}`)).body;
    expect(profile.createdMarkets).toHaveLength(1);
  });

  it('validates market creation and keeps admin endpoints from ordinary users', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const base = { question: '这是一个问题吗？', category: '其他', closeAt: env.clock.now + DAY };
    expect((await alice.post('/markets', { ...base, outcomes: ['是'] })).status).toBe(400);
    expect((await alice.post('/markets', { ...base, outcomes: ['是', '是'] })).status).toBe(400);
    expect((await alice.post('/markets', { ...base, closeAt: env.clock.now, outcomes: ['是', '否'] })).status).toBe(
      400,
    );
    expect((await alice.post('/markets', { ...base, outcomes: ['是', '否'] })).status).toBe(201);
    expect((await env.client().get('/admin/users')).status).toBe(401);
    expect((await alice.get('/admin/users')).status).toBe(403);
    expect((await alice.post('/admin/balance', { username: 'alice', amount: 100, reason: '自己加钱' })).status).toBe(
      403,
    );
  });
});
